/**
 * Pure-TS template store over `node:sqlite`, replacing the former Python
 * backend child. Owns the same SQLite database file and schema
 * (`templates` table, `user_version` 1), so an existing
 * `$DSH_HOME/ext/prompt-templates/db.sqlite3` keeps working unchanged.
 *
 * Business rules ported verbatim from the Python store:
 *   - a template name is unique within its scope partition `(scope, session_id)`
 *   - `scope='session'` requires `session_id`; `scope='global'` must not carry one
 *   - make-global rejects already-global rows and global name collisions
 *
 * @module dsh-prompt-templates/store
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PromptScope, TemplateCreateRequest, TemplateUpdateRequest, TemplateView } from './types.ts'

/** Schema version gate, matching the Python backend's `TEMPLATES_SCHEMA_VERSION`. */
const SCHEMA_VERSION = 1

const NAME_MAX = 128
const DESCRIPTION_MAX = 512
const SESSION_ID_MAX = 128

/** Business-rule violation surfaced to routes as HTTP 400. */
export class TemplateRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateRuleError'
  }
}

/** One row as read from the database. */
export interface TemplateRow {
  id: string
  name: string
  content: string
  scope: PromptScope
  session_id: string | null
  description: string | null
  position: number
  created_at: string
  updated_at: string
}

/** Pure-TS prompt-template store owning one SQLite database file. */
export class TemplateStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
      try { chmodSync(dirname(dbPath), 0o700) } catch { /* best-effort on non-POSIX */ }
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    const onDisk = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (onDisk === 0) {
      this.db.exec(`CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`)
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
    } else if (onDisk !== SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`${dbPath} has schema version ${onDisk}, incompatible with this build (expected ${SCHEMA_VERSION})`)
    }
    if (dbPath !== ':memory:') {
      try { chmodSync(dbPath, 0o600) } catch { /* best-effort */ }
    }
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close()
  }

  /** List templates ordered by position then creation time, with optional scope/session filters. */
  list(scope?: string, sessionId?: string): TemplateView[] {
    let sql = 'SELECT * FROM templates'
    const conditions: string[] = []
    const args: (string | number)[] = []
    if (scope !== undefined) { conditions.push('scope = ?'); args.push(scope) }
    if (sessionId !== undefined) { conditions.push('session_id = ?'); args.push(sessionId) }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY position, created_at'
    return (this.db.prepare(sql).all(...args) as unknown as TemplateRow[]).map(rowToView)
  }

  /** Fetch one template; `undefined` when absent. */
  get(id: string): TemplateView | undefined {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
    return row === undefined ? undefined : rowToView(row)
  }

  /** Insert a template, rejecting a duplicate name in its scope partition. */
  create(data: TemplateCreateRequest): TemplateView {
    const scope: PromptScope = data.scope ?? 'global'
    const sessionId = data.session_id ?? null
    if (typeof data.name !== 'string' || data.name.length < 1 || data.name.length > NAME_MAX) {
      throw new TemplateRuleError(`name must be a string of 1..${NAME_MAX} characters`)
    }
    if (typeof data.content !== 'string' || data.content.length < 1) {
      throw new TemplateRuleError('content must be a non-empty string')
    }
    if (scope === 'session' && (sessionId === null || sessionId === '')) {
      throw new TemplateRuleError("scope='session' requires session_id")
    }
    if (scope === 'global' && sessionId !== null) {
      throw new TemplateRuleError("scope='global' must not carry session_id")
    }
    if (sessionId !== null && sessionId.length > SESSION_ID_MAX) {
      throw new TemplateRuleError(`session_id must be at most ${SESSION_ID_MAX} characters`)
    }
    const description = data.description ?? null
    if (description !== null && description.length > DESCRIPTION_MAX) {
      throw new TemplateRuleError(`description must be at most ${DESCRIPTION_MAX} characters`)
    }
    const position = data.position ?? 0
    if (!Number.isInteger(position) || position < 0) {
      throw new TemplateRuleError('position must be a non-negative integer')
    }
    const clash = this.db.prepare(
      'SELECT id FROM templates WHERE scope = ? AND session_id IS ? AND name = ?',
    ).get(scope, sessionId, data.name)
    if (clash !== undefined) {
      throw new TemplateRuleError(`template name '${data.name}' already exists in scope ${scope}`)
    }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const row: TemplateRow = {
      id: randomUUID().replaceAll('-', ''),
      name: data.name,
      content: data.content,
      scope,
      session_id: sessionId,
      description,
      position,
      created_at: now,
      updated_at: now,
    }
    this.db.prepare(
      'INSERT INTO templates (id, name, content, scope, session_id, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.content, row.scope, row.session_id, row.description, row.position, row.created_at, row.updated_at)
    return rowToView(row)
  }

  /** Apply a patch; `undefined` when absent. Renames keep the partition uniqueness rule. */
  update(id: string, patch: TemplateUpdateRequest): TemplateView | undefined {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
    if (row === undefined) return undefined
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const newName = fields['name']
    if (newName !== undefined) {
      if (typeof newName !== 'string' || newName.length < 1 || newName.length > NAME_MAX) {
        throw new TemplateRuleError(`name must be a string of 1..${NAME_MAX} characters`)
      }
      if (newName !== row.name) {
        const clash = this.db.prepare(
          'SELECT id FROM templates WHERE id != ? AND scope = ? AND session_id IS ? AND name = ?',
        ).get(id, row.scope, row.session_id, newName)
        if (clash !== undefined) {
          throw new TemplateRuleError(`template name '${newName}' already exists in scope ${row.scope}`)
        }
      }
    }
    if (fields['description'] !== undefined && fields['description'] !== null
      && String(fields['description']).length > DESCRIPTION_MAX) {
      throw new TemplateRuleError(`description must be at most ${DESCRIPTION_MAX} characters`)
    }
    if (fields['position'] !== undefined && (!Number.isInteger(Number(fields['position'])) || Number(fields['position']) < 0)) {
      throw new TemplateRuleError('position must be a non-negative integer')
    }
    const merged = { ...row, ...fields } as TemplateRow
    merged.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.db.prepare(
      'UPDATE templates SET name = ?, content = ?, description = ?, position = ?, updated_at = ? WHERE id = ?',
    ).run(merged.name, merged.content, merged.description, merged.position, merged.updated_at, id)
    return rowToView(merged)
  }

  /** Promote one session template to the global partition; `undefined` when absent. */
  makeGlobal(id: string): TemplateView | undefined {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
    if (row === undefined) return undefined
    if (row.scope === 'global') throw new TemplateRuleError(`template '${id}' is already global`)
    const clash = this.db.prepare(
      "SELECT id FROM templates WHERE scope = 'global' AND session_id IS NULL AND name = ?",
    ).get(row.name)
    if (clash !== undefined) {
      throw new TemplateRuleError(`template name '${row.name}' already exists in scope global`)
    }
    const updated = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.db.prepare("UPDATE templates SET scope = 'global', session_id = NULL, updated_at = ? WHERE id = ?").run(updated, id)
    return rowToView({ ...row, scope: 'global', session_id: null, updated_at: updated })
  }

  /** Delete one template; `false` when absent. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0
  }
}

/** Map one database row to the wire view (field names are already snake_case). */
function rowToView(row: TemplateRow): TemplateView {
  return { ...row }
}
