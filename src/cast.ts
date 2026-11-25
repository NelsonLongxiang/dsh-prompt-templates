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
import { EVIDENCE_QUEUE_MAX, type EvidenceRow, type EvidenceState } from './evidence-ready.ts'
import type { CastMode, CastRow, CastState, CastView } from './cast-queue.ts'

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

/** One cast as the message renders it (a durable queue row, #902 S1). */
type Queued = Pick<CastRow, 'template_id' | 'name' | 'version' | 'content' | 'caller' | 'reason' | 'basis'> & { readonly id?: string }

/** Source of a cast message in the session log. */
export interface CastSource { readonly kind: 'user'; readonly scheduled: 'prompt-template-cast'; readonly turn: number; readonly step: number; readonly templates: ReadonlyArray<{ id: string; name: string; caller: string }>; /** #902 review: the queue rows this message carries, so the session's log confirms their delivery. */ readonly casts?: readonly string[] }

/** What a cast returns. */
export type CastResult = { ok: true; queued: number; id: string } | { ok: false; code: 'disabled' | 'caller' | 'template' | 'session' | 'full' | 'reason' | 'basis' | 'mode' | 'origin' | 'already-queued'; error: string }

/** What writing an author session's card returns (#902 S2). */
export type DraftResult = { ok: true; id: string; name: string; content_sha256: string; created: boolean } | { ok: false; code: 'caller' | 'session' | 'card' | 'input' | 'name'; error: string }

/** What reading or withdrawing queued casts returns (#902 S1; recognized caller only). */
export type CastQueueResult = { ok: true; items: CastView[] } | { ok: false; code: 'caller' | 'state'; error: string }
export type CastWithdrawResult = { ok: true; withdrawn: boolean } | { ok: false; code: 'caller' | 'session'; error: string }

/** The service's public face: reads open to any plugin, and cast. Nothing else is reachable on it. */
export interface PromptTemplatesService {
  library(): LibraryCard[]
  templates(sessionId: string): LibraryCard[]
  interventions(filter?: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number }): InterventionView[]
  castEnabled(): boolean
  /**
   * #902 review (#910 B1): what this build's cast does, so a caller offers only what it can rely on: the delivery modes,
   * whether a cast takes an origin label, and whether delivery is confirmed from the session's log.
   */
  castCapabilities(): { modes: readonly string[]; origin: boolean; confirmedDelivery: boolean }
  /** One session's wrap-up self-check log (read-only, PT-4). */
  selfChecks(sessionId: string): SelfCheckRow[]
  /** Whether the wrap-up self-check is on in this deployment (a reader must not take an empty log for a missing check when it is off). */
  selfCheckEnabled(): boolean
  /** Cast a card; `basis` (#902 S1) is the ticket, event or `none: …` it rests on, one line of at most 200 characters. */
  cast(input: { sessionId: string; templateId: string; reason: string; basis?: string; authorSession?: string; mode?: CastMode; origin?: string }): CastResult
  /** #902 S1: read queued casts (newest first, no text); recognized caller only. `origin` keeps only rows with that label. */
  castQueue(filter?: { sessionId?: string; state?: CastState; limit?: number; origin?: string }): CastQueueResult
  /** #902 S1: withdraw one waiting cast of a session; recognized caller only. */
  castWithdraw(input: { sessionId: string; id: string; origin?: string }): CastWithdrawResult
  /**
   * #902 S2: create (no id) or edit (id) a card in one session's own templates for that session's caster (the a2a
   * plugin writes the team observer's own cards); recognized caller only. The card is an ordinary session template: its
   * session sees it in the panel like any other.
   */
  draftCard(input: { authorSession: string; id?: string; name: string; content: string; description?: string }): DraftResult
  /** #902 S2: delete one card of that session's own templates; recognized caller only. */
  draftDelete(input: { authorSession: string; id: string }): { ok: true; deleted: boolean } | { ok: false; code: 'caller' | 'session'; error: string }
  /** #81: hand in one evidence reference for a session's next actionable step (recognized caller, cast.enabled). */
  evidenceReady(input: { sessionId: string; ticketId: string; version: string; ref: string; action: string }): EvidenceReadyResult
  /** #81: read back one session's references and their states (recognized caller only). */
  evidenceReadyStatus(input: { sessionId: string; ticketId?: string }): EvidenceStatusResult
}

