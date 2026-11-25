/** Durable casts and their references to messages committed by the host. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const CAST_STATES = ['waiting', 'prepared', 'delivered', 'withdrawn', 'expired', 'unknown'] as const
export type CastState = typeof CAST_STATES[number]

const CAST_QUEUE_SQL = `CREATE TABLE IF NOT EXISTS cast_queue (
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
  state TEXT NOT NULL CHECK (state IN ('waiting', 'prepared', 'delivered', 'withdrawn', 'expired', 'unknown')),
  ended_at TEXT,
  mode TEXT NOT NULL DEFAULT 'insert',
  message_id TEXT,
  message_sha256 TEXT,
  event_seq INTEGER,
  CHECK (state IN ('waiting', 'prepared') OR content = ''),
  CHECK (state != 'prepared' OR (message_id IS NOT NULL AND message_sha256 IS NOT NULL)),
  CHECK (state != 'delivered' OR (message_id IS NOT NULL AND message_sha256 IS NOT NULL AND event_seq IS NOT NULL))
)`

/** Runs inside the store's migration transaction, including the copy and index rebuild. */
export function migrateCastQueue(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(cast_queue)').all()
  if (columns.length > 0 && !columns.some(column => column.name === 'message_id')) {
    db.exec('ALTER TABLE cast_queue RENAME TO cast_queue_legacy')
    db.exec(CAST_QUEUE_SQL)
    const mode = columns.some(column => column.name === 'mode') ? 'mode' : "'insert'"
    // Older versions could record delivery before the host appended the message. Their rows have no receipt.
    db.exec(`INSERT INTO cast_queue (id, session_id, template_id, name, version, content, caller, reason, basis, at, state, ended_at, mode)
      SELECT id, session_id, template_id, name, version, CASE WHEN state = 'waiting' THEN content ELSE '' END,
        caller, reason, basis, at, CASE WHEN state = 'delivered' THEN 'unknown' ELSE state END, ended_at, ${mode}
      FROM cast_queue_legacy`)
    db.exec('DROP TABLE cast_queue_legacy')
  }
  db.exec(CAST_QUEUE_SQL)
  db.exec('CREATE INDEX IF NOT EXISTS cast_queue_waiting ON cast_queue (state, session_id, at)')
}

/** How a queued cast enters the session. */
export type CastMode = 'insert' | 'queue'

/** Queue metadata that recognized plugins can read. The host event is scoped to session_id. */
export interface CastView {
  readonly id: string
  readonly session_id: string
  readonly template_id: string
  readonly name: string
  readonly version: string | null
  readonly caller: string
  readonly reason: string
  readonly basis: string | null
  readonly at: string
  readonly state: CastState
  readonly ended_at: string | null
  readonly mode: CastMode
  readonly message_id: string | null
  readonly message_sha256: string | null
  readonly event_seq: number | null
}

/** The queue keeps the body while a cast is waiting or prepared. */
export interface CastRow extends CastView {
  readonly content: string
}

type CastInput = Omit<CastRow, 'id' | 'state' | 'ended_at' | 'message_id' | 'message_sha256' | 'event_seq'>

