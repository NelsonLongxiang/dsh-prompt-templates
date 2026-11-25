/**
 * 体会 (lessons), phase 1 of docs/spec-lesson-inject.md. After an experience a session writes down one or two sentences
 * (what hurt, what to do first next time); when the session later meets the same situation, the sentence comes back.
 *
 *   - Write. When an experience settles — an event episode signalled `changed`, a target that failed later succeeded, or
 *     the wrap-up self-check concluded `done` — the next step carries one short digest prompt. `lesson_write` stores the
 *     sentence as one of the session's own session templates (category 体会, name 体会·N, never scheduled). The cue it is
 *     recalled by is bound by the plugin from the real experience, never taken from the session's arguments.
 *   - Read. A later tool result matching a lesson's cue queues it; the next step, before the next model decision,
 *     carries it back.
 *
 * Phase 2 adds pinned lessons: the owner pins a few (never the session), and they are loaded once at the first step after
 * the session starts, resumes or is compacted (not after `clear`).
 *
 * On unless `lessons.enabled` is false (owner decision 2026-11-21). Every recall is one RSI round (owner 2026-11-21:
 * 「每次唤起都必须有变化，写入或更新，每次调用记成一轮 RSI」): the recalled lesson binds where it applies, and the session
 * must then change its lessons — rewrite the recalled one (`replace`) or write a new one. The recall opens a round in
 * the lesson log; the next lesson_write closes it (`round-closed`, origin `updated` or `written`); a round still open
 * two turns later is logged `round-missed`. A lesson grants no new permission.
 *
 * Types (owner 2026-11-21): every lesson is tagged with one type — 收 放 找 落 验 记 续 (the autonomy chain), or a type
 * the session proposed and the owner approved — and a session keeps one lesson per type. Writing a type that already
 * has a lesson soft-overwrites it: the old text is kept as a stored version and logged `superseded` (soft-deleted: no
 * longer shown or recalled, still in the history and the timeline). `lesson_timeline` returns the recent history.
 *
 * @module @nelsonlongxiang/dsh-prompt-templates/lessons
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { extractFeatures } from './event-features.ts'
import type { ObservationFeatures, ToolOutcomeProbe } from './event-features.ts'
import { contentDigest } from './interventions.ts'
import type { TemplateStore } from './store.ts'
import { objectParameters, registerWhenToolsReady, withOutput } from './tool-registry.ts'

/** Category tab and name prefix of a session's lessons. */
export const LESSON_CATEGORY = '体会'
export const LESSON_PREFIX = '体会·'
/** Length of one lesson: one or two sentences. */
export const LESSON_MAX = 160
/** Consecutive unanswered digest prompts after which prompting slows down. */
export const PAUSE_AFTER = 3
/** Tools whose own results never become a lesson's cue. */
export const LESSON_SELF_TOOLS: readonly string[] = ['lesson_write', 'lesson_none', 'lesson_keep', 'lesson_timeline', 'lesson_type_propose', 'selfcheck_write', 'selfcheck_conclude']
/** Total characters of the pinned lessons loaded at one start (phase 2). */
export const PINNED_MAX_CHARS = 400
/** §5.16: the lesson list handed over at a start, resume or compaction is at most this many characters. */
export const LESSON_LIST_MAX_CHARS = 1600
/** Session starts that load pinned lessons; `clear` is the user asking for a fresh start (spec §10, decision 4). */
export const PINNED_SOURCES: readonly string[] = ['startup', 'resume', 'compact']
/** Failed targets remembered per session for the failed-then-succeeded signal. */
const FAILURES_KEPT = 50

const LESSON_NAME = /^体会·(.+)$/
const LEGACY_INDEX = /^\d+$/

/** The built-in lesson types: the autonomy chain 收→放→找→落→验→记→续, each with the one-line meaning the model sees. */
export const BUILTIN_LESSON_TYPES: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
  { name: '收', description: '边界：红线、属主保留的决定、不该碰的东西' },
  { name: '放', description: '授权内自己定、不等确认的事' },
  { name: '找', description: '查原因：取实际输出、读到出问题的那一层、排除别的解释' },
  { name: '落', description: '动手：挑一项做到可验证' },
  { name: '验', description: '验证：证据、门禁、NOT_RUN 与未知' },
  { name: '记', description: '记录：写回提交、PR、现状' },
  { name: '续', description: '失败或受阻后：查因、回退、转做别的' },
]
/** A proposed type name: 1..8 letters or digits, not a digit string (those are legacy numbered lessons). */
const TYPE_NAME = /^[\p{L}\p{N}]{1,8}$/u
/** The panel category whose scheduled cards open a card round when injected (owner 2026-11-21). */
export const WORKSHOP_CATEGORY = '工坊'
const CARD_KEY = 'card:'
/** A no-entry reason: 1..120 characters. */
const NONE_MAX = 120
/** A verified keep's evidence (owner 2026-11-21): long enough to name how it was checked, one line. */
export const KEEP_MIN = 10
export const KEEP_MAX = 200
/** Churn hint (owner 2026-11-21): this many rewrites of one type in a row, each this similar to the text it replaced. */
export const CHURN_REWRITES = 3
export const CHURN_SIMILARITY = 0.8

/** Timeline entries returned at most. */
export const TIMELINE_MAX = 100
const LESSON_VERSION = /^lesson-r(\d+)$/
/** Closing line of a digest prompt (owner 2026-11-21: standing requirement, not optional). */
export const DIGEST_BINDING_LINE = '本提示由属主安装的插件发出，适用即须执行；在已有授权内推进，属主当下的指令优先。'
/** Owner 2026-11-21: know what a good lesson is before writing one. Appended to every text that asks for a lesson. */
export const LESSONS_MUST_READ_LINE = '必读：本会话第一次写体会前或压缩后，必须先用 skill 工具加载 agent-atelier，按返回的基础目录读 references/lessons.md（我们要什么样的体会）；回复写明读了哪几处，读不到如实写明，不得凭本提示代替。'

/** Deployment switches and budgets (`lessons` in the plugin config). */
export interface LessonsConfig {
  readonly enabled: boolean
  readonly mode: 'inject' | 'visible'
  readonly maxPerSession: number
  readonly digestCooldownTurns: number
  readonly recallCooldownTurns: number
  readonly maxRecallChars: number
  /** Pinned lessons per session (phase 2); the owner pins on the panel, the session with lesson_pin. */
  readonly maxPinned: number
}

export const DEFAULT_LESSONS_CONFIG: LessonsConfig = {
  enabled: true,
  mode: 'inject',
  maxPerSession: 20,
  digestCooldownTurns: 10,
  recallCooldownTurns: 20,
  maxRecallChars: 300,
  maxPinned: 3,
}

/** v11: cue, origin and recall state of each lesson, and what the plugin did. Lesson text stays in the template. */
export const LESSONS_SQL = `CREATE TABLE IF NOT EXISTS lesson_cues (
  template_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  stable_fingerprint TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  rule_id TEXT,
  origin TEXT NOT NULL,
  origin_ref TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_recalled_turn INTEGER,
  recall_count INTEGER NOT NULL DEFAULT 0,
  created_turn INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_cues_session ON lesson_cues (session_id);
CREATE TABLE IF NOT EXISTS lesson_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  template_id TEXT,
  turn INTEGER,
  origin TEXT,
  origin_ref TEXT,
  content_sha256 TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_log_session ON lesson_log (session_id, seq)`

/**
 * Calls that matched a lesson's cue and how they ended (B4a, owner 2026-11-21). Kept apart from lesson_log so frequent
 * hits never crowd the round bookkeeping out of its windows. Created idempotently at every open (no schema bump).
 */
export const LESSON_HITS_SQL = `CREATE TABLE IF NOT EXISTS lesson_hits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  call_id TEXT,
  turn INTEGER,
  failed INTEGER NOT NULL,
  after_recall INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_hits_template ON lesson_hits (template_id, seq)`

/**
 * Evidence a session attached to one lesson write (B2b, owner 2026-11-21): a PR or CI link, a command and its result,
 * a ygl claim id. Keyed by the lesson and the digest of the text it backs, so the timeline can show it next to that
 * write. Created idempotently at every open (no schema bump).
 */
export const LESSON_EVIDENCE_SQL = `CREATE TABLE IF NOT EXISTS lesson_evidence (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  evidence TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_evidence_template ON lesson_evidence (template_id, content_sha256)`
/** Evidence on a lesson write: optional, one line, at most this many characters. */
export const EVIDENCE_MAX = 200

/** §5.16: whether a lesson came from getting something wrong or right (optional on lesson_write). */
export type LessonOutcomeTag = 'wrong' | 'right'
/** The outcome the session gave one lesson write, keyed like its evidence. Created idempotently at every open. */
export const LESSON_OUTCOME_SQL = `CREATE TABLE IF NOT EXISTS lesson_outcomes (
  template_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (template_id, content_sha256)
)`

