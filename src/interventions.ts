/**
 * Durable intervention log (0.16, schema v9; workbench-market 18, observer phase 1).
 *
 * One row each time template content is put into a session: by the turn schedule, by an event reminder, by a person on
 * the panel (insert, send, interject), or — reserved for phase 2 — by another plugin. A row keeps the template's identity
 * and a digest of what went out, never the session's other content. The rows survive a host restart and are read by
 * session and by time through the read-only route (`GET …/interventions`).
 * @module @nelsonlongxiang/dsh-prompt-templates/interventions
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Where an intervention came from. `plugin` is reserved for phase 2 (another plugin asking for a card). */
export type InterventionSource = 'schedule' | 'event' | 'manual' | 'plugin'
/** How a person sent it from the panel. */
export type ManualMethod = 'insert' | 'send' | 'interject'

export const INTERVENTION_SOURCES: readonly InterventionSource[] = ['schedule', 'event', 'manual', 'plugin']
export const MANUAL_METHODS: readonly ManualMethod[] = ['insert', 'send', 'interject']

/** DDL of the v9 table; runs inside the store's migration transaction. */
export const INTERVENTIONS_SQL = `CREATE TABLE IF NOT EXISTS interventions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('schedule', 'event', 'manual', 'plugin')),
  method TEXT,
  caller TEXT,
  template_id TEXT,
  template_name TEXT NOT NULL,
  template_version TEXT,
  content_sha256 TEXT NOT NULL,
  turn INTEGER,
  step INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interventions_session_at ON interventions (session_id, at);
CREATE INDEX IF NOT EXISTS interventions_at ON interventions (at)`

/** One recorded intervention (wire shape; the shape phase 2's service will hand other plugins). */
export interface InterventionView {
  readonly seq: number
  readonly session_id: string
  readonly source: InterventionSource
  /** `insert` / `send` / `interject` for a manual one; otherwise null. */
  readonly method: string | null
  /**
   * Who asked, for a `plugin` one: the calling plugin's package name (phase 2's card service takes only
   * PLUGIN_CALLERS). Null for schedule, event and manual.
   */
  readonly caller: string | null
  /** The template's id; for an event reminder `event:<rule_id>`. Null when the template is gone. */
  readonly template_id: string | null
  readonly template_name: string
  /** The template's version label (e.g. `atelier-5.16.1`); for an event reminder its rule version. */
  readonly template_version: string | null
  /** SHA-256 of the exact text that went out — the content itself is not stored. */
  readonly content_sha256: string
  /** Turn and step of the delivery; null for a manual one (the panel cannot see the agent's step). */
  readonly turn: number | null
  readonly step: number | null
  /** ISO 8601 time. */
  readonly at: string
}

/** What a caller records; `seq` and `at` are the log's. */
export type InterventionInput = Omit<InterventionView, 'seq' | 'at'> & { readonly at?: string }

/**
 * The only callers phase 2's card service will take (workbench-market #883: the a2a plugin alone; a caller it cannot
 * identify is refused). Reading the library and the log stays open to other plugins, read-only.
 */
export const PLUGIN_CALLERS: readonly string[] = ['@nelsonlongxiang/dsh-open-a2a-net']

/** SHA-256 hex of a text. */
export const contentDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Most rows one read returns. */
export const INTERVENTIONS_READ_MAX = 500

/** The log over the plugin's own SQLite file. */
export class InterventionLog {
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync) { this.#db = db }

  /** Append one row. */
  record(input: InterventionInput): InterventionView {
    if (!INTERVENTION_SOURCES.includes(input.source)) throw new Error(`unknown intervention source ${String(input.source)}`)
    if (input.source === 'manual' && !MANUAL_METHODS.includes(input.method as ManualMethod)) throw new Error('a manual intervention needs method insert, send or interject')
    if (input.source === 'plugin' && !PLUGIN_CALLERS.includes(input.caller ?? '')) throw new Error('a plugin intervention needs a caller this plugin recognizes')
    if (input.source !== 'plugin' && input.caller !== null) throw new Error('only a plugin intervention has a caller')
    const at = input.at ?? new Date().toISOString()
    const result = this.#db.prepare(`INSERT INTO interventions
      (session_id, source, method, caller, template_id, template_name, template_version, content_sha256, turn, step, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.session_id, input.source, input.method, input.caller, input.template_id, input.template_name, input.template_version, input.content_sha256, input.turn, input.step, at)
    return { ...input, seq: Number(result.lastInsertRowid), at }
  }

  /**
   * Read rows, oldest first.
   * @param filter - one session, rows at or after `since` (ISO), at most `limit` (capped at INTERVENTIONS_READ_MAX).
   */
  list(filter: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number } = {}): InterventionView[] {
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (filter.sessionId !== undefined) { clauses.push('session_id = ?'); args.push(filter.sessionId) }
    if (filter.since !== undefined) { clauses.push('at >= ?'); args.push(filter.since) }
    if (filter.source !== undefined) { clauses.push('source = ?'); args.push(filter.source) }
    const limit = Math.max(1, Math.min(INTERVENTIONS_READ_MAX, Math.trunc(filter.limit ?? 100)))
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    // The newest `limit` rows, returned oldest first.
    const rows = this.#db.prepare(`SELECT * FROM (SELECT * FROM interventions${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq`).all(...args, limit)
    return rows as unknown as InterventionView[]
  }
}
