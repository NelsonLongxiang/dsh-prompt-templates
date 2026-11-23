/**
 * Pure-TS template store over `node:sqlite`, replacing the former Python
 * backend child. Owns the same SQLite database file and schema
 * (`templates` + `categories` tables plus event, evolution, version, intervention,
 * self-check and lesson tables; `user_version` = `SCHEMA_VERSION` below), so an existing
 * `$DSH_HOME/ext/prompt-templates/db.sqlite3` keeps working and migrates
 * in place.
 *
 * Business rules ported verbatim from the Python store:
 *   - a template name is unique within its scope partition `(scope, session_id)`
 *   - `scope='session'` requires `session_id`; `scope='global'` must not carry one
 *   - make-global rejects already-global rows and global name collisions
 * and extended in v3 with the auto-inject facts:
 *   - `inject_enabled` toggles per-round scheduled injection
 *   - `inject_every` is the interval in rounds (1..injectMaxEvery); it is
 *     required whenever `inject_enabled` is on and may persist while off
 *
 * @module dsh-prompt-templates/store
 */

import { EVOLUTION_NAME, EVOLUTION_SOURCE, EVOLUTION_VERSION, EVOLUTION_EVERY, EVOLUTION_CONTENT, EVOLUTION_SCHEMA_SQL } from './evolution-default.ts'
import { randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EVENT_MASTER_SQL, EVENT_REPEAT_AFTER_SQL, EVENT_SCHEMA_SQL, EventStore, seedDefaultPolicies } from './event-store.ts'
import { INTERVENTIONS_SQL, InterventionLog, contentDigest } from './interventions.ts'
import { SELF_CHECK_SQL, SelfCheckLog } from './self-check.ts'
import { LESSONS_SQL, LESSON_EVIDENCE_SQL, LESSON_HITS_SQL, LESSON_OUTCOME_SQL, LESSON_TYPES_SQL, LessonStore } from './lessons.ts'
import { EVIDENCE_READY_SQL, EvidenceReadyStore } from './evidence-ready.ts'

/** v9: the version label of a template's text. */
const TEMPLATE_VERSION_SQL = 'ALTER TABLE templates ADD COLUMN version TEXT'
/** v9: versions stored beside a card's active text (library packs); the active pointer is `templates.version`. */
const TEMPLATE_VERSIONS_SQL = `CREATE TABLE IF NOT EXISTS template_versions (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source TEXT,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
)`
import type { CategoryCreateRequest, CategoryView, PromptScope, TemplateCreateRequest, TemplateInjectMode, TemplateUpdateRequest, TemplateView } from './types.ts'

/**
 * Schema version gate; v4 adds `templates.mode` (inject|visible), v5 adds
 * the event-reminder tables (policies, observations, episodes, outbox),
 * v6 the UI-owned `event_master` switch + evolution enrollment/tombstones,
 * v7 combines both migrations into one schema version,
 * v8 adds `event_episodes.repeated_after_reminder` (提醒后仍在重复, 0.16),
 * v9 adds `templates.version` and the durable `interventions` log (observer phase 1, 0.16),
 * v10 adds the wrap-up `self_check_log` (observer phase 2, PT-4),
 * v11 adds `lesson_cues` and `lesson_log` (体会, docs/spec-lesson-inject.md).
 */
export const SCHEMA_VERSION = 11

/** Upper bound of the inject interval when the deployment config omits one. */
export const DEFAULT_INJECT_MAX_EVERY = 1000

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
  category: string | null
  /** Storage truth for the auto-inject switch: 1 = on, 0 = off. */
  inject_enabled: 0 | 1
  /** Injection interval in rounds; `null` when never configured. */
  inject_every: number | null
  /** Version label of the text (v9); null for a person's own or edited template. */
  version?: string | null
  /** Scheduled-injection delivery mode ('inject' default, 'visible' = user channel). */
  mode: TemplateInjectMode
  created_at: string
  updated_at: string
}