/** One side of a lesson's recurrence: calls in the same situation, and how many of them failed. */
export interface HitCount { readonly hits: number; readonly fails: number }
/** Recurrence of a lesson's situation before its first recall and after it (B4a). */
export interface Recurrence { readonly before: HitCount; readonly after: HitCount }

/** Session-proposed lesson types and the owner's decision. Created idempotently at every open (no schema bump). */
export const LESSON_TYPES_SQL = `CREATE TABLE IF NOT EXISTS lesson_types (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (session_id, name)
)`

/** Where a lesson came from: the experience the digest prompt followed, or the last call when there was none. */
export type LessonOrigin = 'changed' | 'recovered' | 'selfcheck-done' | 'last-call' | 'none'

/** The situation a lesson is recalled in. */
export interface CueFeatures {
  readonly tool_name: string
  readonly stable_fingerprint: string
  readonly target_fingerprint: string
  readonly rule_id: string | null
}

/** One settled experience a digest prompt follows; bound to the lesson written in answer. */
export interface DigestContext extends CueFeatures {
  readonly origin: Exclude<LessonOrigin, 'none'>
  readonly origin_ref: string | null
  /** Redacted example shown in the prompt; empty when there is none. */
  readonly summary: string
}

export interface CueRow extends CueFeatures {
  readonly template_id: string
  readonly session_id: string
  readonly origin: LessonOrigin
  readonly origin_ref: string | null
  readonly pinned: number
  readonly last_recalled_turn: number | null
  readonly recall_count: number
  readonly created_turn: number
  readonly created_at: string
}

export type LessonLogKind = 'prompted' | 'written' | 'superseded' | 'recalled' | 'pinned-loaded' | 'card-injected' | 'round-closed' | 'round-missed' | 'round-na' | 'type-proposed' | 'type-decided' | 'round-verdict' | 'self-pinned' | 'self-unpinned' | 'owner-unpinned' | 'delivered'

/** How a recall round ended: the recalled lesson rewritten, a new lesson written, or nothing by the deadline. */
export type RoundOutcome = 'updated' | 'written' | 'none'

/** Turns after the recall turn within which a lesson write still closes the round. */
export const ROUND_GRACE_TURNS = 1

export interface LessonLogRow {
  readonly seq: number
  readonly session_id: string
  readonly kind: LessonLogKind
  readonly template_id: string | null
  readonly turn: number | null
  readonly origin: string | null
  readonly origin_ref: string | null
  readonly content_sha256: string | null
  readonly at: string
}

/** One session-proposed lesson type. */
export interface LessonTypeRow {
  readonly session_id: string
  readonly name: string
  readonly description: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly proposed_at: string
  readonly decided_at: string | null
}

/** Per-session runtime state; losing it on restart only drops a pending prompt or recall. */
export interface LessonState {
  turn?: number
  last?: { readonly features: ObservationFeatures, readonly callId: string }
  readonly failures: Map<string, string>
  /** A failed-then-succeeded target not yet prompted for. */
  pending?: DigestContext
  /** The experience the last digest prompt followed; bound to the next lesson written. */
  context?: DigestContext
  /** Set by `agent/created` (startup, resume, compact): the next step hands over the session's lessons (§5.16). */
  deliverDue?: string
}

export function newLessonState(): LessonState {
  return { failures: new Map() }
}

