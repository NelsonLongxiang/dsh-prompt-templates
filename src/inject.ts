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

import { contentDigest } from './interventions.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { TemplateStore } from './store.ts'
import { expandTemplateVariables } from './variables.ts'
import { WORKSHOP_CATEGORY } from './lessons.ts'
import type { InjectionHistoryEntry, InjectionStatusView, TemplateInjectMode, TemplateView } from './types.ts'

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
  /** Delivery mode: `visible` renders in the chat transcript (user channel). */
  readonly mode: TemplateInjectMode
}

/** Structural slice of a durable session event the idempotence probe reads. */
export interface InjectionEventProbe {
  readonly type: string
  readonly data: { readonly source?: unknown }
}

/** The tools that close a workshop card round. */
export const CARD_ROUND_TOOLS: readonly string[] = ['lesson_write', 'lesson_none']

/**
 * The agent's tool scope key: dsh-scope keeps it on the agent's context under Symbol("dsh.scope"), possibly up the prototype
 * chain. Read by the symbol's description, since this plugin's copy of dsh-scope would hold another symbol.
 */
function scopeKeyOf(ctx: unknown): object | undefined {
  for (let cursor = ctx, depth = 0; cursor !== null && typeof cursor === 'object' && depth < 32; cursor = Object.getPrototypeOf(cursor), depth++) {
    for (const symbol of Object.getOwnPropertySymbols(cursor)) {
      if (symbol.description !== 'dsh.scope') continue
      const key = (cursor as Record<symbol, unknown>)[symbol]
      if (key !== null && typeof key === 'object') return key
    }
  }
  return undefined
}

/**
 * Whether this agent's own tool scope offers none of the tools that close a card round. DSH's registry answers get(name, scope)
 * with undefined for a tool restricted away from that scope, so this reads the session's actual tools, not its role. True only
 * on a confirmed absence: no scope, no tools service, or any fault counts as "has them", so the round opens as before.
 * @param agent - the pre-step event's agent.
 * @returns true when neither lesson_write nor lesson_none is visible to the agent.
 */
export function lessonToolsMissing(agent: unknown): boolean {
  try {
    const ctx = (agent as { ctx?: unknown } | null)?.ctx
    const tools = (ctx as { tools?: { get?: (name: string, scope?: object) => unknown } } | undefined)?.tools
    const scope = scopeKeyOf(ctx)
    if (typeof tools?.get !== 'function' || scope === undefined) return false
    return CARD_ROUND_TOOLS.every(name => tools.get!(name, scope) === undefined)
  } catch {
    // An unreadable tool scope is no proof the tools are missing.
    return false
  }
}

/** Deployment-facing switch; the listener stays registered but pass-through when off. */
export interface AutoInjectConfig {
  readonly enabled: boolean
  readonly evolutionAssessmentEnabled?: boolean
  /**
   * Called when this turn's injection carries cards of the workshop category (owner 2026-11-21): opens the card round
   * and returns the closing line to append, or null for none (lessons off, or the round was already open).
   */
  readonly onWorkshopCards?: (sessionId: string, turn: number, cards: ReadonlyArray<{ id: string; name: string; version: string | null }>, options: { readonly lessonToolsMissing: boolean }) => string | null
}

/**
 * Client-facing summary of a session's latest scheduled injection, polled by
 * the panel/tab toolbar badge (`⟳N`). Defined in types.ts (client-safe) and
 * re-exported here so the host half reads one name.
 */
export type { InjectionStatusView } from './types.ts'

/** How many recent injections per session the history surface keeps. */
export const INJECTION_HISTORY_LIMIT = 20

/**
 * Per-session injection bookkeeping. Memory-only surface for the UI badge
 * and its history dropdown; correctness of injection itself never depends
 * on it (the durable log remains the idempotence anchor).
 */
export class InjectionTracker {
  readonly #history = new Map<string, InjectionHistoryEntry[]>()

  /** Record that `sessionId` just received the injection described by `entry`. */
  note(sessionId: string, entry: InjectionHistoryEntry): void {
    const entries = this.#history.get(sessionId) ?? []
    entries.unshift(entry)
    if (entries.length > INJECTION_HISTORY_LIMIT) entries.length = INJECTION_HISTORY_LIMIT
    this.#history.set(sessionId, entries)
  }

