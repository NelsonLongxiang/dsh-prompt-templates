/**
 * Durable cast queue (open-a2a-net #902 S1). A card cast into a session waits here until the session's next admitted
 * step, so a host restart no longer drops it. Each row keeps who cast it, why and on what basis; it ends as `delivered`,
 * `withdrawn` (the caster took it back) or `expired` (it waited longer than the wait limit). Rows are never deleted, so
 * what was cast and what became of it can be read back; the card text is cleared when a row ends.
 *
 * #902 review (#86 B1): a row handed to a step is only marked `sent` (sent_at); it becomes `delivered` once the session's
 * own log shows the cast message naming it. A row sent but not in the log at the session's next step (the step failed,
 * or the host stopped first) goes back to waiting, so a card is never marked delivered on a send that did not land.
 * @module @nelsonlongxiang/dsh-prompt-templates/cast-queue
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Additive and idempotent (no schema version bump): an older build opening the file ignores the table. */
export const CAST_QUEUE_SQL = `CREATE TABLE IF NOT EXISTS cast_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  content TEXT NOT NULL,
  caller TEXT NOT NULL,
  reason TEXT NOT NULL,
  basis TEXT,
  at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered', 'withdrawn', 'expired')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS cast_queue_waiting ON cast_queue (state, session_id, at)`

/** The state of one queued cast. */
export type CastState = 'waiting' | 'delivered' | 'withdrawn' | 'expired'

/** One queued cast as stored (the text is kept only while the card waits for delivery). */
export interface CastRow {
  readonly id: string
  readonly session_id: string
  readonly template_id: string
  readonly name: string
  readonly version: string | null
  readonly content: string
  readonly caller: string
  readonly reason: string
  readonly basis: string | null
  readonly at: string
  readonly state: CastState
  readonly ended_at: string | null
  /** #902 S3: `insert` goes in at the session's next step; `queue` waits for the first step of its next turn. */
  readonly mode: CastMode
  /** #902 review: the caller's own label for this cast (for the a2a plugin: its team, observer and requested mode). */
  readonly origin: string | null
  /** #902 review (#86 B1): when the row was handed to a step and not yet seen in the session's log; null otherwise. */
  readonly sent_at: string | null
}

/** How a queued cast goes in (#902 S3). */
export type CastMode = 'insert' | 'queue'

/** A queued cast as other plugins read it: everything but the text. */
export type CastView = Omit<CastRow, 'content'>

/** The queue over the plugin's own SQLite file. */
export class CastQueueStore {
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync) { this.#db = db }

  /** Mark every waiting row older than `waitMs` and not handed to a step as expired; returns how many. */
  expire(now: number, waitMs: number): number {
    const cutoff = new Date(now - waitMs).toISOString()
    return Number(this.#db.prepare("UPDATE cast_queue SET state = 'expired', ended_at = ?, content = '' WHERE state = 'waiting' AND sent_at IS NULL AND at < ?").run(new Date(now).toISOString(), cutoff).changes)
  }

  /** Mark waiting rows as handed to a step (still waiting until the session's log shows them). */
  markSent(ids: readonly string[], at: string): void {
    for (const id of ids) this.#db.prepare("UPDATE cast_queue SET sent_at = ? WHERE id = ? AND state = 'waiting'").run(at, id)
  }

  /** Put sent rows back to waiting (their send did not land). */
  unsend(ids: readonly string[]): void {
    for (const id of ids) this.#db.prepare("UPDATE cast_queue SET sent_at = NULL WHERE id = ? AND state = 'waiting'").run(id)
  }

  /** Waiting rows: for one session, or across all sessions. */
  waiting(sessionId?: string): CastRow[] {
    return (sessionId === undefined
      ? this.#db.prepare("SELECT * FROM cast_queue WHERE state = 'waiting' ORDER BY at, id").all()
      : this.#db.prepare("SELECT * FROM cast_queue WHERE state = 'waiting' AND session_id = ? ORDER BY at, id").all(sessionId)) as unknown as CastRow[]
  }

  /** Append one waiting row. */
  add(row: Omit<CastRow, 'id' | 'state' | 'ended_at' | 'sent_at'>): CastRow {
    const id = randomUUID()
    this.#db.prepare(`INSERT INTO cast_queue (id, session_id, template_id, name, version, content, caller, reason, basis, at, state, mode, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`).run(id, row.session_id, row.template_id, row.name, row.version, row.content, row.caller, row.reason, row.basis, row.at, row.mode, row.origin)
    return { ...row, id, state: 'waiting', ended_at: null, sent_at: null }
  }

  /** End waiting rows by id with one state; returns the rows that were waiting. */
  end(ids: readonly string[], state: Exclude<CastState, 'waiting'>, at: string): CastRow[] {
    const ended: CastRow[] = []
    for (const id of ids) {
      const row = this.#db.prepare("SELECT * FROM cast_queue WHERE id = ? AND state = 'waiting'").get(id) as unknown as CastRow | undefined
      if (row === undefined) continue
      // The text is kept only while the row waits (the intervention log keeps its digest).
      this.#db.prepare("UPDATE cast_queue SET state = ?, ended_at = ?, content = '' WHERE id = ?").run(state, at, id)
      ended.push(row)
    }
    return ended
  }

  /**
   * Read rows, newest first, without the text.
   * @param filter - one session, one state, at most `limit` (1..500, default 100).
   */
  list(filter: { sessionId?: string; state?: CastState; limit?: number; origin?: string } = {}): CastView[] {
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (filter.sessionId !== undefined) { clauses.push('session_id = ?'); args.push(filter.sessionId) }
    if (filter.origin !== undefined) { clauses.push('origin = ?'); args.push(filter.origin) }
    if (filter.state !== undefined) { clauses.push('state = ?'); args.push(filter.state) }
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 100)))
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.#db.prepare(`SELECT id, session_id, template_id, name, version, caller, reason, basis, at, state, ended_at, mode, origin, sent_at FROM cast_queue${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, limit)
    return rows as unknown as CastView[]
  }
}