/** Durable lesson state over the plugin's SQLite handle. */
export class LessonStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  cue(templateId: string): CueRow | undefined {
    return this.#db.prepare('SELECT * FROM lesson_cues WHERE template_id = ?').get(templateId) as CueRow | undefined
  }

  /** Cues of the lessons that are still this session's own session templates (a promoted one is not recalled here). */
  cues(sessionId: string): CueRow[] {
    return this.#db.prepare(`SELECT c.* FROM lesson_cues c JOIN templates t ON t.id = c.template_id
      WHERE c.session_id = ? AND t.scope = 'session' AND t.session_id = c.session_id ORDER BY c.created_at, c.template_id`)
      .all(sessionId) as unknown as CueRow[]
  }

  addCue(templateId: string, sessionId: string, cue: CueFeatures, origin: LessonOrigin, originRef: string | null, turn: number): void {
    this.#db.prepare(`INSERT INTO lesson_cues (template_id, session_id, tool_name, stable_fingerprint, target_fingerprint, rule_id,
      origin, origin_ref, created_turn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(templateId, sessionId, cue.tool_name, cue.stable_fingerprint, cue.target_fingerprint, cue.rule_id, origin, originRef, turn, new Date().toISOString())
  }

  /** Rebind a lesson's cue to the experience of its latest write (a soft overwrite). */
  updateCue(templateId: string, cue: CueFeatures, origin: LessonOrigin, originRef: string | null, turn: number): void {
    this.#db.prepare(`UPDATE lesson_cues SET tool_name = ?, stable_fingerprint = ?, target_fingerprint = ?, rule_id = ?, origin = ?, origin_ref = ?,
      created_turn = ? WHERE template_id = ?`).run(cue.tool_name, cue.stable_fingerprint, cue.target_fingerprint, cue.rule_id, origin, originRef, turn, templateId)
  }

  /** A session's proposed types, oldest first. */
  types(sessionId: string): LessonTypeRow[] {
    return this.#db.prepare('SELECT * FROM lesson_types WHERE session_id = ? ORDER BY proposed_at, name').all(sessionId) as unknown as LessonTypeRow[]
  }

  /** Record a proposal; an existing proposal of the same name is left as it is. Returns false when it already existed. */
  proposeType(sessionId: string, name: string, description: string): boolean {
    return Number(this.#db.prepare(`INSERT INTO lesson_types (session_id, name, description, status, proposed_at) VALUES (?, ?, ?, 'pending', ?)
      ON CONFLICT(session_id, name) DO NOTHING`).run(sessionId, name, description, new Date().toISOString()).changes) > 0
  }

  /** The owner approves or rejects a proposal. Returns false when there is no such proposal. */
  decideType(sessionId: string, name: string, approved: boolean): boolean {
    return Number(this.#db.prepare('UPDATE lesson_types SET status = ?, decided_at = ? WHERE session_id = ? AND name = ?')
      .run(approved ? 'approved' : 'rejected', new Date().toISOString(), sessionId, name).changes) > 0
  }

  /** The highest N among a lesson's stored lesson-rN versions (0 when none), so a new label never collides with history. */
  maxLessonVersion(templateId: string): number {
    const rows = this.#db.prepare("SELECT version FROM template_versions WHERE template_id = ? AND version LIKE 'lesson-r%'").all(templateId) as Array<{ version: string }>
    return rows.reduce((max, row) => Math.max(max, Number(LESSON_VERSION.exec(row.version)?.[1] ?? 0)), 0)
  }

  /** How many times a lesson was written (its lesson-rN labels follow this count, so they never repeat). */
  writes(templateId: string): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM lesson_log WHERE template_id = ? AND kind = 'written'").get(templateId) as { n: number }).n)
  }

  /** The stored text of one version of a lesson, by its digest (a soft-deleted or earlier text). */
  versionText(templateId: string, sha256: string): string | undefined {
    const row = this.#db.prepare('SELECT content FROM template_versions WHERE template_id = ? AND content_sha256 = ? LIMIT 1').get(templateId, sha256) as { content: string } | undefined
    return row?.content
  }

  /** Pin or unpin a lesson (the owner's route). Returns false when it has no cue row. */
  setPinned(templateId: string, pinned: boolean): boolean {
    return Number(this.#db.prepare('UPDATE lesson_cues SET pinned = ? WHERE template_id = ?').run(pinned ? 1 : 0, templateId).changes) > 0
  }

  markRecalled(templateId: string, turn: number): void {
    this.#db.prepare('UPDATE lesson_cues SET last_recalled_turn = ?, recall_count = recall_count + 1 WHERE template_id = ?').run(turn, templateId)
  }

  record(row: Omit<LessonLogRow, 'seq' | 'at'>): void {
    this.#db.prepare(`INSERT INTO lesson_log (session_id, kind, template_id, turn, origin, origin_ref, content_sha256, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.session_id, row.kind, row.template_id, row.turn, row.origin, row.origin_ref, row.content_sha256, new Date().toISOString())
  }

  log(sessionId: string, limit = 100): LessonLogRow[] {
    return this.#db.prepare('SELECT * FROM (SELECT * FROM lesson_log WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(sessionId, Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as LessonLogRow[]
  }

  lastPromptTurn(sessionId: string): number | undefined {
    const row = this.#db.prepare("SELECT MAX(turn) AS turn FROM lesson_log WHERE session_id = ? AND kind = 'prompted'").get(sessionId) as { turn: number | null }
    return row.turn ?? undefined
  }

  /** Digest prompts since the session last wrote a lesson. */
  promptsSinceWrite(sessionId: string): number {
    const written = this.#db.prepare("SELECT MAX(seq) AS seq FROM lesson_log WHERE session_id = ? AND kind = 'written'").get(sessionId) as { seq: number | null }
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM lesson_log WHERE session_id = ? AND kind = 'prompted' AND seq > ?")
      .get(sessionId, written.seq ?? 0) as { n: number }
    return Number(row.n)
  }

  prompted(sessionId: string, originRef: string): boolean {
    return this.#db.prepare("SELECT 1 FROM lesson_log WHERE session_id = ? AND kind = 'prompted' AND origin_ref = ? LIMIT 1").get(sessionId, originRef) !== undefined
  }

  /** Recall rounds of a session not yet closed or missed, oldest first. A round is keyed by its recall row's seq. */
  openRounds(sessionId: string): LessonLogRow[] {
    return this.#db.prepare(`SELECT r.* FROM lesson_log r WHERE r.session_id = ? AND r.kind = 'recalled' AND NOT EXISTS (
      SELECT 1 FROM lesson_log c WHERE c.session_id = r.session_id AND c.kind IN ('round-closed', 'round-missed') AND c.origin_ref = CAST(r.seq AS TEXT))
      ORDER BY r.seq`).all(sessionId) as unknown as LessonLogRow[]
  }

  /** Card rounds of a session not yet closed or missed, oldest first: one per injection turn, keyed `card:<turn>`. */
  openCardRounds(sessionId: string): Array<{ key: string; turn: number | null; seq: number }> {
    return this.#db.prepare(`SELECT origin_ref AS key, MIN(turn) AS turn, MIN(seq) AS seq FROM lesson_log r
      WHERE r.session_id = ? AND r.kind = 'card-injected' AND NOT EXISTS (
        SELECT 1 FROM lesson_log c WHERE c.session_id = r.session_id AND c.kind IN ('round-closed', 'round-missed', 'round-na') AND c.origin_ref = r.origin_ref)
      GROUP BY origin_ref ORDER BY MIN(seq)`).all(sessionId) as unknown as Array<{ key: string; turn: number | null; seq: number }>
  }

  /** Per workshop card in a session: injections, and how their rounds ended (lesson written, no entry, missed). */
  cardStats(sessionId: string): Array<{ template_id: string; name: string; injected: number; lessons: number; none: number; missed: number; na: number; recurrence: HitCount }> {
    const injected = this.#db.prepare("SELECT template_id, origin, origin_ref FROM lesson_log WHERE session_id = ? AND kind = 'card-injected' ORDER BY seq")
      .all(sessionId) as Array<{ template_id: string; origin: string | null; origin_ref: string }>
    const endings = new Map((this.#db.prepare("SELECT kind, template_id, origin, origin_ref FROM lesson_log WHERE session_id = ? AND kind IN ('round-closed', 'round-missed', 'round-na') AND origin_ref LIKE 'card:%'")
      .all(sessionId) as Array<{ kind: string; template_id: string | null; origin: string | null; origin_ref: string }>).map(row => [row.origin_ref, row]))
    type Stat = { template_id: string; name: string; injected: number; lessons: number; none: number; missed: number; na: number; recurrence: HitCount; lessonIds: Set<string> }
    const out = new Map<string, Stat>()
    for (const row of injected) {
      const stat = out.get(row.template_id) ?? { template_id: row.template_id, name: (row.origin ?? '').split('@')[0]!, injected: 0, lessons: 0, none: 0, missed: 0, na: 0, recurrence: { hits: 0, fails: 0 }, lessonIds: new Set<string>() }
      stat.injected += 1
      const end = endings.get(row.origin_ref)
      if (end?.kind === 'round-missed') stat.missed += 1
      else if (end?.kind === 'round-na') stat.na += 1
      else if (end !== undefined && (end.origin ?? '').startsWith('none')) stat.none += 1
      else if (end !== undefined) { stat.lessons += 1; if (end.template_id !== null) stat.lessonIds.add(end.template_id) }
      out.set(row.template_id, stat)
    }
    // B4a: the card's yield seen through its lessons — how their situations went after they were recalled.
    return [...out.values()].map(({ lessonIds, ...stat }) => {
      let hits = 0, fails = 0
      for (const id of lessonIds) { const after = this.recurrence(id).after; hits += after.hits; fails += after.fails }
      return { ...stat, recurrence: { hits, fails } }
    })
  }

  /** One lesson's recall rounds: how many were opened, closed by a write, and missed. */
  rounds(templateId: string): { opened: number; closed: number; missed: number; kept: number } {
    const count = (kind: string): number => Number((this.#db.prepare('SELECT COUNT(*) AS n FROM lesson_log WHERE template_id = ? AND kind = ?').get(templateId, kind) as { n: number }).n)
    const kept = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM lesson_log WHERE template_id = ? AND kind = 'round-closed' AND origin LIKE 'kept:%'").get(templateId) as { n: number }).n)
    return { opened: count('recalled'), closed: count('round-closed'), missed: count('round-missed'), kept }
  }

  /** Whether the owner ever unpinned this lesson (then the session cannot pin it back). */
  ownerUnpinned(templateId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM lesson_log WHERE template_id = ? AND kind = 'owner-unpinned' LIMIT 1").get(templateId) !== undefined
  }

  /** The lesson's latest recall row (open, closed or missed), if it was ever recalled. */
  latestRecall(templateId: string): LessonLogRow | undefined {
    return this.#db.prepare("SELECT * FROM lesson_log WHERE template_id = ? AND kind = 'recalled' ORDER BY seq DESC LIMIT 1").get(templateId) as unknown as LessonLogRow | undefined
  }

  /** B3b: external verdicts the owner attached to this lesson's rounds, and the latest one. */
  verdicts(templateId: string): VerdictSummary {
    const rows = this.#db.prepare("SELECT origin, at FROM lesson_log WHERE template_id = ? AND kind = 'round-verdict' ORDER BY seq").all(templateId) as Array<{ origin: string | null; at: string }>
    let pass = 0, fail = 0
    let latest: VerdictSummary['latest'] = null
    for (const row of rows) {
      const parsed = parseVerdict(row.origin)
      if (parsed === null) continue
      if (parsed.verdict === 'pass') pass += 1; else fail += 1
      latest = { ...parsed, at: row.at }
    }
    return { pass, fail, latest }
  }

  /** Note one call that matched a lesson's cue: whether it failed, and whether the lesson had been recalled by then. */
  recordHit(sessionId: string, templateId: string, callId: string, turn: number | null, failed: boolean, afterRecall: boolean): void {
    this.#db.prepare('INSERT INTO lesson_hits (session_id, template_id, call_id, turn, failed, after_recall, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, templateId, callId, turn, failed ? 1 : 0, afterRecall ? 1 : 0, new Date().toISOString())
  }

  /**
   * How the lesson's situation went before its first recall and after it: matching calls and failures. The call that
   * triggers a recall is noted before the recall is delivered, so it counts as before.
   */
  recurrence(templateId: string): Recurrence {
    const rows = this.#db.prepare('SELECT after_recall, COUNT(*) AS hits, COALESCE(SUM(failed), 0) AS fails FROM lesson_hits WHERE template_id = ? GROUP BY after_recall')
      .all(templateId) as Array<{ after_recall: number; hits: number; fails: number }>
    const side = (after: number): HitCount => {
      const row = rows.find(r => Number(r.after_recall) === after)
      return { hits: Number(row?.hits ?? 0), fails: Number(row?.fails ?? 0) }
    }
    return { before: side(0), after: side(1) }
  }

  /** Attach evidence to one lesson write (the text with this digest). */
  addEvidence(sessionId: string, templateId: string, contentSha256: string, evidence: string): void {
    this.#db.prepare('INSERT INTO lesson_evidence (session_id, template_id, content_sha256, evidence, at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, templateId, contentSha256, evidence, new Date().toISOString())
  }

  /** The evidence attached to the write of this text, if any (the latest when the same text was written again). */
  evidence(templateId: string, contentSha256: string): string | undefined {
    const row = this.#db.prepare('SELECT evidence FROM lesson_evidence WHERE template_id = ? AND content_sha256 = ? ORDER BY seq DESC LIMIT 1').get(templateId, contentSha256) as { evidence: string } | undefined
    return row?.evidence
  }

  /** Record the outcome the session gave one lesson write (§5.16). */
  setOutcome(templateId: string, contentSha256: string, outcome: LessonOutcomeTag): void {
    this.#db.prepare('INSERT INTO lesson_outcomes (template_id, content_sha256, outcome, at) VALUES (?, ?, ?, ?) ON CONFLICT(template_id, content_sha256) DO UPDATE SET outcome = excluded.outcome, at = excluded.at')
      .run(templateId, contentSha256, outcome, new Date().toISOString())
  }

  /** The outcome of the write of this text, if the session gave one. */
  outcome(templateId: string, contentSha256: string): LessonOutcomeTag | null {
    const row = this.#db.prepare('SELECT outcome FROM lesson_outcomes WHERE template_id = ? AND content_sha256 = ?').get(templateId, contentSha256) as { outcome: string } | undefined
    return row?.outcome === 'wrong' || row?.outcome === 'right' ? row.outcome : null
  }

  /** The latest verified keep of the current text (after its last write), if any: its evidence. */
  latestKeep(templateId: string): string | undefined {
    const row = this.#db.prepare(`SELECT origin FROM lesson_log WHERE template_id = ? AND kind = 'round-closed' AND origin LIKE 'kept:%'
      AND seq > COALESCE((SELECT MAX(seq) FROM lesson_log WHERE template_id = ? AND kind = 'written'), 0) ORDER BY seq DESC LIMIT 1`).get(templateId, templateId) as { origin: string } | undefined
    return row === undefined ? undefined : row.origin.slice(5)
  }

  /** Content digests of one lesson's writes, oldest first. */
  writtenDigests(templateId: string): string[] {
    return (this.#db.prepare("SELECT content_sha256 FROM lesson_log WHERE template_id = ? AND kind = 'written' ORDER BY seq").all(templateId) as Array<{ content_sha256: string | null }>)
      .flatMap(row => row.content_sha256 === null ? [] : [row.content_sha256])
  }

  countAt(sessionId: string, kind: LessonLogKind, turn: number): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM lesson_log WHERE session_id = ? AND kind = ? AND turn = ?').get(sessionId, kind, turn) as { n: number }
    return Number(row.n)
  }
}

/** One lesson as the read route and the recall see it. */
export interface LessonView {
  readonly id: string
  /** What follows 体会·: the type, or the number of a legacy (untyped) lesson. */
  readonly key: string
  /** The lesson's type; null for a legacy numbered lesson. */
  readonly type: string | null
  /** The number of a legacy numbered lesson; null for a typed one. */
  readonly index: number | null
  readonly content: string
  readonly version: string | null
  /** §5.16: wrong or right as the session tagged the current text; null when untagged (and for old lessons). */
  readonly outcome: LessonOutcomeTag | null
}

/** A session's lessons: its own session templates named 体会·<type> (built-in order, then proposed), then legacy 体会·N. */
export function lessonsOf(store: TemplateStore, sessionId: string): LessonView[] {
  const order = (lesson: LessonView): number => {
    if (lesson.type === null) return 1000 + (lesson.index ?? 0)
    const builtin = BUILTIN_LESSON_TYPES.findIndex(t => t.name === lesson.type)
    return builtin >= 0 ? builtin : 100
  }
  return store.list('session', sessionId).flatMap((t): LessonView[] => {
    const m = LESSON_NAME.exec(t.name)
    if (m === null) return []
    const key = m[1]!
    const legacy = LEGACY_INDEX.test(key)
    return [{ id: t.id, key, type: legacy ? null : key, index: legacy ? Number(key) : null, content: t.content, version: t.version ?? null, outcome: store.lessons.outcome(t.id, contentDigest(t.content)) }]
  }).sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key))
}

/** The types this session may write: the built-ins plus the proposals the owner approved. */
export function allowedTypes(store: TemplateStore, sessionId: string): string[] {
  return [...BUILTIN_LESSON_TYPES.map(t => t.name), ...store.lessons.types(sessionId).filter(t => t.status === 'approved').map(t => t.name)]
}

type ProposeResult = { ok: true; name: string; status: LessonTypeRow['status'] } | { ok: false; code: string; error: string }

/** The session proposes a new lesson type; it is usable only after the owner approves it on the panel. */
export function proposeLessonType(store: TemplateStore, sessionId: string, name: string, description: string, turn: number | null): ProposeResult {
  const type = name.trim()
  const why = oneLineText(description)
  if (!TYPE_NAME.test(type) || LEGACY_INDEX.test(type)) return { ok: false, code: 'name', error: 'a type name is 1..8 letters or digits, not a number' }
  if (BUILTIN_LESSON_TYPES.some(t => t.name === type)) return { ok: false, code: 'builtin', error: `${type} is a built-in type; write it directly` }
  if (why === '' || [...why].length > 120) return { ok: false, code: 'description', error: 'say in 1..120 characters what lessons of this type are about and why the built-in types do not fit' }
  const created = store.lessons.proposeType(sessionId, type, why)
  const row = store.lessons.types(sessionId).find(t => t.name === type)!
  if (created) store.lessons.record({ session_id: sessionId, kind: 'type-proposed', template_id: null, turn, origin: type, origin_ref: null, content_sha256: contentDigest(why) })
  return { ok: true, name: type, status: row.status }
}

/** The owner's decision on a proposed type (the panel route). */
export function decideLessonType(store: TemplateStore, sessionId: string, name: string, approved: boolean): { ok: true } | { ok: false; code: 'not-found'; error: string } {
  if (!store.lessons.decideType(sessionId, name, approved)) return { ok: false, code: 'not-found', error: 'no such proposed type for this session' }
  store.lessons.record({ session_id: sessionId, kind: 'type-decided', template_id: null, turn: null, origin: name, origin_ref: approved ? 'approved' : 'rejected', content_sha256: null })
  return { ok: true }
}

function oneLineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** One entry of a session's lesson timeline, newest first. */
export interface TimelineEntry {
  readonly at: string
  readonly turn: number | null
  readonly kind: LessonLogKind
  /** The lesson's type (or legacy number) when the entry concerns a lesson; the type name for type proposals. */
  readonly type: string | null
  /** The lesson text at that point, when the entry wrote or soft-deleted one. */
  readonly text?: string
  /** For round-closed: updated, written, kept or none. For type-decided: approved or rejected. For round-verdict: pass or fail. */
  readonly outcome?: string
  /** For a no-entry: the stated reason. */
  readonly reason?: string
  /** For a verified keep: how the session checked that the lesson still holds. For a write: the evidence attached to it. For a round-verdict: its reference. */
  readonly evidence?: string
  /** For card-injected: the workshop card's name. For a card round's ending: its key (card:<turn>). */
  readonly card?: string
}

/** The session's recent lesson history across types: writes, soft deletions, recalls, round outcomes, type decisions. */
export function lessonTimeline(store: TemplateStore, sessionId: string, limit = 20, type?: string): TimelineEntry[] {
  const max = Math.max(1, Math.min(TIMELINE_MAX, Math.trunc(Number.isFinite(limit) ? limit : 20)))
  const keys = new Map(lessonsOf(store, sessionId).map(lesson => [lesson.id, lesson]))
  const keyOf = (templateId: string | null): string | null => {
    if (templateId === null) return null
    const known = keys.get(templateId)
    if (known !== undefined) return known.key
    const m = LESSON_NAME.exec(store.get(templateId)?.name ?? '')
    return m === null ? null : m[1]!
  }
  const textOf = (templateId: string | null, sha: string | null): string | undefined => {
    if (templateId === null || sha === null) return undefined
    const current = keys.get(templateId)
    if (current !== undefined && contentDigest(current.content) === sha) return current.content
    return store.lessons.versionText(templateId, sha)
  }
  const out: TimelineEntry[] = []
  for (const row of store.lessons.log(sessionId, 500).reverse()) {
    if (row.kind === 'prompted' || row.kind === 'pinned-loaded' || row.kind === 'delivered') continue
    const isType = row.kind === 'type-proposed' || row.kind === 'type-decided'
    const key = isType ? row.origin : keyOf(row.template_id)
    if (type !== undefined && key !== type) continue
    const entry: { -readonly [K in keyof TimelineEntry]: TimelineEntry[K] } = { at: row.at, turn: row.turn, kind: row.kind, type: key }
    if (row.kind === 'written' || row.kind === 'superseded') {
      const text = textOf(row.template_id, row.content_sha256)
      if (text !== undefined) entry.text = text
    }
    if (row.kind === 'written' && row.template_id !== null && row.content_sha256 !== null) {
      const evidence = store.lessons.evidence(row.template_id, row.content_sha256)
      if (evidence !== undefined) entry.evidence = evidence
    }
    if (row.kind === 'round-closed') {
      const origin = row.origin ?? ''
      entry.outcome = origin.startsWith('none') ? 'none' : origin.startsWith('kept:') ? 'kept' : origin
      if (origin.startsWith('none:')) entry.reason = origin.slice(5)
      if (origin.startsWith('kept:')) entry.evidence = origin.slice(5)
    }
    if (row.kind === 'card-injected') { entry.card = (row.origin ?? '').split('@')[0]; entry.type = null }
    if ((row.kind === 'round-closed' || row.kind === 'round-missed' || row.kind === 'round-na') && (row.origin_ref ?? '').startsWith(CARD_KEY)) entry.card = row.origin_ref ?? undefined
    if (row.kind === 'round-na') entry.reason = row.origin ?? undefined
    if (row.kind === 'type-decided') entry.outcome = row.origin_ref ?? undefined
    if (row.kind === 'self-pinned' || row.kind === 'self-unpinned') entry.reason = row.origin ?? undefined
    if (row.kind === 'round-verdict') {
      const parsed = parseVerdict(row.origin)
      if (parsed !== null) { entry.outcome = parsed.verdict; entry.evidence = parsed.ref }
    }
    out.push(entry)
    if (out.length >= max) break
  }
  return out
}

type WriteResult = { ok: true; id: string; type: string; version: string; superseded: boolean; owner_edited?: boolean; round: RoundOutcome | null } | { ok: false; code: string; error: string }

/**
 * Close one open recall round with the write that just happened: the round of the lesson that was rewritten if it has
 * one open (`updated`), else the latest open round (`written`). Returns how it closed, or null when no round was open.
 */
export function closeRound(store: TemplateStore, sessionId: string, writtenId: string, turn: number | null, body: string): RoundOutcome | null {
  const recalls = store.lessons.openRounds(sessionId)
  const own = recalls.filter(row => row.template_id === writtenId).at(-1)
  if (own !== undefined) {
    store.lessons.record({ session_id: sessionId, kind: 'round-closed', template_id: own.template_id, turn, origin: 'updated', origin_ref: String(own.seq), content_sha256: contentDigest(body) })
    return 'updated'
  }
  // Otherwise the latest open round of either kind: a recall round, or a card round (keyed by its injection turn).
  const recall = recalls.at(-1)
  const card = store.lessons.openCardRounds(sessionId).at(-1)
  if (recall === undefined && card === undefined) return null
  if (card !== undefined && (recall === undefined || card.seq > recall.seq)) {
    store.lessons.record({ session_id: sessionId, kind: 'round-closed', template_id: writtenId, turn, origin: 'written', origin_ref: card.key, content_sha256: contentDigest(body) })
    return 'written'
  }
  store.lessons.record({ session_id: sessionId, kind: 'round-closed', template_id: recall!.template_id, turn, origin: 'written', origin_ref: String(recall!.seq), content_sha256: contentDigest(body) })
  return 'written'
}

/**
 * Open one card round for the workshop cards injected at this turn (owner 2026-11-21, option A): the session closes it
 * with a lesson (lesson_write) or a stated no-entry (lesson_none). Idempotent per turn. Returns the closing line the
 * injection carries, or null when the round was already open.
 */
export function openCardRound(store: TemplateStore, sessionId: string, turn: number, cards: ReadonlyArray<{ id: string; name: string; version: string | null }>, options: { readonly lessonToolsMissing?: boolean } = {}): string | null {
  if (cards.length === 0) return null
  const key = `${CARD_KEY}${String(turn)}`
  if (store.lessons.log(sessionId, 500).some(row => row.kind === 'card-injected' && row.origin_ref === key)) return null
  for (const card of cards) {
    store.lessons.record({ session_id: sessionId, kind: 'card-injected', template_id: card.id, turn, origin: `${card.name}@${card.version ?? ''}`, origin_ref: key, content_sha256: null })
  }
  // A session whose own tool scope has neither lesson_write nor lesson_none cannot close the round: it is recorded as not
  // applicable (never open, never missed) and the line asks for no lesson. Only a confirmed absence does this (inject.ts).
  if (options.lessonToolsMissing === true) {
    store.lessons.record({ session_id: sessionId, kind: 'round-na', template_id: null, turn, origin: CARD_ROUND_NA_REASON, origin_ref: key, content_sha256: null })
    return renderCardRoundNaLine(cards.map(card => card.name))
  }
  return renderCardRoundLine(cards.map(card => card.name))
}

/** Why a card round was recorded not applicable. */
export const CARD_ROUND_NA_REASON = 'tools-unavailable'

/** The line appended to a workshop injection for a session without the lesson tools: do the card, no lesson is asked for. */
export function renderCardRoundNaLine(names: readonly string[]): string {
  return `【工坊·卡片轮次】本轮注入了工坊卡（${names.join('、')}），照卡做即可；本会话没有 lesson_write、lesson_none 工具，这一轮不要求写体会，记为不适用（工具不可用）。在已有授权内推进，属主当下的指令优先。`
}

/** The line appended to an injection that carried workshop cards. */
export function renderCardRoundLine(names: readonly string[]): string {
  return `【工坊·卡片轮次】本轮注入了工坊卡（${names.join('、')}），这是一轮改进：照卡做完后，有可迁移的经验必须用 lesson_write 写入对应类型（收 放 找 落 验 记 续，或已批准的自定类型）；确实没有，就调用 lesson_none 写一句原因。本轮或下一轮内完成，否则记为未闭合。在已有授权内推进，属主当下的指令优先。\n${LESSONS_MUST_READ_LINE}`
}

type NoneResult = { ok: true; round: 'none'; card_round: string } | { ok: false; code: string; error: string }

/** Close the latest open card round with a stated no-entry. A recall round cannot be closed this way: it needs a write. */
export function lessonNone(store: TemplateStore, sessionId: string, reason: string, turn: number | null): NoneResult {
  const why = oneLineText(reason)
  if (why === '' || [...why].length > NONE_MAX) return { ok: false, code: 'reason', error: `say in 1..${String(NONE_MAX)} characters why this round leaves no lesson` }
  const card = store.lessons.openCardRounds(sessionId).at(-1)
  if (card === undefined) {
    return { ok: false, code: 'no-card-round', error: store.lessons.openRounds(sessionId).length > 0
      ? 'only a workshop-card round can close without a lesson; a recalled lesson needs a rewrite or a new lesson (lesson_write)'
      : 'no open workshop-card round in this session' }
  }
  store.lessons.record({ session_id: sessionId, kind: 'round-closed', template_id: null, turn, origin: `none:${why}`, origin_ref: card.key, content_sha256: contentDigest(why) })
  return { ok: true, round: 'none', card_round: card.key }
}

type KeepResult = { ok: true; round: 'kept'; type: string } | { ok: false; code: string; error: string }

/**
 * Keep one lesson without rewriting it: a verified keep (owner 2026-11-21). The session used the lesson, it held, and
 * nothing in it needs changing; it must say how it checked (a command and its result, a PR or CI link, a claim id). A
 * bare "still right" is not evidence. §5.16: no recall round is needed; a keep is allowed on any of the session's own
 * lessons at any time (it still closes that lesson's open round from before, if one is left).
 */
export function lessonKeep(store: TemplateStore, sessionId: string, type: unknown, evidence: string, turn: number | null): KeepResult {
  const kind = typeof type === 'string' ? type.trim() : ''
  const lesson = lessonsOf(store, sessionId).find(l => l.type === kind)
  if (lesson === undefined) return { ok: false, code: 'type', error: 'no lesson of that type in this session' }
  const round = store.lessons.openRounds(sessionId).filter(row => row.template_id === lesson.id).at(-1)
  const proof = oneLineText(evidence)
  const n = [...proof].length
  if (n < KEEP_MIN || n > KEEP_MAX) {
    return { ok: false, code: 'evidence', error: `say in ${String(KEEP_MIN)}..${String(KEEP_MAX)} characters how you checked it still holds: the command and its result, a PR or CI link, or a claim id; "still right" alone is not evidence` }
  }
  store.lessons.record({ session_id: sessionId, kind: 'round-closed', template_id: lesson.id, turn, origin: `kept:${proof}`, origin_ref: round === undefined ? null : String(round.seq), content_sha256: contentDigest(lesson.content) })
  return { ok: true, round: 'kept', type: kind }
}

/** B3b: an external verdict on a round — a review, CI or a receipt from another session; recorded by the owner. */
export type Verdict = 'pass' | 'fail'
/** A lesson's external verdicts: counts and the latest one with its reference. */
export interface VerdictSummary {
  readonly pass: number
  readonly fail: number
  readonly latest: { readonly verdict: Verdict; readonly ref: string; readonly at: string } | null
}
/** The reference of a verdict (a PR, CI or review link, a claim id): one line, at most this many characters. */
export const VERDICT_REF_MAX = 200

function parseVerdict(origin: string | null): { verdict: Verdict; ref: string } | null {
  const m = /^(pass|fail):(.*)$/s.exec(origin ?? '')
  return m === null ? null : { verdict: m[1] as Verdict, ref: m[2]! }
}

type VerdictResult = { ok: true; id: string; round: number | null; verdict: Verdict; ref: string } | { ok: false; code: 'not-found' | 'bad-request'; error: string }

/**
 * The owner attaches an external verdict to a lesson (B3b, owner 2026-11-21). Only recorded: it never closes, reopens or
 * misses a round, and the session has no tool to write one (the verdict comes from someone other than the session being
 * judged). §5.16: the lesson need not have been recalled; the verdict names its latest recall round when there is one.
 */
export function attachVerdict(store: TemplateStore, templateId: string, verdict: unknown, ref: unknown): VerdictResult {
  if (verdict !== 'pass' && verdict !== 'fail') return { ok: false, code: 'bad-request', error: 'verdict must be pass or fail' }
  const text = typeof ref === 'string' ? oneLineText(ref) : ''
  const n = [...text].length
  if (n === 0 || n > VERDICT_REF_MAX) return { ok: false, code: 'bad-request', error: `ref must be one line of 1..${String(VERDICT_REF_MAX)} characters: a PR, CI or review link, or a claim id` }
  const cue = store.lessons.cue(templateId)
  if (cue === undefined || !lessonsOf(store, cue.session_id).some(l => l.id === templateId)) return { ok: false, code: 'not-found', error: 'no such lesson of a session' }
  const round = store.lessons.latestRecall(templateId)
  store.lessons.record({ session_id: cue.session_id, kind: 'round-verdict', template_id: templateId, turn: null, origin: `${verdict}:${text}`, origin_ref: round === undefined ? null : String(round.seq), content_sha256: null })
  return { ok: true, id: templateId, round: round?.seq ?? null, verdict, ref: text }
}

/** Similarity of two lesson texts: Dice coefficient over character bigrams, ignoring whitespace and punctuation. */
export function lessonSimilarity(a: string, b: string): number {
  const norm = (text: string): string[] => [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const grams = (chars: string[]): Map<string, number> => {
    const out = new Map<string, number>()
    for (let i = 0; i + 1 < chars.length; i++) { const g = chars[i]! + chars[i + 1]!; out.set(g, (out.get(g) ?? 0) + 1) }
    return out
  }
  const x = norm(a), y = norm(b)
  if (x.join('') === y.join('')) return 1
  const gx = grams(x), gy = grams(y)
  const total = [...gx.values()].reduce((s, v) => s + v, 0) + [...gy.values()].reduce((s, v) => s + v, 0)
  if (total === 0) return 0
  let common = 0
  for (const [g, v] of gx) common += Math.min(v, gy.get(g) ?? 0)
  return (2 * common) / total
}

/**
 * Churn hint (owner 2026-11-21): the last CHURN_REWRITES rewrites of this lesson each changed nothing of substance (each
 * at least CHURN_SIMILARITY similar to the text it replaced). The panel shows it to the owner; nothing is blocked.
 */
export function lessonChurn(store: TemplateStore, templateId: string): boolean {
  const digests = store.lessons.writtenDigests(templateId)
  if (digests.length < CHURN_REWRITES + 1) return false
  const current = store.get(templateId)?.content
  const textOf = (sha: string): string | undefined => current !== undefined && contentDigest(current) === sha ? current : store.lessons.versionText(templateId, sha)
  const recent = digests.slice(-(CHURN_REWRITES + 1)).map(textOf)
  if (recent.some(text => text === undefined)) return false
  for (let i = 1; i < recent.length; i++) if (lessonSimilarity(recent[i - 1]!, recent[i]!) < CHURN_SIMILARITY) return false
  return true
}

/** Mark every workshop-card round still open past its grace turns as missed. §5.16: recall rounds are no longer forced. */
export function expireRounds(store: TemplateStore, sessionId: string, turn: number): void {
  for (const round of store.lessons.openCardRounds(sessionId)) {
    if (round.turn === null || turn <= round.turn + ROUND_GRACE_TURNS) continue
    store.lessons.record({ session_id: sessionId, kind: 'round-missed', template_id: null, turn, origin: null, origin_ref: round.key, content_sha256: null })
  }
}

/**
 * Write the calling session's lesson of one type. A type with no lesson yet gets one; a type that has one is
 * soft-overwritten: the old text is kept as a stored version and logged `superseded`, the new text takes its place and
 * its cue is rebound to the experience it now comes from. The cue comes from the experience the last digest prompt
 * followed, else from the session's last observed call; the session cannot name a cue. A lesson the owner edited on the
 * panel is the owner's: the session cannot overwrite it.
 */
export function writeLesson(store: TemplateStore, state: LessonState, sessionId: string, text: string, type: unknown, _config?: LessonsConfig, evidence?: unknown, outcome?: unknown): WriteResult {
  const body = text.trim()
  if (outcome !== undefined && outcome !== null && outcome !== '' && outcome !== 'wrong' && outcome !== 'right') {
    return { ok: false, code: 'outcome', error: 'outcome is optional: wrong (it came from getting something wrong) or right (from getting something right)' }
  }
  const tag: LessonOutcomeTag | null = outcome === 'wrong' || outcome === 'right' ? outcome : null
  const proof = typeof evidence === 'string' ? oneLineText(evidence) : ''
  if ([...proof].length > EVIDENCE_MAX) {
    return { ok: false, code: 'evidence', error: `evidence is optional, one line, at most ${String(EVIDENCE_MAX)} characters: a PR or CI link, a command and its result, or a claim id` }
  }
  if (body === '' || [...body].length > LESSON_MAX) {
    return { ok: false, code: 'length', error: `a lesson is 1..${String(LESSON_MAX)} characters: one or two sentences — when this happens, first do that, because why` }
  }
  const allowed = allowedTypes(store, sessionId)
  const kind = typeof type === 'string' ? type.trim() : ''
  if (!allowed.includes(kind)) {
    return { ok: false, code: 'type', error: `type is one of ${allowed.join(' ')}; to add your own, propose it with lesson_type_propose and wait for the owner's approval` }
  }
  const context = state.context
  const fromLast = state.last === undefined ? undefined : cueOf(state.last.features)
  const cue: CueFeatures = context ?? fromLast ?? { tool_name: '', stable_fingerprint: '', target_fingerprint: '', rule_id: null }
  const origin: LessonOrigin = context?.origin ?? (fromLast === undefined ? 'none' : 'last-call')
  const originRef = context?.origin_ref ?? (fromLast === undefined ? null : state.last?.callId ?? null)
  const turn = state.turn ?? null
  const current = lessonsOf(store, sessionId).find(lesson => lesson.type === kind)
  if (current !== undefined) {
    // Soft overwrite, also over a text the owner edited on the panel (owner 2026-11-21): the old text is kept as a stored
    // version either way, so nothing is lost; the timeline marks an owner-edited text that was superseded.
    const m = current.version === null ? null : LESSON_VERSION.exec(current.version)
    const ownerEdited = m === null
    const keptAs = ownerEdited ? `owner-${contentDigest(current.content).slice(0, 12)}` : current.version!
    const next = `lesson-r${String(Math.max(m === null ? 0 : Number(m[1]), store.lessons.maxLessonVersion(current.id), store.lessons.writes(current.id)) + 1)}`
    store.keepVersion(current.id, keptAs, `${LESSON_PREFIX}${kind}`, current.content, 'lesson')
    store.lessons.record({ session_id: sessionId, kind: 'superseded', template_id: current.id, turn, origin: ownerEdited ? 'owner-edited' : null, origin_ref: keptAs, content_sha256: contentDigest(current.content) })
    store.update(current.id, { content: body, version: next })
    if (store.lessons.cue(current.id) === undefined) store.lessons.addCue(current.id, sessionId, cue, origin, originRef, turn ?? 0)
    else store.lessons.updateCue(current.id, cue, origin, originRef, turn ?? 0)
    store.lessons.record({ session_id: sessionId, kind: 'written', template_id: current.id, turn, origin, origin_ref: originRef, content_sha256: contentDigest(body) })
    if (proof !== '') store.lessons.addEvidence(sessionId, current.id, contentDigest(body), proof)
    if (tag !== null) store.lessons.setOutcome(current.id, contentDigest(body), tag)
    state.context = undefined
    return { ok: true, id: current.id, type: kind, version: next, superseded: true, owner_edited: ownerEdited, round: closeRound(store, sessionId, current.id, turn, body) }
  }
  if (!store.listCategories(sessionId).some(c => c.scope === 'session' && c.session_id === sessionId && c.name === LESSON_CATEGORY)) {
    store.createCategory({ name: LESSON_CATEGORY, scope: 'session', session_id: sessionId })
  }
  const made = store.create({
    name: `${LESSON_PREFIX}${kind}`, content: body, scope: 'session', session_id: sessionId, category: LESSON_CATEGORY,
    description: `会话自己写下的「${kind}」类体会：做错或做对之后的一两句话，开工、恢复和压缩后交给模型；每类只留一条，再写会软覆盖`,
  })
  store.update(made.id, { content: body, version: 'lesson-r1' })
  store.lessons.addCue(made.id, sessionId, cue, origin, originRef, turn ?? 0)
  store.lessons.record({ session_id: sessionId, kind: 'written', template_id: made.id, turn, origin, origin_ref: originRef, content_sha256: contentDigest(body) })
  if (proof !== '') store.lessons.addEvidence(sessionId, made.id, contentDigest(body), proof)
  if (tag !== null) store.lessons.setOutcome(made.id, contentDigest(body), tag)
  state.context = undefined
  return { ok: true, id: made.id, type: kind, version: 'lesson-r1', superseded: false, round: closeRound(store, sessionId, made.id, turn, body) }
}

