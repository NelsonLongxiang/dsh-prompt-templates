/**
 * Evidence-ready reminders (#81, first stage). A recognized upstream plugin (PLUGIN_CALLERS, today the a2a plugin) hands
 * in one reference: a ticket, its current version, where the evidence is, and the action that waits on it. The named
 * session sees a short reminder at its next actionable step (the next pre-step, including a tool-result step with no new
 * messages), not after a fixed number of turns.
 *
 * Boundaries: off unless the deployment's `cast.enabled` is on; the upstream owns the ticket facts and any wake-up; this
 * keeps only what makes the next step visible and a restart reconcilable. It subscribes to nothing, grants nothing, opens
 * no workshop card round and counts in no card statistics. The reminder says it is not a verdict, an authorization or an
 * action.
 *
 * States, durable in `evidence_ready`:
 *   queued     handed in, not yet given to a step
 *   prepared   given to a step; becomes `persisted` once this process saw it appended to the session log and an
 *              awaited `sessions.flush` (the session store's durability checkpoint) then succeeded
 *   persisted  appended and flushed to durable storage; nothing here claims the model read it or acted on it
 *   superseded a newer version of the same ticket for that session arrived first
 *   expired    waited longer than EVIDENCE_WAIT_MS without a step
 *   failed     given to EVIDENCE_MAX_ATTEMPTS steps and never found in the log
 *   unknown    prepared, but delivery cannot be proven: the flush failed or had no durable listener, there is no
 *              session store, or it was prepared before this process started (a restart); never resent
 * A repeat of the same (session, ticket, version) adds nothing and never turns a delivered one back into undelivered.
 * @module dsh-prompt-templates/evidence-ready
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { contentDigest, type InterventionLog } from './interventions.ts'
import type { InjectionEventProbe } from './inject.ts'

/** Additive and idempotent: an older build opening the file ignores the table. */
export const EVIDENCE_READY_SQL = `CREATE TABLE IF NOT EXISTS evidence_ready (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ref TEXT NOT NULL,
  action TEXT NOT NULL,
  caller TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  turn INTEGER,
  step INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, ticket_id, version)
)`

export type EvidenceState = 'queued' | 'prepared' | 'persisted' | 'superseded' | 'expired' | 'failed' | 'unknown'

/** One evidence reference as stored and read back. */
export interface EvidenceRow {
  readonly id: string
  readonly session_id: string
  readonly ticket_id: string
  readonly version: string
  readonly ref: string
  readonly action: string
  readonly caller: string
  readonly state: EvidenceState
  readonly attempts: number
  readonly queued_at: string
  readonly turn: number | null
  readonly step: number | null
  readonly updated_at: string
}

/** How long a reference waits for a step, how many steps it is given, and how many go into one step. */
export const EVIDENCE_WAIT_MS = 24 * 3_600_000
export const EVIDENCE_MAX_ATTEMPTS = 3
export const EVIDENCE_PER_STEP = 3
/** References waiting (queued or prepared) for one session, at most. */
export const EVIDENCE_QUEUE_MAX = 16

/** The message source marker that the reconcile reads back from the session log. */
export const EVIDENCE_SCHEDULED = 'prompt-template-evidence'

/** The id of one (session, ticket, version): the same reference always maps to the same row. */
export function evidenceId(sessionId: string, ticketId: string, version: string): string {
  return createHash('sha256').update(JSON.stringify([sessionId, ticketId, version]), 'utf8').digest('hex').slice(0, 32)
}