  /** The latest injection recorded for `sessionId`, or null if none since boot. */
  status(sessionId: string): InjectionStatusView | null {
    const latest = this.#history.get(sessionId)?.[0]
    if (latest === undefined) return null
    return { turn: latest.turn, at: latest.at, templates: latest.templates }
  }

  /** The session recent injections, newest first (bounded by INJECTION_HISTORY_LIMIT). */
  history(sessionId: string): readonly InjectionHistoryEntry[] {
    return [...this.#history.get(sessionId) ?? []]
  }
}

/** What `registerAutoInject` hands back: the UI status and history surfaces. */
export interface AutoInjectHandle {
  readonly status: (sessionId: string) => InjectionStatusView | null
  readonly history: (sessionId: string) => readonly InjectionHistoryEntry[]
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
      due.push({ id: template.id, name: template.name, content: template.content, every: template.inject_every, mode: template.mode })
    }
  }
  return due
}

/**
 * Whether the event window `[scannedFrom, events.length)` already carries a
 * scheduled injection for `turn`. Backward scan over durable events only —
 * the same posture as the skill-catalog probe, so compaction visibility and
 * restart resume never resurrect a duplicate. Matches BOTH delivery shapes:
 * the silent `prompt-template-schedule` source and the visible user-channel
 * source (`kind:'user'` + `scheduled:'prompt-template'`).
 */
export function alreadyInjectedAtTurn(events: readonly InjectionEventProbe[], scannedFrom: number, turn: number): boolean {
  for (let index = events.length - 1; index >= scannedFrom; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source as { kind?: unknown, scheduled?: unknown, turn?: unknown } | undefined
    if (source === undefined || source.turn !== turn) continue
    const scheduled = source.kind === 'prompt-template-schedule'
      || (source.kind === 'user' && source.scheduled === 'prompt-template')
    if (!scheduled) continue
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
export function renderInjectionMessage(turn: number, templates: readonly InjectCandidate[], closing?: string | null): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `Scheduled prompt-template injection from dsh-prompt-templates (turn ${turn}). The following templates repeat every N rounds in this session. The owner configured these templates as standing requirements for this session: where a template applies to the current work, you must carry out what it requires in this round before continuing; where it says it does not apply, skip it. They grant no new permissions and do not override the owner's latest instructions.`,
        '',
        ...templates.flatMap(template => [
          `<template name="${escapeTemplateName(template.name)}" every="${template.every}">`,
          template.content,
          '</template>',
        ]),
        ...(closing ? [closing] : []),
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
 * Durable provenance for a VISIBLE scheduled injection (user channel): the
 * chat view renders `kind !== 'user'` sources as omitted context rows, so a
 * visible injection stamps the user kind and disambiguates itself with the
 * `scheduled` marker — keeping the dedup scan working (the marker, not the
 * kind, carries the schedule identity).
 */
export interface VisibleScheduleSource {
  readonly kind: 'user'
  readonly scheduled: 'prompt-template'
  /** The boundary turn this message belongs to. */
  readonly turn: number
  /** Exactly the templates this message injected, in injection order. */
  readonly templates: readonly { readonly id: string, readonly name: string, readonly every: number }[]
}

/**
 * Render ONE visible scheduled injection as an ordinary user message. The
 * header names the origin (so a reader never mistakes it for human typing)
 * and the durable source keeps the dedup-scan marker.
 */
/** Second line of a visible injection: the templates are the owner's standing requirements, binding where they apply (owner 2026-11-21). */
export const VISIBLE_BINDING_LINE = '属主预置的常设要求：适用即须执行，不适用则跳过；不扩大授权，不覆盖属主当下指令。'

export function renderVisibleInjectionMessage(turn: number, templates: readonly InjectCandidate[], closing?: string | null): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `⚙️ 定时注入 · 第 ${turn} 轮 · ${templates.map(template => template.name).join('、')}`,
        VISIBLE_BINDING_LINE,
        '',
        ...templates.flatMap(template => [template.content, '']),
        ...(closing ? [closing] : []),
      ].join('\n').trimEnd(),
    }],
    source: {
      kind: 'user',
      scheduled: 'prompt-template',
      turn,
      templates: templates.map(template => ({ id: template.id, name: template.name, every: template.every })),
    } satisfies VisibleScheduleSource as unknown as TemplateScheduleSource,
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
 * @returns handle exposing the per-session last-injection status for the UI.
 */