function cueOf(features: ObservationFeatures, ruleId: string | null = null): CueFeatures {
  return { tool_name: features.toolName, stable_fingerprint: features.stableFingerprint, target_fingerprint: features.targetFingerprint, rule_id: ruleId }
}

/** Whether a call's features fall in a lesson's situation: same tool, and the same preparation or the same target. */
export function cueMatches(cue: CueFeatures, features: ObservationFeatures): boolean {
  if (cue.tool_name === '' || cue.tool_name !== features.toolName) return false
  return (cue.stable_fingerprint !== '' && cue.stable_fingerprint === features.stableFingerprint)
    || (cue.target_fingerprint !== '' && cue.target_fingerprint === features.targetFingerprint)
}

/**
 * Note one tool result: remember it as the last call, notice a target that failed and now succeeded (a digest
 * signal), and count the call against every lesson whose situation it matches (background recurrence only, §5.16).
 */
export function observeForLessons(store: TemplateStore, state: LessonState, sessionId: string, callId: string, features: ObservationFeatures): void {
  state.last = { features, callId }
  const target = features.targetFingerprint
  if (features.outcome.startsWith('error')) {
    state.failures.delete(target)
    state.failures.set(target, callId)
    if (state.failures.size > FAILURES_KEPT) state.failures.delete(state.failures.keys().next().value!)
  } else if (features.outcome === 'ok' && state.failures.has(target)) {
    state.failures.delete(target)
    state.pending ??= { ...cueOf(features), origin: 'recovered', origin_ref: callId, summary: features.summary }
  }
  const failed = features.outcome.startsWith('error')
  for (const cue of store.lessons.cues(sessionId)) {
    if (!cueMatches(cue, features)) continue
    // B4a: how the lesson's situation goes before and after it was handed to the model (ok and error only).
    if (failed || features.outcome === 'ok') store.lessons.recordHit(sessionId, cue.template_id, callId, state.turn ?? null, failed, cue.recall_count > 0)
  }
}