/** The durable store over the plugin's own SQLite file. */
export class EvidenceReadyStore {
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync) { this.#db = db }

  get(id: string): EvidenceRow | undefined {
    return this.#db.prepare('SELECT * FROM evidence_ready WHERE id = ?').get(id) as EvidenceRow | undefined
  }

  /** One session's rows, newest first; optionally one ticket's. */
  list(sessionId: string, ticketId?: string): EvidenceRow[] {
    return (ticketId === undefined
      ? this.#db.prepare('SELECT * FROM evidence_ready WHERE session_id = ? ORDER BY queued_at DESC, id').all(sessionId)
      : this.#db.prepare('SELECT * FROM evidence_ready WHERE session_id = ? AND ticket_id = ? ORDER BY queued_at DESC, id').all(sessionId, ticketId)) as unknown as EvidenceRow[]
  }

  inState(sessionId: string, state: EvidenceState): EvidenceRow[] {
    return this.#db.prepare('SELECT * FROM evidence_ready WHERE session_id = ? AND state = ? ORDER BY queued_at, id').all(sessionId, state) as unknown as EvidenceRow[]
  }

  waiting(sessionId: string): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM evidence_ready WHERE session_id = ? AND state IN ('queued', 'prepared')").get(sessionId) as { n: number }).n)
  }

  setState(id: string, state: EvidenceState, at: string, place?: { turn: number; step: number }): void {
    if (place === undefined) this.#db.prepare('UPDATE evidence_ready SET state = ?, updated_at = ? WHERE id = ?').run(state, at, id)
    else this.#db.prepare('UPDATE evidence_ready SET state = ?, updated_at = ?, turn = ?, step = ?, attempts = attempts + 1 WHERE id = ?').run(state, at, place.turn, place.step, id)
  }

  /**
   * Hand in one reference. A repeat of the same (session, ticket, version) returns the existing row unchanged. A new
   * version of a ticket supersedes that session's older ones still queued; a prepared older one is settled at the next
   * reconcile (persisted if the log has it, otherwise superseded, never sent again).
   */
  offer(input: { sessionId: string; ticketId: string; version: string; ref: string; action: string; caller: string }, at: string): { created: boolean; row: EvidenceRow } {
    const id = evidenceId(input.sessionId, input.ticketId, input.version)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.get(id)
      if (existing !== undefined) { this.#db.exec('COMMIT'); return { created: false, row: existing } }
      this.#db.prepare("UPDATE evidence_ready SET state = 'superseded', updated_at = ? WHERE session_id = ? AND ticket_id = ? AND state = 'queued'").run(at, input.sessionId, input.ticketId)
      this.#db.prepare(`INSERT INTO evidence_ready (id, session_id, ticket_id, version, ref, action, caller, state, attempts, queued_at, turn, step, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?)`).run(id, input.sessionId, input.ticketId, input.version, input.ref, input.action, input.caller, at, at)
      this.#db.exec('COMMIT')
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch { /* none open */ } throw error }
    return { created: true, row: this.get(id)! }
  }

  /**
   * Whether a reference for the same session and ticket was handed in after this one. Ordered by insertion (rowid; rows
   * are never deleted), never by time: two versions handed in within the same millisecond keep their order.
   */
  replaced(row: EvidenceRow): boolean {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM evidence_ready WHERE session_id = ? AND ticket_id = ? AND rowid > (SELECT rowid FROM evidence_ready WHERE id = ?)')
      .get(row.session_id, row.ticket_id, row.id) as { n: number }).n > 0
  }
}

/** What reconcile knows about one prepared reference. */
export type DeliveryVerdict = 'persisted' | 'absent' | 'unknown'

/** Whether a session event is one of ours, and which reference ids it carries. */
export function evidenceIdsOf(event: InjectionEventProbe | undefined): string[] {
  if (event?.type !== 'user/message') return []
  const source = event.data.source as { kind?: unknown; scheduled?: unknown; items?: unknown } | undefined
  if (source?.kind !== 'user' || source.scheduled !== EVIDENCE_SCHEDULED || !Array.isArray(source.items)) return []
  return (source.items as Array<{ id?: unknown }>).flatMap(item => typeof item?.id === 'string' ? [item.id] : [])
}

/** The visible message for one step's references. */
export function renderEvidenceMessage(turn: number, step: number, rows: readonly EvidenceRow[]): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `⚙️ 证据就绪 · 第 ${String(turn)} 轮`,
        ...rows.flatMap(row => [`- 工单 ${row.ticket_id} · 版本 ${row.version}（交来方：${row.caller}）`, `  证据：${row.ref}`, `  待判断：${row.action}`]),
        '',
        '这是证据就绪提示，不是验证结论、授权或实际动作：先读证据，再按现行规则判断下一步；需要授权的仍走原入口。',
      ].join('\n'),
    }],
    source: { kind: 'user', scheduled: EVIDENCE_SCHEDULED, turn, step, items: rows.map(row => ({ id: row.id, ticket_id: row.ticket_id, version: row.version })) } as unknown as UserMessage['source'],
  })
}