export function registerAutoInject(ctx: Context, config: AutoInjectConfig, store: () => TemplateStore): AutoInjectHandle {
  const tracker = new InjectionTracker()
  // Per-session performance memo ONLY — correctness is anchored on the
  // durable log scan. Entries are cheap and bounded by session count.
  const sessions = new Map<string, { scanned: number, injectedTurns: Set<number> }>()
  let faultReported = false
  ctx.on('agent/pre-step', async (
    { agent, messages, turn, step, signal },
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
      signal.throwIfAborted()
      const templateStore = store()
      const evolutionEnabled = config.evolutionAssessmentEnabled ?? true
      if (evolutionEnabled) templateStore.ensureEvolutionDefault(sessionId, turn)
      const scheduled = templateStore.listScheduled(sessionId, turn, evolutionEnabled)
      const due = dueTemplates(scheduled, turn)
      if (due.length === 0) return decision
      // Expand variable placeholders with this delivery context;
      // unresolved ones stay literal. The history surface records the
      // expanded bodies — what actually went out.
      const expanded = due.map(candidate => ({
        ...candidate,
        content: expandTemplateVariables(candidate.content, { sessionId, turn }),
      }))
      if (alreadyInjectedAtTurn(events, state.scanned, turn)) {
        state.injectedTurns.add(turn)
        return decision
      }
      signal.throwIfAborted()
      state.scanned = events.length
      state.injectedTurns.add(turn)
      tracker.note(sessionId, {
        turn,
        at: Date.now(),
        templates: due.map(template => template.name),
        content: expanded.map(template => template.content).join('\n\n'),
      })
      // Split by delivery mode: silent templates ride the invisible reminder
      // frame; visible ones stamp the user channel so the chat transcript
      // renders them. Both share one boundary (dedup covers the turn as a
      // whole — either source shape satisfies alreadyInjectedAtTurn).
      const injected: UserMessage[] = []
      const silent = expanded.filter(template => template.mode !== 'visible')
      const visible = expanded.filter(template => template.mode === 'visible')
      // Workshop cards open one card round per injection turn; the closing line rides the last message that carries one.
      let closing: string | null = null
      try {
        const workshop = expanded.flatMap(template => {
          const row = scheduled.find(r => r.id === template.id)
          return row?.category === WORKSHOP_CATEGORY ? [{ id: template.id, name: template.name, version: row.version ?? null }] : []
        })
        if (workshop.length > 0) closing = config.onWorkshopCards?.(sessionId, turn, workshop, { lessonToolsMissing: lessonToolsMissing(agent) }) ?? null
      } catch (error) {
        console.error('[dsh-prompt-templates] card round skipped for this injection:', error)
      }
      const visibleHasCard = visible.some(template => scheduled.find(r => r.id === template.id)?.category === WORKSHOP_CATEGORY)
      if (silent.length > 0) injected.push(renderInjectionMessage(turn, silent, visibleHasCard ? null : closing))
      if (visible.length > 0) injected.push(renderVisibleInjectionMessage(turn, visible, visibleHasCard ? closing : null))
      // v9 (observer phase 1): one durable intervention row per template that went out. A fault here never blocks the
      // injection itself.
      try {
        const at = new Date().toISOString()
        for (const template of expanded) {
          templateStore.interventions.record({ session_id: sessionId, source: 'schedule', method: null, caller: null, template_id: template.id, template_name: template.name,
            template_version: scheduled.find(row => row.id === template.id)?.version ?? null, content_sha256: contentDigest(template.content), turn, step: typeof step === 'number' ? step : null, at })
        }
      } catch (error) {
        console.error('[dsh-prompt-templates] intervention log skipped a scheduled injection:', error)
      }
      return { ...decision, messages: [...decision.messages, ...injected] }
    } catch (error) {
      if (!faultReported) {
        faultReported = true
        console.error('[dsh-prompt-templates] auto-inject skipped this step; further faults stay silent:', error)
      }
      return decision
    }
  })
  return { status: tracker.status.bind(tracker), history: tracker.history.bind(tracker) }
}