/** Body of a digest prompt. */
export function renderDigestPrompt(context: DigestContext): string {
  const example = context.summary === '' ? '' : `（示例：${context.summary}）`
  return `【工坊·体会】刚才这件事${example}告一段落。回头看一眼：这件事做对了什么、错在哪；有可迁移的就必须用 lesson_write 写成「当……时，先……，因为……」，标明来自做错还是做对（outcome: wrong 或 right）和类型（收 放 找 落 验 记 续，或已批准的自定类型；每类只留一条，再写会软覆盖旧的）；确实没有，就在回复里说一句「这次无可记」，不必为此写总结。${DIGEST_BINDING_LINE}\n${LESSONS_MUST_READ_LINE}`
}

type PinResult = { ok: true; id: string; pinned: boolean } | { ok: false; code: 'not-found' | 'pinned-full'; error: string }

/**
 * The owner pins or unpins one lesson (the PATCH route; sessions have no way to pin). Only a lesson that is still its
 * session's own session template can be pinned, at most `max` per session.
 */
export function pinLesson(store: TemplateStore, templateId: string, pinned: boolean, max: number): PinResult {
  const cue = store.lessons.cue(templateId)
  const lesson = cue === undefined ? undefined : lessonsOf(store, cue.session_id).find(l => l.id === templateId)
  if (cue === undefined || lesson === undefined) return { ok: false, code: 'not-found', error: 'no such lesson of a session' }
  if (pinned && cue.pinned !== 1) {
    const count = store.lessons.cues(cue.session_id).filter(c => c.pinned === 1).length
    if (count >= max) return { ok: false, code: 'pinned-full', error: `this session already has ${String(count)} pinned lessons (max ${String(max)}); unpin one first` }
  }
  // Owner 2026-11-21: a lesson the owner unpinned stays unpinned — the session cannot pin it back (lesson_pin).
  if (!pinned && cue.pinned === 1) store.lessons.record({ session_id: cue.session_id, kind: 'owner-unpinned', template_id: templateId, turn: null, origin: null, origin_ref: null, content_sha256: null })
  store.lessons.setPinned(templateId, pinned)
  return { ok: true, id: templateId, pinned }
}

