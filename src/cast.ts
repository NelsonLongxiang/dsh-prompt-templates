/**
 * The prompt-templates service for other plugins on the same host (observer phase 2, workbench-market 18; PT-3).
 *
 * Reads are open to any plugin, read-only: the card library, one session's own templates, and the intervention log —
 * the same shapes as the read-only routes. Casting a card into a session is not: only a caller this plugin recognizes
 * may cast (today the a2a plugin alone), and the caller is taken from the cordis loader entry of the plugin that holds
 * the context it calls through — the package name the profile configured, never a string the caller passes. Casting is
 * off unless the deployment turns `cast.enabled` on. A cast card goes into the named session at its next step as a
 * visible message, and the delivery is recorded in the intervention log as `source: plugin` with that caller.
 * @module @nelsonlongxiang/dsh-prompt-templates/cast
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { PLUGIN_CALLERS, contentDigest, type InterventionSource, type InterventionView } from './interventions.ts'
import type { LibraryCard, TemplateStore } from './store.ts'
import type { SelfCheckRow } from './self-check.ts'
import { expandTemplateVariables } from './variables.ts'

/** The service name other plugins read: `ctx.promptTemplates`. */
export const SERVICE_NAME = 'promptTemplates'
/** Cast cards waiting for one session, at most. */
export const CAST_QUEUE_MAX = 8

/**
 * The package name of the plugin that owns `ctx`, as the profile's loader entry configured it (walking up to the nearest
 * fiber with an entry). Undefined for a context outside any loader entry (the root, a test harness).
 */
export function callerOf(ctx: Context): string | undefined {
  type FiberLike = { entry?: { options?: { name?: unknown } }; parent?: { fiber?: FiberLike } }
  let fiber = (ctx as unknown as { fiber?: FiberLike }).fiber
  for (let depth = 0; fiber !== undefined && depth < 64; depth++) {
    const name = fiber.entry?.options?.name
    if (typeof name === 'string' && name !== '') return name
    const next = fiber.parent?.fiber
    if (next === undefined || next === fiber) return undefined
    fiber = next
  }
  return undefined
}

/** One queued cast. */
interface Queued { readonly templateId: string; readonly name: string; readonly version: string | null; readonly content: string; readonly caller: string; readonly reason: string; readonly at: number }

/** Source of a cast message in the session log. */
export interface CastSource { readonly kind: 'user'; readonly scheduled: 'prompt-template-cast'; readonly turn: number; readonly step: number; readonly templates: ReadonlyArray<{ id: string; name: string; caller: string }> }

/** What a cast returns. */
export type CastResult = { ok: true; queued: number } | { ok: false; code: 'disabled' | 'caller' | 'template' | 'session' | 'full' | 'reason' | 'already-queued'; error: string }

/** The service's public face: reads open to any plugin, and cast. Nothing else is reachable on it. */
export interface PromptTemplatesService {
  library(): LibraryCard[]
  templates(sessionId: string): LibraryCard[]
  interventions(filter?: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number }): InterventionView[]
  castEnabled(): boolean
  /** One session's wrap-up self-check log (read-only, PT-4). */
  selfChecks(sessionId: string): SelfCheckRow[]
  /** Whether the wrap-up self-check is on in this deployment (a reader must not take an empty log for a missing check when it is off). */
  selfCheckEnabled(): boolean
  cast(input: { sessionId: string; templateId: string; reason: string }): CastResult
}

/** Casts waiting across all sessions, at most, and how long one waits before it is dropped. */
export const CAST_QUEUE_TOTAL_MAX = 256
export const CAST_WAIT_MS = 60 * 60_000

/** A reason on one line: newlines and control characters become a space (no forged header lines). */
export function oneLine(text: string): string {
  // Control characters, line and paragraph separators, bidi controls and zero-width characters all become a space (#28 review).
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/** Closing line of a cast (owner 2026-11-21): the card comes from the owner's library, so it binds where it applies. */
export const CAST_BINDING_LINE = '本卡取自属主的卡片库，适用即须执行；不扩大授权，不覆盖属主当下指令。'

/** The visible message a cast becomes. */
export function renderCastMessage(turn: number, step: number, cards: readonly Queued[], sessionId: string): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `⚙️ 投卡 · 第 ${String(turn)} 轮 · ${cards.map(card => card.name).join('、')}`,
        '',
        ...cards.flatMap(card => [`（投卡方：${card.caller}；原因：${card.reason}）`, expandTemplateVariables(card.content, { sessionId, turn }), '']),
        CAST_BINDING_LINE,
      ].join('\n').trimEnd(),
    }],
    source: { kind: 'user', scheduled: 'prompt-template-cast', turn, step, templates: cards.map(card => ({ id: card.templateId, name: card.name, caller: card.caller })) } satisfies CastSource as unknown as UserMessage['source'],
  })
}