/**
 * Reconcile, then pick this step's references. `verdictOf` says what is known about each prepared one: persisted
 * (appended and flushed), absent (prepared here and never appended: given again, bounded), or unknown (never resent).
 * Exported for tests; the host path is the listener below.
 */
export function prepareEvidence(store: EvidenceReadyStore, sessionId: string, turn: number, step: number, verdictOf: (row: EvidenceRow) => DeliveryVerdict, now: number): EvidenceRow[] {
  const at = new Date(now).toISOString()
  const prepared = store.inState(sessionId, 'prepared')
  if (prepared.length > 0) {
    for (const row of prepared) {
      const verdict = verdictOf(row)
      if (verdict === 'persisted') store.setState(row.id, 'persisted', at)
      else if (verdict === 'unknown') store.setState(row.id, 'unknown', at)
      else if (store.replaced(row)) store.setState(row.id, 'superseded', at)
      else if (row.attempts >= EVIDENCE_MAX_ATTEMPTS) store.setState(row.id, 'failed', at)
      else store.setState(row.id, 'queued', at)
    }
  }
  const chosen: EvidenceRow[] = []
  for (const row of store.inState(sessionId, 'queued')) {
    if (now - Date.parse(row.queued_at) > EVIDENCE_WAIT_MS) { store.setState(row.id, 'expired', at); continue }
    if (chosen.length >= EVIDENCE_PER_STEP) continue
    store.setState(row.id, 'prepared', at, { turn, step })
    chosen.push(store.get(row.id)!)
  }
  return chosen
}

/**
 * Register the listeners. Pass-through while `enabled()` is false; a fault is reported once and never fails a step.
 * Delivery is proven in this process only: a `session/event` append of our message, then an awaited
 * `sessions.flush(session)` that resolves true (at least one durability listener, all settled; dsh-session 0.2.1-rc.2
 * `SessionStore.flush`). No synchronous session log read is used. Anything that cannot be proven is unknown.
 */
export function registerEvidenceReady(ctx: Context, store: () => EvidenceReadyStore, enabled: () => boolean, interventions?: () => InterventionLog): void {
  let faultReported = false
  const appended = new Map<string, Set<string>>()
  const preparedHere = new Set<string>()
  ctx.on('session/event' as never, ((session: { header?: { id?: unknown }; id?: unknown }, event: InjectionEventProbe) => {
    try {
      const ids = evidenceIdsOf(event)
      if (ids.length === 0) return
      const sessionId = String(session?.header?.id ?? session?.id ?? '')
      const seen = appended.get(sessionId) ?? new Set<string>()
      for (const id of ids) seen.add(id)
      appended.set(sessionId, seen)
    } catch { /* an observer never fails an append */ }
  }) as never)
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted === true || !enabled()) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const stepNo = typeof step === 'number' ? step : 1
      let durable = false
      if (store().inState(sessionId, 'prepared').length > 0) {
        try {
          const sessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as { flush?: (session: unknown) => Promise<boolean> } | undefined
          durable = typeof sessions?.flush === 'function' ? (await sessions.flush(agent.session)) === true : false
        } catch { durable = false }
      }
      const seen = appended.get(sessionId) ?? new Set<string>()
      const verdictOf = (row: EvidenceRow): DeliveryVerdict => !preparedHere.has(row.id) ? 'unknown' : seen.has(row.id) ? (durable ? 'persisted' : 'unknown') : 'absent'
      const rows = prepareEvidence(store(), sessionId, turn, stepNo, verdictOf, Date.now())
      if (rows.length === 0) return decision
      for (const row of rows) preparedHere.add(row.id)
      const message = renderEvidenceMessage(turn, stepNo, rows)
      if (interventions !== undefined) {
        try {
          const text = (message.content as unknown as Array<{ text?: string }>).map(part => part.text ?? '').join('')
          for (const row of rows) {
            interventions().record({ session_id: sessionId, source: 'plugin', method: null, caller: row.caller, template_id: `evidence:${row.ticket_id}`, template_name: `evidence:${row.ticket_id}`,
              template_version: row.version, content_sha256: contentDigest(text), turn, step: stepNo })
          }
        } catch (error) { console.error('[dsh-prompt-templates] intervention log skipped an evidence reminder:', error) }
      }
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      if (!faultReported) { faultReported = true; console.error('[dsh-prompt-templates] evidence reminder skipped this step; further faults stay silent:', error) }
      return decision
    }
  })
}