/** §5.16: how the session uses its lessons, said once with the list. */
export const LESSON_USE_LINE = '这是你自己写下的体会。走到链路哪一环，就看那一类；适用即须照做。做完一件事，回头看一眼：哪里做对了，哪里做错了，值得记就用 lesson_write 写成「当……时，先……，因为……」（标明 outcome: wrong 或 right）；用上的那条，有效就用 lesson_keep 带证据保持，不对就用 lesson_write 改写。在已有授权内推进，属主当下的指令优先。'

/**
 * §5.16: the session's lessons, handed over at a start, resume or compaction. Pinned ones first (old data), then in
 * the order of the chain and the approved types; at most LESSON_LIST_MAX_CHARS, the rest named by count.
 */
export function renderLessonList(lessons: ReadonlyArray<Pick<LessonView, 'key' | 'content' | 'outcome'>>): string {
  const head = `【工坊·体会｜本会话】你在这个会话里写下的体会（共 ${String(lessons.length)} 条）：`
  const lines: string[] = []
  let chars = 0
  for (const lesson of lessons) {
    const tag = lesson.outcome === 'wrong' ? '·做错' : lesson.outcome === 'right' ? '·做对' : ''
    const line = `- ${lesson.key}${tag}：${lesson.content}`
    const n = [...line].length
    if (chars + n > LESSON_LIST_MAX_CHARS && lines.length > 0) break
    chars += n
    lines.push(line)
  }
  const rest = lessons.length - lines.length
  return [head, ...lines, ...(rest > 0 ? [`还有 ${String(rest)} 条没列出，用 lesson_timeline 查。`] : []), LESSON_USE_LINE, LESSONS_MUST_READ_LINE].join('\n')
}