/**
 * Provide the service and deliver queued casts at a session's next admitted step. The store, the switch and the queues
 * live in this closure only: the service object other plugins hold carries the five public methods and cordis' own
 * `ctx`/`name`, never the store or a way to read or drain a queue (#28 review). Delivery is recorded as `source: plugin`
 * with the caller; a fault is reported once and never fails the step. Queues are in memory: a restart drops casts that
 * have not gone in yet (the caller can check the intervention log), and a cast waits at most an hour.
 */
export function registerCast(ctx: Context, store: () => TemplateStore, enabled: () => boolean, selfCheckEnabled: () => boolean = () => false): PromptTemplatesService {
  const queues = new Map<string, Queued[]>()
  // Expired casts never count toward the host-wide cap: they are dropped first (#28 review).
  const total = (now: number): number => {
    let n = 0
    for (const [sessionId, q] of [...queues]) {
      const live = q.filter(card => now - card.at < CAST_WAIT_MS)
      if (live.length === 0) queues.delete(sessionId); else { queues.set(sessionId, live); n += live.length }
    }
    return n
  }
  const take = (sessionId: string, now: number): Queued[] => {
    const queue = queues.get(sessionId) ?? []
    queues.delete(sessionId)
    return queue.filter(card => now - card.at < CAST_WAIT_MS)
  }

  class Face extends Service {
    constructor(c: Context) { super(c, SERVICE_NAME) }
    library(): LibraryCard[] { return store().library() }
    templates(sessionId: string): LibraryCard[] { return store().library().filter(card => card.scope === 'session' && card.session_id === sessionId) }
    interventions(filter: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number } = {}): InterventionView[] { return store().interventions.list(filter) }
    castEnabled(): boolean { return enabled() }
    /**
     * One session's self-check log. The a2a plugin (the observer's reader) gets the rows whole; any other plugin gets a
     * summary only — session, time, kind and conclusion — never the evidence, wake, deadline or ticket text (#29 review).
     */
    selfChecks(sessionId: string): SelfCheckRow[] {
      const rows = store().selfChecks.list(String(sessionId))
      const caller = callerOf(this.ctx)
      if (caller !== undefined && PLUGIN_CALLERS.includes(caller)) return rows
      return rows.map(row => ({ ...row, evidence: null, wake: null, deadline: null, ticket: null }))
    }
    selfCheckEnabled(): boolean { return selfCheckEnabled() }
    /**
     * Cast one card into a session: it goes in at the session's next step as a visible message. Only a recognized caller
     * (PLUGIN_CALLERS) may cast, and only while `cast.enabled` is on. The card must be a global template or one of that
     * session's own; one copy of a card waits per session. The reason is put on one line and must be 1..500 characters.
     */
    cast(input: { sessionId: string; templateId: string; reason: string }): CastResult {
      if (!enabled()) return { ok: false, code: 'disabled', error: 'casting is off on this host (cast.enabled)' }
      const caller = callerOf(this.ctx)
      if (caller === undefined || !PLUGIN_CALLERS.includes(caller)) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may cast a card' }
      const sessionId = String(input?.sessionId ?? '').trim()
      if (sessionId === '') return { ok: false, code: 'session', error: 'name the session to cast into' }
      const reason = oneLine(String(input?.reason ?? ''))
      if (reason === '' || reason.length > 500) return { ok: false, code: 'reason', error: 'give a reason of 1..500 characters on one line' }
      const template = store().get(String(input?.templateId ?? ''))
      if (template === undefined || (template.scope === 'session' && template.session_id !== sessionId)) return { ok: false, code: 'template', error: 'no such card for that session' }
      const live = total(Date.now())
      const queue = queues.get(sessionId) ?? []
      if (queue.some(card => card.templateId === template.id)) return { ok: false, code: 'already-queued', error: 'that card already waits for this session' }
      if (queue.length >= CAST_QUEUE_MAX || live >= CAST_QUEUE_TOTAL_MAX) return { ok: false, code: 'full', error: `at most ${String(CAST_QUEUE_MAX)} cast cards can wait for one session` }
      queue.push({ templateId: template.id, name: template.name, version: template.version ?? null, content: template.content, caller, reason, at: Date.now() })
      queues.set(sessionId, queue)
      return { ok: true, queued: queue.length }
    }
  }
  const service = new Face(ctx) as unknown as PromptTemplatesService
  let faultReported = false
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || messages.length === 0) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const cards = take(sessionId, Date.now())
      if (cards.length === 0) return decision
      const message = renderCastMessage(turn, typeof step === 'number' ? step : 1, cards, sessionId)
      try {
        const at = new Date().toISOString()
        for (const card of cards) {
          store().interventions.record({ session_id: sessionId, source: 'plugin', method: null, caller: card.caller, template_id: card.templateId, template_name: card.name,
            template_version: card.version, content_sha256: contentDigest(expandTemplateVariables(card.content, { sessionId, turn })), turn, step: typeof step === 'number' ? step : null, at })
        }
      } catch (error) { console.error('[dsh-prompt-templates] intervention log skipped a cast:', error) }
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      if (!faultReported) { faultReported = true; console.error('[dsh-prompt-templates] cast skipped this step; further faults stay silent:', error) }
      return decision
    }
  })
  return service
}