/** What handing in an evidence reference returns. A repeat returns the existing row's state, never resets it. */
export type EvidenceReadyResult = { ok: true; id: string; state: EvidenceState; created: boolean } | { ok: false; code: 'disabled' | 'caller' | 'session' | 'field' | 'full'; error: string }
export type EvidenceStatusResult = { ok: true; items: EvidenceRow[] } | { ok: false; code: 'caller' | 'session'; error: string }

/** Casts waiting across all sessions, at most, and how long one waits before it is dropped. */
export const CAST_QUEUE_TOTAL_MAX = 256
export const CAST_WAIT_MS = 60 * 60_000

/** A reason on one line: newlines and control characters become a space (no forged header lines). */
export function oneLine(text: string): string {
  // Control characters, line and paragraph separators, bidi controls and zero-width characters all become a space (#28 review).
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/** Closing line of a cast (owner 2026-11-21): the card comes from the owner's library, so it binds where it applies. */
export const CAST_BINDING_LINE = '本卡取自属主的卡片库，适用即须执行；在已有授权内推进，属主当下的指令优先。'

/** The visible message a cast becomes. */
export function renderCastMessage(turn: number, step: number, cards: readonly Queued[], sessionId: string): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `⚙️ 投卡 · 第 ${String(turn)} 轮 · ${cards.map(card => card.name).join('、')}`,
        '',
        ...cards.flatMap(card => [`（投卡方：${card.caller}；原因：${card.reason}${card.basis ? `；依据：${card.basis}` : ''}）`, expandTemplateVariables(card.content, { sessionId, turn }), '']),
        CAST_BINDING_LINE,
      ].join('\n').trimEnd(),
    }],
    source: { kind: 'user', scheduled: 'prompt-template-cast', turn, step, templates: cards.map(card => ({ id: card.template_id, name: card.name, caller: card.caller })), casts: cards.flatMap(card => (card.id !== undefined ? [card.id] : [])) } satisfies CastSource as unknown as UserMessage['source'],
  })
}

/**
 * #902 review (#86 B1): the queue rows the session's own log shows went in, with the turn and step of the message that
 * carried them. Reads `snapshotEvents()` (or the older `events`); a session without either, or whose log cannot be
 * read, answers undefined (unknown).
 */
export function castsInLog(session: unknown): Map<string, { turn: number | null; step: number | null }> | undefined {
  const found = new Map<string, { turn: number | null; step: number | null }>()
  const s = session as { snapshotEvents?: () => ReadonlyArray<{ type?: string; data?: { source?: unknown } }>; events?: ReadonlyArray<{ type?: string; data?: { source?: unknown } }> }
  // #89 review B1: no log to read is unknown, not "nothing landed".
  let events: ReadonlyArray<{ type?: string; data?: { source?: unknown } }> | undefined
  try { events = typeof s?.snapshotEvents === 'function' ? s.snapshotEvents() : s?.events } catch { return undefined }
  if (!Array.isArray(events)) return undefined
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source as { scheduled?: unknown; casts?: unknown; turn?: unknown; step?: unknown } | undefined
    if (source?.scheduled !== 'prompt-template-cast' || !Array.isArray(source.casts)) continue
    for (const id of source.casts) if (typeof id === 'string') found.set(id, { turn: typeof source.turn === 'number' ? source.turn : null, step: typeof source.step === 'number' ? source.step : null })
  }
  return found
}

/** A field of an evidence reference (#81): one line, 1..max characters, or undefined. */
function evidenceField(value: unknown, max: number): string | undefined {
  const text = oneLine(String(value ?? ''))
  return text === '' || text.length > max ? undefined : text
}

/**
 * Provide the service and deliver queued casts at a session's next admitted step. The store and the switch live in this
 * closure only: the service object other plugins hold carries its public methods and cordis' own `ctx`/`name`, never the
 * store or a way to drain a queue (#28 review); reading and withdrawing queued casts is for a recognized caller only.
 * Delivery is recorded as `source: plugin` with the caller and the cast's basis; a fault is reported once and never
 * fails the step. #902 S1: the queue is a table in the plugin's database, so a restart keeps what waits; a cast waits at
 * most an hour, then is marked expired.
 */