function lessonMessage(mode: LessonsConfig['mode'], turn: number, step: number, bodies: readonly string[]): UserMessage {
  if (mode === 'visible') {
    return createUserMessage({
      content: [{ type: 'text', text: [`⚙️ 体会 · 第 ${String(turn)} 轮第 ${String(step)} 步`, '', ...bodies.flatMap(body => [body, ''])].join('\n').trimEnd() }],
      source: { kind: 'user', scheduled: 'prompt-template-lesson', turn, step } as unknown as UserMessage['source'],
    })
  }
  return createUserMessage({
    content: [{
      type: 'text',
      text: ['<system-reminder>',
        `Lesson note from dsh-prompt-templates (turn ${String(turn)}, step ${String(step)}): the session's own lessons handed over (use them where they apply), or a prompt to look back and write one. It grants no new permission and does not override the owner's latest instructions.`,
        '', ...bodies, '</system-reminder>'].join('\n'),
    }],
    source: { kind: 'prompt-template-lesson', turn, step } as unknown as UserMessage['source'],
  })
}

/** The next settled experience to prompt for, if any is new. */
function nextDigest(store: TemplateStore, state: LessonState, sessionId: string, turn: number): DigestContext | undefined {
  const fresh = (context: DigestContext | undefined): DigestContext | undefined =>
    context !== undefined && (context.origin_ref === null || !store.lessons.prompted(sessionId, context.origin_ref)) ? context : undefined
  const pending = fresh(state.pending)
  if (pending !== undefined) return pending
  state.pending = undefined
  for (const episode of store.events.episodes(sessionId).reverse()) {
    if (episode.signal !== 'changed') continue
    const context = fresh({ tool_name: episode.tool_name, stable_fingerprint: '', target_fingerprint: episode.target_fingerprint, rule_id: episode.rule_id,
      origin: 'changed', origin_ref: episode.episode_id, summary: episode.summary })
    if (context !== undefined) return context
  }
  const last = store.selfChecks.list(sessionId, 20).filter(row => row.kind === 'concluded').at(-1)
  if (last !== undefined && last.conclusion === 'done' && last.turn !== null && turn - last.turn <= 1) {
    const features = state.last?.features
    return fresh({ ...(features === undefined ? { tool_name: '', stable_fingerprint: '', target_fingerprint: '', rule_id: null } : cueOf(features)),
      origin: 'selfcheck-done', origin_ref: `selfcheck:${String(last.seq)}`, summary: '' })
  }
  return undefined
}

function digestAllowed(store: TemplateStore, config: LessonsConfig, sessionId: string, turn: number): boolean {
  if (store.lessons.countAt(sessionId, 'prompted', turn) > 0) return false
  const last = store.lessons.lastPromptTurn(sessionId)
  if (last === undefined) return true
  const quiet = store.lessons.promptsSinceWrite(sessionId) >= PAUSE_AFTER ? config.digestCooldownTurns * 3 : config.digestCooldownTurns
  return turn >= last + quiet
}

/**
 * This step's lesson messages: after a start, resume or compaction, the session's lessons (§5.16); and at most one
 * digest prompt per turn, with its cooldown. Exported for tests; the host path is the `agent/pre-step` listener below.
 * Delivery is best effort (a rejected step loses it); what was handed over is logged.
 */
