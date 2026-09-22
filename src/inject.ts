/**
 * Scheduled template auto-injection (host half): re-surfaces inject-enabled
 * templates into the model context on turn boundaries. The single sanctioned
 * mutation point is the `agent/pre-step` waterfall — its enter decision can
 * append user-role messages, which the loop then logs as durable
 * `user/message` events, keeping the model-visible input replayable. The
 * `<system-reminder>` frame and typed source mirror the tool-skill catalog
 * precedent.
 *
 * Trigger semantics: a template injects at the FIRST admitted step of every
 * boundary turn (`turn % inject_every === 0`, turns are 1-based and durable).
 * Idempotence is anchored on the durable log — a boundary turn that already
 * carries a `prompt-template-schedule` message is never injected twice —
 * while a per-session in-memory memo keeps the common step free of scans.
 *
 * @module dsh-prompt-templates/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { TemplateStore } from './store.ts'
import type { TemplateView } from './types.ts'

/**
 * Durable provenance for one scheduled injection, recorded beside the
 * model-facing prose so non-model consumers (audit, replay) never re-parse
 * the `<system-reminder>` framing.
 */
export interface TemplateScheduleSource {
  readonly kind: 'prompt-template-schedule'
  /** The boundary turn this message belongs to. */
  readonly turn: number
  /** Exactly the templates this message injected, in injection order. */
  readonly templates: readonly { readonly id: string, readonly name: string, readonly every: number }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prompt-template-schedule': TemplateScheduleSource
  }
}

/** One inject-enabled template due at a boundary turn. */
export interface InjectCandidate {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly every: number
}

/** Structural slice of a durable session event the idempotence probe reads. */
export interface InjectionEventProbe {
  readonly type: string
  readonly data: { readonly source?: unknown }
}

/** Deployment-facing switch; the listener stays registered but pass-through when off. */
export interface AutoInjectConfig {
  readonly enabled: boolean
}

/** Whether `turn` is a boundary turn for the interval `every` (both 1-based positive). */
export function isBoundaryTurn(turn: number, every: number): boolean {
  return Number.isInteger(turn) && turn >= 1 && Number.isInteger(every) && every >= 1 && turn % every === 0
}

/** Narrow one page of templates to those enabled and due at this boundary turn, preserving store order. */
export function dueTemplates(templates: readonly TemplateView[], turn: number): InjectCandidate[] {
  const due: InjectCandidate[] = []
  for (const template of templates) {
    if (template.inject_enabled && template.inject_every !== null && isBoundaryTurn(turn, template.inject_every)) {
      due.push({ id: template.id, name: template.name, content: template.content, every: template.inject_every })
    }
  }
  return due
}

/**
 * Whether the event window `[scannedFrom, events.length)` already carries a
 * scheduled injection for `turn`. Backward scan over durable events only —
 * the same posture as the skill-catalog probe, so compaction visibility and
 * restart resume never resurrect a duplicate.
 */
export function alreadyInjectedAtTurn(events: readonly InjectionEventProbe[], scannedFrom: number, turn: number): boolean {
  for (let index = events.length - 1; index >= scannedFrom; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source as { kind?: unknown, turn?: unknown } | undefined
    if (source === undefined || source.kind !== 'prompt-template-schedule' || source.turn !== turn) continue
    return true
  }
  return false
}

/** XML-escape a template name for the `<template name="…">` attribute. */
function escapeTemplateName(name: string): string {
  return name
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Render ONE combined `<system-reminder>` user message for the due
 * templates. The frame is written for the model (English, like every
 * first-party reminder); template content is embedded verbatim and the
 * durable source records what went out.
 */
export function renderInjectionMessage(turn: number, templates: readonly InjectCandidate[]): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `Scheduled prompt-template injection from dsh-prompt-templates (turn ${turn}). The following templates repeat every N rounds in this session; follow their guidance for the work in this round.`,
        '',
        ...templates.flatMap(template => [
          `<template name="${escapeTemplateName(template.name)}" every="${template.every}">`,
          template.content,
          '</template>',
        ]),
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'prompt-template-schedule',
      turn,
      templates: templates.map(template => ({ id: template.id, name: template.name, every: template.every })),
    },
  })
}

/**
 * Register the `agent/pre-step` listener that performs scheduled injection
 * for every agent in this composition. Registration order is irrelevant:
 * the listener calls `next()` first and only appends to the downstream
 * decision, so other pre-step listeners keep their own semantics.
 *
 * Failure posture mirrors the skill catalog: a fault inside this listener
 * must never fail the session's steps, so the first fault is reported and
 * later ones stay silent while injection degrades to pass-through.
 *
 * @param ctx - host context to attach the listener to.
 * @param config - deployment switch.
 * @param store - lazy template store accessor (shared with the routes).
 */
export function registerAutoInject(ctx: Context, config: AutoInjectConfig, store: () => TemplateStore): void {
  // Per-session performance memo ONLY — correctness is anchored on the
  // durable log scan. Entries are cheap and bounded by session count.
  const sessions = new Map<string, { scanned: number, injectedTurns: Set<number> }>()
  let faultReported = false
  ctx.on('agent/pre-step', async (
    { agent, messages, turn, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!config.enabled) return decision
    // Never fabricate a step: injection rides an admitted batch only.
    if (messages.length === 0) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const state = sessions.get(sessionId) ?? { scanned: 0, injectedTurns: new Set<number>() }
      sessions.set(sessionId, state)
      if (state.injectedTurns.has(turn)) return decision
      // alpha.4 removed the session.events getter: prefer the snapshotEvents()
      // frozen full-log snapshot, fall back to the legacy array, then empty.
      const sessionLike = agent.session as unknown as { snapshotEvents?: () => readonly InjectionEventProbe[]; events?: readonly InjectionEventProbe[] }
      const events = (typeof sessionLike.snapshotEvents === 'function' ? sessionLike.snapshotEvents() : sessionLike.events) ?? [] as unknown as readonly InjectionEventProbe[]
      // Compaction or a log rewrite can shrink the array: memo indexes would
      // go stale, so fall back to a full rescan.
      if (events.length < state.scanned) state.scanned = 0
      const due = dueTemplates(store().listInjectable(sessionId), turn)
      if (due.length === 0) return decision
      if (alreadyInjectedAtTurn(events, state.scanned, turn)) {
        state.injectedTurns.add(turn)
        return decision
      }
      signal.throwIfAborted()
      state.scanned = events.length
      state.injectedTurns.add(turn)
      return { ...decision, messages: [...decision.messages, renderInjectionMessage(turn, due)] }
    } catch (error) {
      if (!faultReported) {
        faultReported = true
        console.error('[dsh-prompt-templates] auto-inject skipped this step; further faults stay silent:', error)
      }
      return decision
    }
  })
}