/** The queue over the plugin's own SQLite file. */
export class CastQueueStore {
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync) { this.#db = db }

  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch { /* preserve the transaction failure */ }
      throw error
    }
  }

  /** Expire only waiting cards. A prepared card still needs its host outcome. */
  expire(now: number, waitMs: number): void {
    const cutoff = new Date(now - waitMs).toISOString()
    this.#db.prepare("UPDATE cast_queue SET state = 'expired', ended_at = ?, content = '' WHERE state = 'waiting' AND at < ?").run(new Date(now).toISOString(), cutoff)
  }

  waiting(sessionId: string): CastRow[] {
    return this.#db.prepare("SELECT * FROM cast_queue WHERE state = 'waiting' AND session_id = ? ORDER BY at, id").all(sessionId) as unknown as CastRow[]
  }

  /** Waiting and prepared cards share the admission and duplicate limits. */
  active(): Pick<CastRow, 'session_id' | 'template_id'>[] {
    return this.#db.prepare("SELECT session_id, template_id FROM cast_queue WHERE state IN ('waiting', 'prepared')").all() as Pick<CastRow, 'session_id' | 'template_id'>[]
  }

  /** Message IDs of unfinished batches persisted for this session. */
  prepared(sessionId: string): string[] {
    return this.#db.prepare("SELECT DISTINCT message_id FROM cast_queue WHERE state = 'prepared' AND session_id = ?").all(sessionId).map(row => String(row.message_id))
  }

  add(row: CastInput): string {
    const id = randomUUID()
    this.#db.prepare(`INSERT INTO cast_queue (id, session_id, template_id, name, version, content, caller, reason, basis, at, state, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(id, row.session_id, row.template_id, row.name, row.version, row.content, row.caller, row.reason, row.basis, row.at, row.mode)
    return id
  }

  /** Reserve the complete rendered batch or leave the queue unchanged. */
  prepare(sessionId: string, ids: readonly string[], messageId: string, digest: string): void {
    this.#transaction(() => {
      const claim = this.#db.prepare("UPDATE cast_queue SET state = 'prepared', message_id = ?, message_sha256 = ? WHERE session_id = ? AND id = ? AND state = 'waiting'")
      for (const id of ids) {
        if (Number(claim.run(messageId, digest, sessionId, id).changes) !== 1) throw new Error('cast changed before preparation')
      }
    })
  }

  /** Release a batch after the originating step or turn ended without appending its message. */
  release(sessionId: string, messageId: string): void {
    this.#db.prepare("UPDATE cast_queue SET state = 'waiting', message_id = NULL, message_sha256 = NULL WHERE session_id = ? AND message_id = ? AND state = 'prepared'").run(sessionId, messageId)
  }

  /** Settle a batch and its intervention records in one transaction. A null receipt records uncertainty. */
  settle(sessionId: string, messageId: string, at: string, receipt: { seq: number; digest: string } | undefined, record: (row: CastRow) => void): void {
    this.#transaction(() => {
      const rows = this.#db.prepare("SELECT * FROM cast_queue WHERE session_id = ? AND message_id = ? AND state = 'prepared' ORDER BY at, id").all(sessionId, messageId) as unknown as CastRow[]
      if (rows.length === 0) return
      const confirmed = receipt !== undefined && rows.every(row => row.message_sha256 === receipt.digest)
      if (confirmed) for (const row of rows) record(row)
      this.#db.prepare(`UPDATE cast_queue SET state = ?, ended_at = ?, event_seq = ?, content = ''
        WHERE session_id = ? AND message_id = ? AND state = 'prepared'`).run(confirmed ? 'delivered' : 'unknown', at, confirmed ? receipt.seq : null, sessionId, messageId)
    })
  }

  /** The session and waiting state are checked by the same write that erases the body. */
  withdraw(sessionId: string, id: string, at: string): boolean {
    return Number(this.#db.prepare("UPDATE cast_queue SET state = 'withdrawn', ended_at = ?, content = '' WHERE session_id = ? AND id = ? AND state = 'waiting'").run(at, sessionId, id).changes) === 1
  }

  /** Read metadata newest first, capped at 500 rows. */
  list(filter: { sessionId?: string; state?: CastState; limit?: number } = {}): CastView[] {
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (filter.sessionId !== undefined) { clauses.push('session_id = ?'); args.push(filter.sessionId) }
    if (filter.state !== undefined) { clauses.push('state = ?'); args.push(filter.state) }
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 100)))
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.#db.prepare(`SELECT id, session_id, template_id, name, version, caller, reason, basis, at, state, ended_at, mode,
      message_id, message_sha256, event_seq FROM cast_queue${where} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, limit) as unknown as CastView[]
  }
}