export function prepareLessonMessages(store: TemplateStore, state: LessonState, config: LessonsConfig, sessionId: string, turn: number, step: number): UserMessage[] {
  state.turn = turn
  expireRounds(store, sessionId, turn)
  const bodies: string[] = []
  if (state.deliverDue !== undefined) {
    const source = state.deliverDue
    state.deliverDue = undefined
    const pinned = new Set(store.lessons.cues(sessionId).filter(cue => cue.pinned === 1).map(cue => cue.template_id))
    const all = lessonsOf(store, sessionId)
    const lessons = [...all.filter(l => pinned.has(l.id)), ...all.filter(l => !pinned.has(l.id))]
    if (lessons.length > 0) {
      const body = renderLessonList(lessons)
      bodies.push(body)
      for (const lesson of lessons) {
        store.lessons.markRecalled(lesson.id, turn)
        store.lessons.record({ session_id: sessionId, kind: 'delivered', template_id: lesson.id, turn, origin: source, origin_ref: null, content_sha256: contentDigest(lesson.content) })
      }
    }
  }
  // A card round already asks for a lesson or a no-entry: do not ask twice in the same stretch.
  if (store.lessons.openCardRounds(sessionId).length === 0 && digestAllowed(store, config, sessionId, turn)) {
    const context = nextDigest(store, state, sessionId, turn)
    if (context !== undefined) {
      const body = renderDigestPrompt(context)
      bodies.push(body)
      state.context = context
      if (state.pending === context) state.pending = undefined
      store.lessons.record({ session_id: sessionId, kind: 'prompted', template_id: null, turn, origin: context.origin, origin_ref: context.origin_ref, content_sha256: contentDigest(body) })
    }
  }
  return bodies.length === 0 ? [] : [lessonMessage(config.mode, turn, step, bodies)]
}

type ExecLike = { callId?: unknown; name?: unknown; arguments?: unknown; agent?: { session: { header: { id: unknown } } } }

/** Register the observer, the step consumer and `lesson_write`. All of it is inert unless `config().enabled`. */
export function registerLessons(ctx: Context, store: () => TemplateStore, config: () => LessonsConfig): void {
  const sessions = new Map<string, LessonState>()
  const stateOf = (id: string): LessonState => { let s = sessions.get(id); if (s === undefined) { s = newLessonState(); sessions.set(id, s) } return s }
  let faultReported = false
  const fault = (label: string, error: unknown): void => {
    if (!faultReported) { faultReported = true; console.error(`[dsh-prompt-templates] lessons ${label}; further faults stay silent:`, error) }
  }

  ctx.on('tools/result', (exec: unknown, result: unknown) => {
    try {
      if (!config().enabled) return
      const e = exec as ExecLike
      const name = String(e.name ?? '')
      if (LESSON_SELF_TOOLS.includes(name)) return
      const sessionId = e.agent?.session.header.id
      if (sessionId === undefined || sessionId === null) return
      observeForLessons(store(), stateOf(String(sessionId)), String(sessionId), String(e.callId ?? ''), extractFeatures(name, e.arguments, result as ToolOutcomeProbe))
    } catch (error) { fault('skipped a tool result', error) }
  })

  // §5.16: a start, resume or compaction makes the next step hand over the session's lessons; `clear` does not.
  ctx.on('agent/created', ({ agent, source }: { agent: { session: { header: { id: unknown } } }; source: string }) => {
    try {
      if (!config().enabled || !PINNED_SOURCES.includes(source)) return undefined
      stateOf(String(agent.session.header.id)).deliverDue = source
    } catch (error) { fault('skipped a session start', error) }
    return undefined
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    try {
      if (!config().enabled) return decision
      const sessionId = String(agent.session.header.id)
      const messages = prepareLessonMessages(store(), stateOf(sessionId), config(), sessionId, turn, step)
      return messages.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...messages] }
    } catch (error) {
      fault('skipped this step', error)
      return decision
    }
  })

  registerWhenToolsReady(ctx, 'lessons', (tools) => {
    tools.register(withOutput({
      name: 'lesson_write',
      description: 'Write down a lesson for your own session: one or two sentences (at most 160 characters) about something that just happened — when you got something wrong, or when you got it right — written as "when this happens, first do that, because why", tagged with its type and, optionally, whether it came from getting it wrong or right (outcome). Types: 收 边界、放 自己定、找 查原因、落 动手、验 验证、记 记录、续 失败或受阻后 (the autonomy chain), or a type you proposed with lesson_type_propose and the owner approved. You keep one lesson per type: writing a type that already has one soft-overwrites it (the old text is kept in the history). Your lessons are handed back to you at every start, resume and after compaction; use them where they apply. When a lesson held, keep it with lesson_keep and the evidence; when it did not, rewrite it here. Before the first lesson of a session, load the agent-atelier skill and read references/lessons.md. A good lesson: comes from something that really happened; says why; names the situation so you recognise it and the first move concretely enough to act on; is transferable (not the paths, ids or names of this one run); is short; can be checked the next time it is used; and is judgement, not authority. Not a log of events, not a slogan, not a copy of an existing rule, not an unverified conclusion from others, not filler — if nothing was learned, say so (lesson_none for a card round). Pick the type by the link where it arose, not where it was noticed. When something checkable backs it (a PR or CI link, a command and its result, a ygl claim id), add it as evidence; it is optional. No secrets, tokens, internal addresses or local paths. Acts only on the calling session.',
      parameters: objectParameters({
        text: { type: 'string', description: 'The lesson, 1..160 characters.' },
        type: { type: 'string', description: 'The lesson type: 收 放 找 落 验 记 续, or an approved type of your own.' },
        evidence: { type: 'string', description: `Optional: what backs the lesson — a PR or CI link, a command and its result, a ygl claim id; one line, at most ${String(EVIDENCE_MAX)} characters.` },
        outcome: { type: 'string', enum: ['wrong', 'right'], description: 'Optional: wrong if the lesson came from getting something wrong, right if it came from getting something right.' },
      }, ['text', 'type']),
      execute: async (args: { text?: unknown; type?: unknown; evidence?: unknown; outcome?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        return writeLesson(store(), stateOf(String(sessionId)), String(sessionId), String(args.text ?? ''), args.type, config(), args.evidence, args.outcome)
      },
    }))
    tools.register(withOutput({
      name: 'lesson_none',
      description: 'Close the open workshop-card round of your own session without a lesson: say in one line why this round leaves nothing transferable (the card did not apply, or you followed it and learned nothing new). A workshop card injection opens a round that must end with a lesson (lesson_write) or this. Acts only on the calling session.',
      parameters: objectParameters({
        reason: { type: 'string', description: 'Why there is no lesson this round, 1..120 characters.' },
      }, ['reason']),
      execute: async (args: { reason?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        const id = String(sessionId)
        return lessonNone(store(), id, String(args.reason ?? ''), stateOf(id).turn ?? null)
      },
    }))
    tools.register(withOutput({
      name: 'lesson_keep',
      description: 'Keep one of your own lessons without rewriting it — a verified keep: you followed the lesson, it held, and nothing in it needs changing. Give the lesson type and the evidence of how you checked it still holds (the command and its result, a PR or CI link, a claim id). "Still right" alone is not evidence and is refused. Usable on any of your lessons at any time; a workshop-card round still ends with lesson_write or lesson_none. Acts only on the calling session.',
      parameters: objectParameters({
        type: { type: 'string', description: 'The type of the lesson you keep: 收 放 找 落 验 记 续, or an approved type of your own.' },
        evidence: { type: 'string', description: `How you checked it still holds, ${String(KEEP_MIN)}..${String(KEEP_MAX)} characters, one line.` },
      }, ['type', 'evidence']),
      execute: async (args: { type?: unknown; evidence?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        const id = String(sessionId)
        return lessonKeep(store(), id, args.type, String(args.evidence ?? ''), stateOf(id).turn ?? null)
      },
    }))
    tools.register(withOutput({
      name: 'lesson_timeline',
      description: 'Read your own session\'s recent lesson timeline across types, newest first: each lesson written, each old text soft-deleted when a type was overwritten (with the text), each verified keep with its evidence, workshop-card rounds and how they ended, external verdicts the owner attached to a round (pass or fail with a link; they never close a round), and the owner\'s decisions on types you proposed. Optionally filter to one type. Read-only; acts only on the calling session.',
      parameters: objectParameters({
        limit: { type: 'number', description: 'How many entries, 1..100; default 20.' },
        type: { type: 'string', description: 'Optional: only this type.' },
      }, []),
      execute: async (args: { limit?: unknown; type?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        const id = String(sessionId)
        const filter = typeof args.type === 'string' && args.type.trim() !== '' ? args.type.trim() : undefined
        return { ok: true, types: allowedTypes(store(), id), entries: lessonTimeline(store(), id, args.limit === undefined ? 20 : Number(args.limit), filter) }
      },
    }))
    tools.register(withOutput({
      name: 'lesson_type_propose',
      description: 'Propose a new lesson type for your own session when none of 收 放 找 落 验 记 续 fits what you keep learning. Give a short name (1..8 letters or digits) and one line on what lessons of this type are about and why the built-in types do not fit. The type is usable in lesson_write only after the owner approves it on the panel; until then, write the closest built-in type. Acts only on the calling session.',
      parameters: objectParameters({
        name: { type: 'string', description: 'The type name, 1..8 letters or digits.' },
        description: { type: 'string', description: 'What lessons of this type are about, and why no built-in type fits (1..120 characters).' },
      }, ['name', 'description']),
      execute: async (args: { name?: unknown; description?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        const id = String(sessionId)
        return proposeLessonType(store(), id, String(args.name ?? ''), String(args.description ?? ''), stateOf(id).turn ?? null)
      },
    }))
  })
}
