import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { CategoryView, TemplateView } from '../types.ts'
import { createSnapshot, diffSnapshots, type DataSnapshot } from './model.ts'

export interface ImportPlan {
  readonly changes: number
  readonly template_inserts: number
  readonly template_updates: number
  readonly category_inserts: number
  readonly name_conflicts: readonly unknown[]
  readonly summary_sha256: string
}

export interface ImportOptions {
  readonly apply: boolean
  readonly expectedDbSha256?: string
  readonly confirmedSummarySha256?: string
  readonly backupOut?: string
  readonly maxChanges: number
  readonly busyTimeoutMs?: number
}

export interface ImportResult {
  readonly applied: boolean
  readonly backup?: string
  readonly plan: ImportPlan
}

/** A valid operation blocked by a safety/business gate (CLI exit 1). */
export class ImportBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportBlockedError' }
}

export function exportDatabase(dbPath: string, filters: { scope?: 'global' | 'session'; sessionId?: string } = {}): DataSnapshot {
  const path = safeDatabasePath(dbPath)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON')
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version !== 2) throw new Error(`${path} has schema version ${version}, expected 2`)
    const clauses: string[] = []
    const args: string[] = []
    if (filters.scope !== undefined) { clauses.push('scope = ?'); args.push(filters.scope) }
    if (filters.sessionId !== undefined) { clauses.push('session_id = ?'); args.push(filters.sessionId) }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const templates = db.prepare(`SELECT id,name,content,scope,session_id,description,position,category,created_at,updated_at FROM templates${where}`).all(...args) as unknown as TemplateView[]
    const categories = db.prepare(`SELECT name,scope,session_id FROM categories${where}`).all(...args) as unknown as CategoryView[]
    return createSnapshot(categories, templates, { exported_at: new Date().toISOString(), source: path })
  } finally { db.close() }
}

/**
 * Logical database hash: the canonical schema/categories/templates snapshot,
 * not raw file bytes. This works against a live WAL database on Windows
 * (where the main file may be locked and WAL pages are not in its byte hash)
 * and binds exactly the business data an import may replace.
 */
export function databaseSha256(dbPath: string): string {
  return exportDatabase(dbPath).data_sha256
}

export function planImport(dbPath: string, incoming: DataSnapshot): ImportPlan {
  const current = exportDatabase(dbPath)
  const diff = diffSnapshots(current, incoming)
  const templateInserts = diff.templates.only_right.length
  const templateUpdates = diff.templates.changed.length
  const categoryInserts = diff.categories.only_right.length
  const changes = templateInserts + templateUpdates + categoryInserts
  const raw = JSON.stringify({ changes, templateInserts, templateUpdates, categoryInserts, data_sha256: incoming.data_sha256 })
  return {
    changes,
    template_inserts: templateInserts,
    template_updates: templateUpdates,
    category_inserts: categoryInserts,
    name_conflicts: diff.templates.name_conflicts,
    summary_sha256: createHash('sha256').update(raw).digest('hex'),
  }
}

export async function importDatabase(dbPath: string, incoming: DataSnapshot, options: ImportOptions): Promise<ImportResult> {
  const path = safeDatabasePath(dbPath)
  const plan = planImport(path, incoming)
  if (plan.name_conflicts.length > 0) throw new ImportBlockedError('import blocked by same-name/different-id conflicts')
  if (plan.changes > options.maxChanges) throw new ImportBlockedError(`import has ${plan.changes} changes, exceeding --max-changes ${options.maxChanges}`)
  if (!options.apply) return { applied: false, plan }
  if (options.expectedDbSha256 === undefined) throw new Error('--apply requires --expect-db-sha256')
  if (options.confirmedSummarySha256 === undefined) throw new Error('--apply requires --confirm-summary-hash from the reviewed dry-run')
  if (options.confirmedSummarySha256.toLowerCase() !== plan.summary_sha256.toLowerCase()) throw new ImportBlockedError(`dry-run summary changed (expected ${options.confirmedSummarySha256}, actual ${plan.summary_sha256})`)
  const actualHash = databaseSha256(path)
  if (actualHash.toLowerCase() !== options.expectedDbSha256.toLowerCase()) throw new ImportBlockedError(`database sha256 changed (expected ${options.expectedDbSha256}, actual ${actualHash})`)
  const db = new DatabaseSync(path)
  let backupPath: string | undefined
  try {
    db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`)
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version !== 2) throw new Error(`${path} has schema version ${version}, expected 2`)
    backupPath = resolve(options.backupOut ?? `${path}.${timestampName()}.bak`)
    mkdirSync(dirname(backupPath), { recursive: true })
    await backup(db, backupPath)
    db.exec('BEGIN IMMEDIATE')
    try {
      // SQLite treats NULL values as distinct for uniqueness, including the
      // legacy composite PRIMARY KEY (scope, session_id, name). Therefore
      // INSERT OR IGNORE does NOT deduplicate global categories whose
      // session_id is NULL. Mirror the store's semantic key explicitly with
      // `IS ?` before inserting; this keeps zero-change apply idempotent.
      const findCategory = db.prepare('SELECT 1 FROM categories WHERE scope = ? AND session_id IS ? AND name = ? LIMIT 1')
      const insertCategory = db.prepare('INSERT INTO categories (name,scope,session_id) VALUES (?,?,?)')
      for (const item of incoming.categories) {
        if (findCategory.get(item.scope, item.session_id, item.name) === undefined) {
          insertCategory.run(item.name, item.scope, item.session_id)
        }
      }
      const upsertTemplate = db.prepare(`INSERT INTO templates
        (id,name,content,scope,session_id,description,position,category,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,content=excluded.content,scope=excluded.scope,
        session_id=excluded.session_id,description=excluded.description,position=excluded.position,
        category=excluded.category,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      for (const item of incoming.templates) upsertTemplate.run(item.id, item.name, item.content, item.scope, item.session_id, item.description, item.position, item.category, item.created_at, item.updated_at)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally { db.close() }
  return { applied: true, backup: backupPath, plan }
}

function safeDatabasePath(input: string): string {
  const absolute = resolve(input)
  if (!existsSync(absolute)) throw new Error(`database not found: ${absolute}`)
  if (extname(absolute).toLowerCase() !== '.sqlite3' && extname(absolute).toLowerCase() !== '.db') throw new Error(`database path must end with .sqlite3 or .db: ${absolute}`)
  const real = realpathSync(absolute)
  if (real !== absolute) throw new Error(`symbolic-link database paths are not allowed: ${absolute}`)
  return real
}

function timestampName(): string { return new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replace('Z', 'Z') }