/** v4 schema: v3 columns plus the injection delivery mode. */
const SCHEMA_V4_SQL = `CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  inject_enabled INTEGER NOT NULL DEFAULT 0,
  inject_every INTEGER,
  mode TEXT NOT NULL DEFAULT 'inject',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE categories (
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (scope, session_id, name)
)`

/** Storage options a deployment may tune. */
export interface TemplateStoreOptions {
  /** Upper bound accepted for `inject_every`; defaults to {@link DEFAULT_INJECT_MAX_EVERY}. */
  readonly injectMaxEvery?: number
}

/** Pure-TS prompt-template store owning one SQLite database file. */
export class TemplateStore {
  readonly #injectMaxEvery: number
  private readonly db: DatabaseSync
  /** Event-reminder persistence over the same database handle. */
  readonly events: EventStore
  /** The durable intervention log (v9). */
  readonly interventions: InterventionLog
  /** The wrap-up self-check log (v10). */
  readonly selfChecks: SelfCheckLog
  /** Lesson cues and log (v11). */
  readonly lessons: LessonStore
  /** Evidence-ready references (#81; additive table, no version bump). */
  readonly evidence: EvidenceReadyStore

  constructor(dbPath: string, options: TemplateStoreOptions = {}) {
    this.#injectMaxEvery = options.injectMaxEvery ?? DEFAULT_INJECT_MAX_EVERY
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
      try { chmodSync(dirname(dbPath), 0o700) } catch { /* best-effort on non-POSIX */ }
    }
    this.db = new DatabaseSync(dbPath)
    try {
      this.db.exec('PRAGMA busy_timeout=5000')
      this.db.exec('PRAGMA journal_mode=WAL')
      // Inspect and migrate under the same write lock so concurrent first
      // openers never act on a stale schema version.
      this.db.exec('BEGIN IMMEDIATE')
      const onDisk = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (onDisk === 0) {
        this.db.exec(SCHEMA_V4_SQL)
        this.db.exec(EVENT_SCHEMA_SQL)
        this.db.exec(EVENT_MASTER_SQL)
        this.db.exec(EVOLUTION_SCHEMA_SQL)
        this.db.exec(EVENT_REPEAT_AFTER_SQL)
        this.db.exec(TEMPLATE_VERSION_SQL)
        this.db.exec(TEMPLATE_VERSIONS_SQL)
        this.db.exec(INTERVENTIONS_SQL)
        this.db.exec(SELF_CHECK_SQL)
        this.db.exec(LESSONS_SQL)
        seedDefaultPolicies(this.db)
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      } else if (onDisk >= 1 && onDisk < SCHEMA_VERSION) {
        // Every DDL change commits or rolls back together.
        if (onDisk === 1) {
          this.db.exec('ALTER TABLE templates ADD COLUMN category TEXT')
          this.db.exec('CREATE TABLE categories (name TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT, PRIMARY KEY (scope, session_id, name))')
        }
        if (onDisk <= 2) {
          this.db.exec('ALTER TABLE templates ADD COLUMN inject_enabled INTEGER NOT NULL DEFAULT 0')
          this.db.exec('ALTER TABLE templates ADD COLUMN inject_every INTEGER')
        }
        if (onDisk <= 3) this.db.exec("ALTER TABLE templates ADD COLUMN mode TEXT NOT NULL DEFAULT 'inject'")
        if (onDisk <= 4) {
          this.db.exec(EVENT_SCHEMA_SQL)
          seedDefaultPolicies(this.db)
        }
        if (onDisk <= 5) this.db.exec(EVENT_MASTER_SQL)
        if (onDisk <= 6) this.db.exec(EVOLUTION_SCHEMA_SQL)
        // Guarded: a v5–v7 file that already has the column (a partial earlier migration) must not fail on it.
        if (onDisk <= 7 && !(this.db.prepare('PRAGMA table_info(event_episodes)').all() as Array<{ name: string }>).some(col => col.name === 'repeated_after_reminder')) this.db.exec(EVENT_REPEAT_AFTER_SQL)
        if (onDisk <= 8) {
          if (!(this.db.prepare('PRAGMA table_info(templates)').all() as Array<{ name: string }>).some(col => col.name === 'version')) this.db.exec(TEMPLATE_VERSION_SQL)
          this.db.exec(TEMPLATE_VERSIONS_SQL)
          this.db.exec(INTERVENTIONS_SQL)
        }
        if (onDisk <= 9) this.db.exec(SELF_CHECK_SQL)
        if (onDisk <= 10) this.db.exec(LESSONS_SQL)
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      } else if (onDisk !== SCHEMA_VERSION) {
        throw new Error(`${dbPath} has schema version ${onDisk}, incompatible with this build (expected ${SCHEMA_VERSION})`)
      }
      // Additive and idempotent, so no version bump: an older build opening this file ignores the extra table.
      this.db.exec(LESSON_TYPES_SQL)
      this.db.exec(LESSON_HITS_SQL)
      this.db.exec(LESSON_EVIDENCE_SQL)
      this.db.exec(LESSON_OUTCOME_SQL)
      this.db.exec(EVIDENCE_READY_SQL)
      this.db.exec('COMMIT')
      if (dbPath !== ':memory:') {
        try { chmodSync(dbPath, 0o600) } catch { /* best-effort */ }
      }
      this.events = new EventStore(this.db)
      this.interventions = new InterventionLog(this.db)
      this.selfChecks = new SelfCheckLog(this.db)
      this.lessons = new LessonStore(this.db)
      this.evidence = new EvidenceReadyStore(this.db)
    } catch (error) {
      // A failed constructor has no owner to close it later. Preserve the
      // original fault even when initialization failed before BEGIN.
      try { this.db.exec('ROLLBACK') } catch { /* transaction may not exist */ }
      try { this.db.close() } catch { /* preserve initialization fault */ }
      throw error
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

  /**
   * List injection-enabled templates that apply to one session: global ones
   * plus the session's own, ordered by position then creation time.
   */
  listInjectable(sessionId: string): TemplateView[] {
    return (this.db.prepare(
      "SELECT * FROM templates WHERE inject_enabled = 1 AND (scope = 'global' OR (scope = 'session' AND session_id = ?)) ORDER BY position, created_at",
    ).all(sessionId) as unknown as TemplateRow[]).map(rowToView)
  }

  /** Enroll once, atomically. Never repairs deleted templates or rewrites edits. */
  ensureEvolutionDefault(sessionId: string, turn: number): void {
    if (!Number.isInteger(turn) || turn < 1 || this.#injectMaxEvery < EVOLUTION_EVERY) return
    if (this.db.prepare('SELECT 1 FROM evolution_defaults WHERE session_id = ?').get(sessionId) !== undefined) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT 1 FROM evolution_defaults WHERE session_id = ?').get(sessionId) === undefined) {
        const existing = this.db.prepare("SELECT id FROM templates WHERE name = ? AND (scope = 'global' OR (scope = 'session' AND session_id = ?)) LIMIT 1").get(EVOLUTION_NAME, sessionId) as { id: string } | undefined
        const template = existing === undefined ? this.create({
          name: EVOLUTION_NAME, content: EVOLUTION_CONTENT, scope: 'session', session_id: sessionId,
          description: `${EVOLUTION_SOURCE}@${EVOLUTION_VERSION}; auto-added once; edits/disabling/deletion are preserved`,
          inject_enabled: true, inject_every: EVOLUTION_EVERY, mode: 'visible',
        }) : undefined
        this.db.prepare('INSERT INTO evolution_defaults VALUES (?, ?, ?, ?, ?, ?)').run(
          sessionId, template?.id ?? null, EVOLUTION_SOURCE, EVOLUTION_VERSION, turn,
          template === undefined ? 'existing-template-preserved' : 'created',
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Gate only the managed row; user templates retain their original semantics. */
  listScheduled(sessionId: string, turn: number, evolutionEnabled: boolean): TemplateView[] {
    const managed = this.db.prepare("SELECT e.template_id, e.session_id, e.enrolled_turn FROM evolution_defaults e JOIN templates t ON t.id = e.template_id WHERE t.scope = 'global' OR (t.scope = 'session' AND t.session_id = ?)").all(sessionId) as unknown as { template_id: string, session_id: string, enrolled_turn: number }[]
    const globals = this.db.prepare("SELECT id FROM templates WHERE scope = 'global' AND name = ?").all(EVOLUTION_NAME) as unknown as { id: string }[]
    return this.listInjectable(sessionId).filter(template => {
      const enrollment = managed.find(row => row.template_id === template.id)
      if (enrollment === undefined) return true
      if (!evolutionEnabled) return false
      // An explicit make-global is the user's scope change; ordinary global schedule applies.
      if (template.scope === 'global') return true
      return turn > enrollment.enrolled_turn && globals.length === 0
    })
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
    const category = this.#validatedCategory(data.category, scope, sessionId)
    const inject = this.#validatedInject(data.inject_enabled, data.inject_every)
    const mode = validatedMode(data.mode)
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
      category,
      inject_enabled: inject.enabled ? 1 : 0,
      inject_every: inject.every,
      mode,
      // v9: a person's new template has no library version.
      version: null,
      created_at: now,
      updated_at: now,
    }
    this.db.prepare(
      'INSERT INTO templates (id, name, content, scope, session_id, description, position, category, inject_enabled, inject_every, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.content, row.scope, row.session_id, row.description, row.position, row.category, row.inject_enabled, row.inject_every, row.mode, row.created_at, row.updated_at)
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
    if (fields['category'] !== undefined) {
      fields['category'] = this.#validatedCategory(
        fields['category'] as string | null, row.scope, row.session_id,
      )
    }
    // Auto-inject facts resolve against the CURRENT row: an omitted field
    // keeps its stored value, and the pair is validated as a whole.
    const inject = this.#validatedInject(
      fields['inject_enabled'] as boolean | undefined,
      fields['inject_every'] as number | null | undefined,
      row.inject_enabled === 1,
      row.inject_every,
    )
    if (fields['mode'] !== undefined) fields['mode'] = validatedMode(fields['mode'] as TemplateInjectMode | undefined)
    const merged = { ...row, ...fields } as TemplateRow
    // v9: new content without a version is a person's edit — the stored version no longer describes it.
    if (fields['version'] !== undefined) {
      const v = fields['version']
      if (v !== null && (typeof v !== 'string' || v.length < 1 || v.length > 64)) throw new TemplateRuleError('version must be a string of 1..64 characters or null')
    } else if (fields['content'] !== undefined && fields['content'] !== row.content) merged.version = null
    merged.inject_enabled = inject.enabled ? 1 : 0
    merged.inject_every = inject.every
    merged.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.db.prepare(
      'UPDATE templates SET name = ?, content = ?, description = ?, position = ?, category = ?, inject_enabled = ?, inject_every = ?, mode = ?, version = ?, updated_at = ? WHERE id = ?',
    ).run(merged.name, merged.content, merged.description, merged.position, merged.category, merged.inject_enabled, merged.inject_every, merged.mode, merged.version ?? null, merged.updated_at, id)
    return rowToView(merged)
  }

  /** The card library, read-only (observer phase 1): what each card is and whether it is on, without its text. */
  library(): LibraryCard[] {
    const rows = this.db.prepare('SELECT id, name, version, scope, session_id, inject_enabled, inject_every, mode, content FROM templates ORDER BY scope, position, created_at')
      .all() as unknown as Array<{ id: string; name: string; version: string | null; scope: PromptScope; session_id: string | null; inject_enabled: number; inject_every: number | null; mode: TemplateInjectMode; content: string }>
    const versions = this.db.prepare('SELECT template_id, version, name, content_sha256, source, stored_at FROM template_versions ORDER BY stored_at, version')
      .all() as unknown as Array<{ template_id: string; version: string; name: string; content_sha256: string; source: string | null; stored_at: string }>
    const of = (id: string): StoredVersion[] => versions.filter(v => v.template_id === id).map(({ template_id: _t, name: _n, ...v }) => v)
    const cards: LibraryCard[] = rows.map(({ content, ...row }) => ({ ...row, active_version: row.version ?? null, inject_enabled: row.inject_enabled === 1, content_sha256: contentDigest(content), stored_versions: of(row.id), stored_only: false }))
    // A pack card the host does not have: listed with its stored versions, with no active text (nothing can send it).
    const known = new Set(rows.map(row => row.id))
    for (const id of [...new Set(versions.map(v => v.template_id))].filter(id => !known.has(id))) {
      const first = versions.find(v => v.template_id === id)!
      cards.push({ id, name: first.name, active_version: null, scope: 'global', session_id: null, inject_enabled: false, inject_every: null, mode: 'visible', content_sha256: null, stored_versions: of(id), stored_only: true })
    }
    return cards
  }

  /**
   * Import a versioned library pack (e.g. agent-atelier's seven cards) as a NEW stored version of each card, beside the
   * text the host uses now (workbench-market #883, observer phase 1: no behavior changes). The card's active version —
   * `templates.content` and its `version` pointer — is never touched, so whatever the schedule injects keeps injecting
   * the same text; switching a card to a stored version is phase 3's, on an owner decision card. A card is matched by id,
   * then by a global card of the same name; a card the host does not have is stored as a version only, with no template
   * row, so it shows in the library but nothing can send it. Without `apply` nothing is written.
   */
  importLibraryPack(pack: unknown, apply: boolean): LibraryImportPlan {
    const cards = parseLibraryPack(pack)
    const plan: LibraryImportPlan = { applied: false, version: cards.version, stored: [], unchanged: [] }
    const byId = this.db.prepare('SELECT id, name, version FROM templates WHERE id = ?')
    const byName = this.db.prepare("SELECT id, name, version FROM templates WHERE scope = 'global' AND name = ? ORDER BY created_at LIMIT 1")
    const existing = this.db.prepare('SELECT content_sha256 FROM template_versions WHERE template_id = ? AND version = ?')
    const insert = this.db.prepare(`INSERT INTO template_versions (template_id, version, name, content, content_sha256, source, stored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(template_id, version) DO UPDATE SET name = excluded.name, content = excluded.content,
      content_sha256 = excluded.content_sha256, source = excluded.source, stored_at = excluded.stored_at`)
    const work: Array<() => void> = []
    const at = new Date().toISOString()
    for (const card of cards.templates) {
      const found = (byId.get(card.id) ?? byName.get(card.name)) as { id: string; name: string; version: string | null } | undefined
      const templateId = found?.id ?? card.id
      const digest = contentDigest(card.content)
      const stored = existing.get(templateId, card.version) as { content_sha256: string } | undefined
      const row = { template_id: templateId, name: found?.name ?? card.name, version: card.version, active_version: found === undefined ? null : found.version ?? null, new_card: found === undefined }
      if (stored?.content_sha256 === digest) { plan.unchanged.push(row); continue }
      plan.stored.push(row)
      work.push(() => insert.run(templateId, card.version, card.name, card.content, digest, cards.source, at))
    }
    if (!apply) return plan
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const step of work) step(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { ...plan, applied: true }
  }

  /** Keep one text as a stored version of a card (a self-check template's previous write). Idempotent per version. */
  keepVersion(templateId: string, version: string, name: string, content: string, source: string): void {
    this.db.prepare(`INSERT INTO template_versions (template_id, version, name, content, content_sha256, source, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id, version) DO NOTHING`).run(templateId, version, name, content, contentDigest(content), source, new Date().toISOString())
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

  /** Delete one template; `false` when absent. A lesson's cue row goes with it (v11). */
  delete(id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deleted = this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0
      if (deleted) this.db.prepare('DELETE FROM lesson_cues WHERE template_id = ?').run(id)
      this.db.exec('COMMIT')
      return deleted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** List user categories: global ones plus one session's, ordered by name. */
  listCategories(sessionId?: string): CategoryView[] {
    return (this.db.prepare(
      "SELECT name, scope, session_id FROM categories WHERE session_id IS NULL OR session_id IS ? ORDER BY name",
    ).all(sessionId ?? null) as unknown as Array<{ name: string, scope: PromptScope, session_id: string | null }>)
      .map(row => ({ ...row }))
  }

  /** Create one category tab; name unique within its (scope, session) partition. */
  createCategory(data: CategoryCreateRequest): CategoryView {
    const scope: PromptScope = data.scope ?? 'global'
    const sessionId = data.session_id ?? null
    if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.length > NAME_MAX) {
      throw new TemplateRuleError(`category name must be a string of 1..${NAME_MAX} characters`)
    }
    if (scope === 'session' && (sessionId === null || sessionId === '')) {
      throw new TemplateRuleError("scope='session' requires session_id")
    }
    if (scope === 'global' && sessionId !== null) {
      throw new TemplateRuleError("scope='global' must not carry session_id")
    }
    const clash = this.db.prepare(
      'SELECT name FROM categories WHERE scope = ? AND session_id IS ? AND name = ?',
    ).get(scope, sessionId, data.name)
    if (clash !== undefined) {
      throw new TemplateRuleError(`category '${data.name}' already exists in scope ${scope}`)
    }
    this.db.prepare('INSERT INTO categories (name, scope, session_id) VALUES (?, ?, ?)')
      .run(data.name, scope, sessionId)
    return { name: data.name, scope, session_id: sessionId }
  }

  /** Delete one category tab; its templates fall back to the default tab (category = NULL). */
  deleteCategory(name: string, scope: string, sessionId?: string | null): boolean {
    const existing = this.db.prepare(
      'SELECT name FROM categories WHERE scope = ? AND session_id IS ? AND name = ?',
    ).get(scope, sessionId ?? null, name)
    if (existing === undefined) return false
    this.db.exec('BEGIN')
    try {
      this.db.prepare("UPDATE templates SET category = NULL WHERE category = ? AND scope = ? AND session_id IS ?")
        .run(name, scope, sessionId ?? null)
      this.db.prepare('DELETE FROM categories WHERE scope = ? AND session_id IS ? AND name = ?')
        .run(scope, sessionId ?? null, name)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return true
  }

  /**
   * Validate a template's category against its scope partition: null is
   * always fine (the default tab); a name must exist as a category of the
   * same scope partition. Returns the normalized value.
   */
  #validatedCategory(category: string | null | undefined, scope: PromptScope, sessionId: string | null): string | null {
    if (category === undefined || category === null || category === '') return null
    const existing = this.db.prepare(
      'SELECT name FROM categories WHERE scope = ? AND session_id IS ? AND name = ?',
    ).get(scope, sessionId, category)
    if (existing === undefined) {
      throw new TemplateRuleError(`category '${category}' does not exist in scope ${scope}`)
    }
    return category
  }

  /**
   * Validate the auto-inject pair as a whole. Omitted fields fall back to
   * the current row's values (create has none); enabling requires a whole
   * interval within 1..injectMaxEvery, while disabling may keep the old
   * interval so re-enabling needs no retyping.
   */
  #validatedInject(
    enabled: boolean | undefined,
    every: number | null | undefined,
    currentEnabled = false,
    currentEvery: number | null = null,
  ): { enabled: boolean, every: number | null } {
    const resolvedEnabled = enabled ?? currentEnabled
    const resolvedEvery = every === undefined ? currentEvery : every
    if (resolvedEvery !== null && (!Number.isInteger(resolvedEvery) || resolvedEvery < 1 || resolvedEvery > this.#injectMaxEvery)) {
      throw new TemplateRuleError(`inject_every must be an integer between 1 and ${this.#injectMaxEvery}`)
    }
    if (resolvedEnabled && resolvedEvery === null) {
      throw new TemplateRuleError('inject_every is required when inject is enabled')
    }
    return { enabled: resolvedEnabled, every: resolvedEvery }
  }
}

/** One card of the library face (observer phase 1): identity, version, scope and schedule, and a digest of the text. */
export interface LibraryCard {
  readonly id: string
  readonly name: string
  /** The version the host uses now (the active pointer); null for a person's own text or a stored-only card. */
  readonly active_version: string | null
  readonly scope: PromptScope
  readonly session_id: string | null
  readonly inject_enabled: boolean
  readonly inject_every: number | null
  readonly mode: TemplateInjectMode
  /** Digest of the active text; null for a stored-only card. */
  readonly content_sha256: string | null
  /** Versions stored beside the active text (library packs); switching to one is phase 3's. */
  readonly stored_versions: readonly StoredVersion[]
  /** A pack card this host has no template for: stored, never sent. */
  readonly stored_only: boolean
}

/** One stored version of a card. */
export interface StoredVersion { readonly version: string; readonly content_sha256: string; readonly source: string | null; readonly stored_at: string }

/** What a library pack import stores (or would store); it never changes an active version. */
export interface LibraryImportPlan {
  readonly applied: boolean
  readonly version: string
  readonly stored: Array<{ template_id: string; name: string; version: string; active_version: string | null; new_card: boolean }>
  readonly unchanged: Array<{ template_id: string; name: string; version: string; active_version: string | null; new_card: boolean }>
}

/** A library pack: `{ format: 'dsh-prompt-templates-library', version, templates: [{ id, name, content, … }] }`. */
interface LibraryPackCard { id: string; name: string; content: string; description: string | null; position: number; inject_every: number | null; mode: TemplateInjectMode; version: string }

function parseLibraryPack(pack: unknown): { version: string; source: string | null; templates: LibraryPackCard[] } {
  const p = pack as { format?: unknown; version?: unknown; templates?: unknown } | null
  if (p === null || typeof p !== 'object' || p.format !== 'dsh-prompt-templates-library') throw new TemplateRuleError("a library pack has format 'dsh-prompt-templates-library'")
  if (typeof p.version !== 'string' || p.version.length < 1 || p.version.length > 64) throw new TemplateRuleError('a library pack names its version (1..64 characters)')
  if (!Array.isArray(p.templates) || p.templates.length < 1 || p.templates.length > 100) throw new TemplateRuleError('a library pack carries 1..100 templates')
  const version = p.version
  const templates = p.templates.map((raw, index) => {
    const t = raw as Record<string, unknown>
    if (typeof t['id'] !== 'string' || typeof t['name'] !== 'string' || typeof t['content'] !== 'string' || t['name'].length < 1 || t['name'].length > NAME_MAX) throw new TemplateRuleError(`library card ${String(index)} needs id, name and content`)
    const every = t['inject_every']
    return {
      id: t['id'], name: t['name'], content: t['content'],
      description: typeof t['description'] === 'string' ? t['description'] : null,
      position: Number.isInteger(t['position']) ? t['position'] as number : index,
      inject_every: Number.isInteger(every) && (every as number) >= 1 ? every as number : null,
      mode: validatedMode(t['mode'] as TemplateInjectMode | undefined),
      version: typeof t['version'] === 'string' && t['version'] !== '' ? t['version'] : version,
    }
  })
  const src = (p as { source?: { package?: unknown; version?: unknown; commit?: unknown } }).source
  const source = src !== undefined && typeof src.package === 'string' ? `${src.package}@${String(src.version ?? '')}${typeof src.commit === 'string' ? `#${src.commit.slice(0, 12)}` : ''}` : null
  return { version, source, templates }
}

/** Map one database row to the wire view (field names are already snake_case). */
function rowToView(row: TemplateRow): TemplateView {
  return { ...row, inject_enabled: row.inject_enabled === 1 }
}

/** Validate the injection delivery mode; omitted or null keeps the default. */
function validatedMode(mode: TemplateInjectMode | undefined): TemplateInjectMode {
  if (mode === undefined || mode === null) return 'inject'
  if (mode !== 'inject' && mode !== 'visible') {
    throw new TemplateRuleError(`mode must be 'inject' or 'visible' (got ${String(mode)})`)
  }
  return mode
}