export function registerCast(ctx: Context, store: () => TemplateStore, enabled: () => boolean, selfCheckEnabled: () => boolean = () => false): PromptTemplatesService {
  // #902 S1: the queue is the store's table, so a restart keeps what waits; a cast waits at most CAST_WAIT_MS.
  const waiting = (sessionId: string | undefined, now: number): CastRow[] => { store().castQueue.expire(now, CAST_WAIT_MS); return store().castQueue.waiting(sessionId) }
  const recognized = (c: Context): string | undefined => { const caller = callerOf(c); return caller !== undefined && PLUGIN_CALLERS.includes(caller) ? caller : undefined }

  class Face extends Service {
    constructor(c: Context) { super(c, SERVICE_NAME) }
    library(): LibraryCard[] { return store().library() }
    templates(sessionId: string): LibraryCard[] { return store().library().filter(card => card.scope === 'session' && card.session_id === sessionId) }
    interventions(filter: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number } = {}): InterventionView[] { return store().interventions.list(filter) }
    castEnabled(): boolean { return enabled() }
    castCapabilities(): { modes: readonly string[]; origin: boolean; confirmedDelivery: boolean } { return { modes: ['insert', 'queue'], origin: true, confirmedDelivery: true } }
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
    cast(input: { sessionId: string; templateId: string; reason: string; basis?: string; authorSession?: string; mode?: CastMode; origin?: string }): CastResult {
      if (!enabled()) return { ok: false, code: 'disabled', error: 'casting is off on this host (cast.enabled)' }
      const caller = callerOf(this.ctx)
      if (caller === undefined || !PLUGIN_CALLERS.includes(caller)) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may cast a card' }
      const sessionId = String(input?.sessionId ?? '').trim()
      if (sessionId === '') return { ok: false, code: 'session', error: 'name the session to cast into' }
      const reason = oneLine(String(input?.reason ?? ''))
      if (reason === '' || reason.length > 500) return { ok: false, code: 'reason', error: 'give a reason of 1..500 characters on one line' }
      const mode: CastMode = input?.mode === undefined ? 'insert' : input.mode
      if (mode !== 'insert' && mode !== 'queue') return { ok: false, code: 'mode', error: 'mode is insert (the next step) or queue (the first step of the next turn)' }
      const basis = input?.basis === undefined ? null : oneLine(String(input.basis))
      if (basis !== null && (basis === '' || basis.length > 200)) return { ok: false, code: 'basis', error: 'give a basis of 1..200 characters on one line, or none' }
      const origin = input?.origin === undefined ? null : oneLine(String(input.origin))
      if (origin !== null && (origin === '' || origin.length > 200)) return { ok: false, code: 'origin', error: 'origin is the caller\'s label: 1..200 characters on one line' }
      const template = store().get(String(input?.templateId ?? ''))
      // #902 S2: a recognized caller may also cast a card of the author session it names (the a2a plugin checks who that is).
      const author = input?.authorSession === undefined ? '' : String(input.authorSession).trim()
      const own = template !== undefined && template.scope === 'session' && template.session_id === sessionId
      const authored = template !== undefined && template.scope === 'session' && author !== '' && author !== sessionId && template.session_id === author
      if (template === undefined || (template.scope === 'session' && !own && !authored)) return { ok: false, code: 'template', error: 'no such card for that session' }
      const now = Date.now()
      const queue = waiting(sessionId, now)
      if (queue.some(card => card.template_id === template.id)) return { ok: false, code: 'already-queued', error: 'that card already waits for this session' }
      if (queue.length >= CAST_QUEUE_MAX || waiting(undefined, now).length >= CAST_QUEUE_TOTAL_MAX) return { ok: false, code: 'full', error: `at most ${String(CAST_QUEUE_MAX)} cast cards can wait for one session` }
      const row = store().castQueue.add({ session_id: sessionId, template_id: template.id, name: authored ? `定制·${template.name}` : template.name, version: template.version ?? null, content: template.content, caller, reason, basis, at: new Date(now).toISOString(), mode, origin })
      return { ok: true, queued: queue.length + 1, id: row.id }
    }

    castQueue(filter: { sessionId?: string; state?: CastState; limit?: number; origin?: string } = {}): CastQueueResult {
      if (recognized(this.ctx) === undefined) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may read the cast queue' }
      if (filter.state !== undefined && !['waiting', 'delivered', 'withdrawn', 'expired'].includes(filter.state)) return { ok: false, code: 'state', error: 'state must be waiting, delivered, withdrawn or expired' }
      store().castQueue.expire(Date.now(), CAST_WAIT_MS)
      return { ok: true, items: store().castQueue.list({ ...(filter.sessionId !== undefined ? { sessionId: String(filter.sessionId) } : {}), ...(filter.state !== undefined ? { state: filter.state } : {}), ...(filter.limit !== undefined ? { limit: filter.limit } : {}), ...(filter.origin !== undefined ? { origin: String(filter.origin) } : {}) }) }
    }

    castWithdraw(input: { sessionId: string; id: string; origin?: string }): CastWithdrawResult {
      if (recognized(this.ctx) === undefined) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may withdraw a cast' }
      const sessionId = String(input?.sessionId ?? '').trim()
      const id = String(input?.id ?? '').trim()
      if (sessionId === '' || id === '') return { ok: false, code: 'session', error: 'name the session and the queued cast' }
      // Only a cast still waiting for that very session (and, when given, with that origin), not yet handed to a step:
      // an id from another session or caster withdraws nothing, and a card that may already have gone in is not claimed back.
      const origin = input?.origin === undefined ? undefined : String(input.origin)
      const mine = waiting(sessionId, Date.now()).some(row => row.id === id && row.sent_at === null && (origin === undefined || row.origin === origin))
      return { ok: true, withdrawn: mine && store().castQueue.end([id], 'withdrawn', new Date().toISOString()).length === 1 }
    }

    draftCard(input: { authorSession: string; id?: string; name: string; content: string; description?: string }): DraftResult {
      if (recognized(this.ctx) === undefined) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may write a session\'s cards' }
      const author = String(input?.authorSession ?? '').trim()
      if (author === '') return { ok: false, code: 'session', error: 'name the author session' }
      const name = oneLine(String(input?.name ?? ''))
      const content = String(input?.content ?? '')
      if (name === '' || name.length > 128) return { ok: false, code: 'name', error: 'name the card: one line, 1..128 characters' }
      if (content.trim() === '' || content.length > 8000) return { ok: false, code: 'input', error: 'the card text is 1..8000 characters' }
      const description = input?.description === undefined ? undefined : oneLine(String(input.description)).slice(0, 512)
      try {
        if (input?.id !== undefined) {
          const current = store().get(String(input.id))
          if (current === undefined || current.scope !== 'session' || current.session_id !== author) return { ok: false, code: 'card', error: 'no such card of that session' }
          const view = store().update(current.id, { name, content, ...(description !== undefined ? { description } : {}) })!
          return { ok: true, id: view.id, name: view.name, content_sha256: contentDigest(view.content), created: false }
        }
        const view = store().create({ name, content, scope: 'session', session_id: author, ...(description !== undefined ? { description } : {}) })
        return { ok: true, id: view.id, name: view.name, content_sha256: contentDigest(view.content), created: true }
      } catch (error) {
        return { ok: false, code: 'name', error: error instanceof Error ? error.message : String(error) }
      }
    }

    draftDelete(input: { authorSession: string; id: string }): { ok: true; deleted: boolean } | { ok: false; code: 'caller' | 'session'; error: string } {
      if (recognized(this.ctx) === undefined) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may delete a session\'s cards' }
      const author = String(input?.authorSession ?? '').trim()
      const current = store().get(String(input?.id ?? ''))
      if (author === '') return { ok: false, code: 'session', error: 'name the author session' }
      if (current === undefined || current.scope !== 'session' || current.session_id !== author) return { ok: true, deleted: false }
      return { ok: true, deleted: store().delete(current.id) }
    }

    /** #81: one evidence reference for the session's next actionable step. A repeat returns the existing state unchanged. */
    evidenceReady(input: { sessionId: string; ticketId: string; version: string; ref: string; action: string }): EvidenceReadyResult {
      if (!enabled()) return { ok: false, code: 'disabled', error: 'casting is off on this host (cast.enabled)' }
      const caller = callerOf(this.ctx)
      if (caller === undefined || !PLUGIN_CALLERS.includes(caller)) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may hand in evidence' }
      const sessionId = String(input?.sessionId ?? '').trim()
      if (sessionId === '') return { ok: false, code: 'session', error: 'name the session' }
      const ticketId = evidenceField(input?.ticketId, 200), version = evidenceField(input?.version, 200), ref = evidenceField(input?.ref, 500), action = evidenceField(input?.action, 300)
      if (ticketId === undefined || version === undefined || ref === undefined || action === undefined) return { ok: false, code: 'field', error: 'ticketId and version 1..200, ref 1..500, action 1..300 characters, each on one line' }
      const evidence = store().evidence
      const existing = evidence.list(sessionId, ticketId).find(row => row.version === version)
      if (existing === undefined && evidence.waiting(sessionId) >= EVIDENCE_QUEUE_MAX) return { ok: false, code: 'full', error: 'too many references wait for this session' }
      const { created, row } = evidence.offer({ sessionId, ticketId, version, ref, action, caller }, new Date().toISOString())
      return { ok: true, id: row.id, state: row.state, created }
    }

    /** #81: read back one session's references and their states (recognized caller only). */
    evidenceReadyStatus(input: { sessionId: string; ticketId?: string }): EvidenceStatusResult {
      const caller = callerOf(this.ctx)
      if (caller === undefined || !PLUGIN_CALLERS.includes(caller)) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may read evidence states' }
      const sessionId = String(input?.sessionId ?? '').trim()
      if (sessionId === '') return { ok: false, code: 'session', error: 'name the session' }
      return { ok: true, items: store().evidence.list(sessionId, input?.ticketId === undefined ? undefined : String(input.ticketId)) }
    }
  }
  const service = new Face(ctx) as unknown as PromptTemplatesService
  let faultReported = false
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // Casting off: nothing can be queued, so the step does not read the store at all (#902 S1).
    if (decision.kind === 'reject' || messages.length === 0 || !enabled()) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const now = Date.now()
      // #902 review (#86 B1): first settle what an earlier step handed over. A row the session's log shows went in is
      // delivered, and its intervention record goes in the same transaction (#89 review B2: both or neither, so a failed
      // record is tried again at the next step and written once). A row the log does not show stays sent (#89 review B1).
      const pending = waiting(sessionId, now)
      const sent = pending.filter(row => row.sent_at !== null)
      const landed = sent.length > 0 ? castsInLog(agent.session) : undefined
      if (landed !== undefined) {
        const at = new Date(now).toISOString()
        for (const row of sent.filter(r => landed.has(r.id))) {
          const where = landed.get(row.id)!
          try {
            store().transaction(() => {
              for (const card of store().castQueue.end([row.id], 'delivered', at)) {
                store().interventions.record({ session_id: sessionId, source: 'plugin', method: null, caller: card.caller, template_id: card.template_id, template_name: card.name,
                  template_version: card.version, content_sha256: contentDigest(expandTemplateVariables(card.content, { sessionId, turn: where.turn ?? turn })), turn: where.turn, step: where.step, at, basis: card.basis, mode: card.mode, origin: card.origin })
              }
            })
          } catch (error) { console.error('[dsh-prompt-templates] a delivered cast stays sent until its record can be written:', error) }
        }
      }
      // #902 S3: a `queue` cast waits for the first step of a turn, so it never cuts into a turn under way.
      const first = typeof step !== 'number' || step <= 1
      const queued = waiting(sessionId, now).filter(row => row.sent_at === null && (row.mode !== 'queue' || first))
      if (queued.length === 0) return decision
      // Marked sent before the message goes out, so a second step never hands the same row over twice; it becomes
      // delivered only once the session's log shows it (above, at the next step).
      store().castQueue.markSent(queued.map(row => row.id), new Date(now).toISOString())
      const message = renderCastMessage(turn, typeof step === 'number' ? step : 1, queued, sessionId)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      if (!faultReported) { faultReported = true; console.error('[dsh-prompt-templates] cast skipped this step; further faults stay silent:', error) }
      return decision
    }
  })
  return service
}
