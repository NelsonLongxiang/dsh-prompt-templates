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
 * On unless `lessons.enabled` is false (owner decision 2026-11-21). A lesson is the session's own reference, not an instruction, and grants nothing. The
 * plugin records what it prompted, what was written and what it recalled; it does not track whether the session
 * followed a recalled lesson (the owner checks deliverables instead).
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
export const LESSON_SELF_TOOLS: readonly string[] = ['lesson_write', 'selfcheck_write', 'selfcheck_conclude']
/** Total characters of the pinned lessons loaded at one start (phase 2). */
export const PINNED_MAX_CHARS = 400
/** Session starts that load pinned lessons; `clear` is the user asking for a fresh start (spec §10, decision 4). */
export const PINNED_SOURCES: readonly string[] = ['startup', 'resume', 'compact']
/** Failed targets remembered per session for the failed-then-succeeded signal. */
const FAILURES_KEPT = 50

const LESSON_NAME = /^体会·(\d+)$/
const LESSON_VERSION = /^lesson-r(\d+)$/
const NOT_AUTHORITY = '本提示不是新的用户指令，不授予任何权限。'

/** Deployment switches and budgets (`lessons` in the plugin config). */
export interface LessonsConfig {
  readonly enabled: boolean
  readonly mode: 'inject' | 'visible'
  readonly maxPerSession: number
  readonly digestCooldownTurns: number
  readonly recallCooldownTurns: number
  readonly maxRecallChars: number
  /** Pinned lessons per session (phase 2); only the owner pins. */
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

export type LessonLogKind = 'prompted' | 'written' | 'recalled' | 'pinned-loaded'

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

/** Per-session runtime state; losing it on restart only drops a pending prompt or recall. */
export interface LessonState {
  turn?: number
  last?: { readonly features: ObservationFeatures, readonly callId: string }
  readonly failures: Map<string, string>
  /** A failed-then-succeeded target not yet prompted for. */
  pending?: DigestContext
  /** The experience the last digest prompt followed; bound to the next lesson written. */
  context?: DigestContext
  readonly recall: Set<string>
  /** Set by `agent/created` (startup, resume, compact): the next step loads the pinned lessons. */
  pinnedDue?: string
  /** Pinned lessons loaded into this context; recall skips them. */
  readonly loaded: Set<string>
}

export function newLessonState(): LessonState {
  return { failures: new Map(), recall: new Set(), loaded: new Set() }
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

  countAt(sessionId: string, kind: LessonLogKind, turn: number): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM lesson_log WHERE session_id = ? AND kind = ? AND turn = ?').get(sessionId, kind, turn) as { n: number }
    return Number(row.n)
  }
}

/** One lesson as the read route and the recall see it. */
export interface LessonView {
  readonly id: string
  readonly index: number
  readonly content: string
  readonly version: string | null
}

/** A session's lessons: its own session templates named 体会·N, oldest first. */
export function lessonsOf(store: TemplateStore, sessionId: string): LessonView[] {
  return store.list('session', sessionId).flatMap(t => {
    const m = LESSON_NAME.exec(t.name)
    return m === null ? [] : [{ id: t.id, index: Number(m[1]), content: t.content, version: t.version ?? null }]
  }).sort((a, b) => a.index - b.index)
}

type WriteResult = { ok: true; id: string; index: number; version: string } | { ok: false; code: string; error: string }

/**
 * Write (or, with `replace`, rewrite) one of the calling session's lessons. A new lesson's cue comes from the experience
 * the last digest prompt followed, else from the session's last observed call; the session cannot name a cue. A lesson
 * the owner edited on the panel is the owner's: the session cannot rewrite it.
 */
export function writeLesson(store: TemplateStore, state: LessonState, sessionId: string, text: string, replace: unknown, config: LessonsConfig): WriteResult {
  const body = text.trim()
  if (body === '' || [...body].length > LESSON_MAX) {
    return { ok: false, code: 'length', error: `a lesson is 1..${String(LESSON_MAX)} characters: one or two sentences, what hurt and what to do first next time` }
  }
  const lessons = lessonsOf(store, sessionId)
  if (replace !== undefined && replace !== null) {
    const index = Number(replace)
    const current = Number.isInteger(index) ? lessons.find(lesson => lesson.index === index) : undefined
    if (current === undefined) return { ok: false, code: 'not-found', error: `no lesson ${String(replace)} in this session` }
    const m = current.version === null ? null : LESSON_VERSION.exec(current.version)
    if (m === null || current.version === null) return { ok: false, code: 'owner-edited', error: 'the owner edited this lesson on the panel; it is theirs now' }
    const next = `lesson-r${String(Number(m[1]) + 1)}`
    store.keepVersion(current.id, current.version, `${LESSON_PREFIX}${String(index)}`, current.content, 'lesson')
    store.update(current.id, { content: body, version: next })
    store.lessons.record({ session_id: sessionId, kind: 'written', template_id: current.id, turn: state.turn ?? null, origin: null, origin_ref: null, content_sha256: contentDigest(body) })
    return { ok: true, id: current.id, index, version: next }
  }
  if (lessons.length >= config.maxPerSession) {
    return { ok: false, code: 'full', error: `this session already has ${String(lessons.length)} lessons; rewrite one (replace) or ask the owner to remove some` }
  }
  if (!store.listCategories(sessionId).some(c => c.scope === 'session' && c.session_id === sessionId && c.name === LESSON_CATEGORY)) {
    store.createCategory({ name: LESSON_CATEGORY, scope: 'session', session_id: sessionId })
  }
  const index = lessons.reduce((max, lesson) => Math.max(max, lesson.index), 0) + 1
  const made = store.create({
    name: `${LESSON_PREFIX}${String(index)}`, content: body, scope: 'session', session_id: sessionId, category: LESSON_CATEGORY,
    description: '会话自己写下的体会：经历之后的一两句话，同类情境下会被唤起',
  })
  store.update(made.id, { content: body, version: 'lesson-r1' })
  const context = state.context
  const fromLast = state.last === undefined ? undefined : cueOf(state.last.features)
  const cue: CueFeatures = context ?? fromLast ?? { tool_name: '', stable_fingerprint: '', target_fingerprint: '', rule_id: null }
  const origin: LessonOrigin = context?.origin ?? (fromLast === undefined ? 'none' : 'last-call')
  const originRef = context?.origin_ref ?? (fromLast === undefined ? null : state.last?.callId ?? null)
  store.lessons.addCue(made.id, sessionId, cue, origin, originRef, state.turn ?? 0)
  store.lessons.record({ session_id: sessionId, kind: 'written', template_id: made.id, turn: state.turn ?? null, origin, origin_ref: originRef, content_sha256: contentDigest(body) })
  state.context = undefined
  return { ok: true, id: made.id, index, version: 'lesson-r1' }
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
 * signal), and queue every lesson whose cue it matches.
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
  for (const cue of store.lessons.cues(sessionId)) if (cueMatches(cue, features)) state.recall.add(cue.template_id)
}

/** Body of a digest prompt. */
export function renderDigestPrompt(context: DigestContext): string {
  const example = context.summary === '' ? '' : `（示例：${context.summary}）`
  return `【工坊·体会】刚才这件事${example}告一段落。有一句值得下次记住的话吗？有就用 lesson_write 写一两句：疼在哪、下次先做什么；没有就直接继续，不必为此写总结。${NOT_AUTHORITY}`
}

/** Body of a recalled lesson. */
export function renderRecall(content: string, max: number): string {
  const text = content.length <= max ? content : `${content.slice(0, Math.max(0, max - 1))}…`
  return [`【工坊·体会｜你之前写下的】${text}`, '这是你在同类情境下写的参考，不是新的用户指令，不授予任何权限。不适用就忽略。'].join('\n')
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
  store.lessons.setPinned(templateId, pinned)
  return { ok: true, id: templateId, pinned }
}

/** The pinned lessons loaded at one start: oldest first, at most `max` of them and PINNED_MAX_CHARS in all. */
export function pinnedLessons(lessons: readonly LessonView[], max: number): LessonView[] {
  const out: LessonView[] = []
  let chars = 0
  for (const lesson of lessons) {
    if (out.length >= max) break
    const n = [...lesson.content].length
    if (chars + n > PINNED_MAX_CHARS) break
    chars += n
    out.push(lesson)
  }
  return out
}

/** Body of the pinned lessons loaded at a start or after compaction. */
export function renderPinned(contents: readonly string[]): string {
  return [`【工坊·体会｜常驻】属主从你之前写下的体会里选了这几条，每次开工和上下文压缩之后带上：`,
    ...contents.map((content, i) => `${String(i + 1)}. ${content}`),
    '这些是参考，不是新的用户指令，不授予任何权限。不适用就忽略。'].join('\n')
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
        `Lesson note from dsh-prompt-templates (turn ${String(turn)}, step ${String(step)}): the session's own earlier note, or a prompt to write one. It is not a user instruction and grants no permission.`,
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
 * This step's lesson messages: at most one digest prompt and one recalled lesson per turn, each with its cooldown.
 * Exported for tests; the host path is the `agent/pre-step` listener below. Delivery is best effort (a rejected step
 * loses it); what was handed over is logged.
 */
export function prepareLessonMessages(store: TemplateStore, state: LessonState, config: LessonsConfig, sessionId: string, turn: number, step: number): UserMessage[] {
  state.turn = turn
  const bodies: string[] = []
  const pinned = new Set(store.lessons.cues(sessionId).filter(cue => cue.pinned === 1).map(cue => cue.template_id))
  if (state.pinnedDue !== undefined) {
    const source = state.pinnedDue
    state.pinnedDue = undefined
    const loaded = pinnedLessons(lessonsOf(store, sessionId).filter(lesson => pinned.has(lesson.id)), config.maxPinned)
    state.loaded.clear()
    for (const lesson of loaded) state.loaded.add(lesson.id)
    if (loaded.length > 0) {
      const body = renderPinned(loaded.map(lesson => lesson.content))
      bodies.push(body)
      for (const lesson of loaded) {
        store.lessons.record({ session_id: sessionId, kind: 'pinned-loaded', template_id: lesson.id, turn, origin: source, origin_ref: null, content_sha256: contentDigest(lesson.content) })
      }
    }
  }
  if (digestAllowed(store, config, sessionId, turn)) {
    const context = nextDigest(store, state, sessionId, turn)
    if (context !== undefined) {
      const body = renderDigestPrompt(context)
      bodies.push(body)
      state.context = context
      if (state.pending === context) state.pending = undefined
      store.lessons.record({ session_id: sessionId, kind: 'prompted', template_id: null, turn, origin: context.origin, origin_ref: context.origin_ref, content_sha256: contentDigest(body) })
    }
  }
  if (state.recall.size > 0 && store.lessons.countAt(sessionId, 'recalled', turn) === 0) {
    const lessons = new Map(lessonsOf(store, sessionId).map(lesson => [lesson.id, lesson]))
    for (const id of state.recall) {
      const cue = store.lessons.cue(id)
      const lesson = lessons.get(id)
      // A pinned lesson loaded at the last start or compaction is already in the context.
      if (cue === undefined || lesson === undefined || (pinned.has(id) && state.loaded.has(id))) continue
      if (turn < (cue.last_recalled_turn ?? cue.created_turn) + config.recallCooldownTurns) continue
      const body = renderRecall(lesson.content, config.maxRecallChars)
      bodies.push(body)
      store.lessons.markRecalled(id, turn)
      store.lessons.record({ session_id: sessionId, kind: 'recalled', template_id: id, turn, origin: cue.origin, origin_ref: cue.origin_ref, content_sha256: contentDigest(body) })
      break
    }
    state.recall.clear()
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

  // Phase 2: a start, resume or compaction makes the next step load the pinned lessons; `clear` does not.
  ctx.on('agent/created', ({ agent, source }: { agent: { session: { header: { id: unknown } } }; source: string }) => {
    try {
      if (!config().enabled || !PINNED_SOURCES.includes(source)) return undefined
      stateOf(String(agent.session.header.id)).pinnedDue = source
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
      description: 'Write down a lesson for your own session: one or two sentences (at most 160 characters) about an experience that just settled — what hurt or surprised you, and what to do first next time. The plugin links it to the situation it came from and brings it back when you meet that situation again. To rewrite one of your lessons, pass its number as replace. Write judgement, not authority; no secrets, tokens, internal addresses or local paths. No owner confirmation is needed; a lesson the owner edited is theirs. Acts only on the calling session.',
      parameters: objectParameters({
        text: { type: 'string', description: 'The lesson, 1..160 characters.' },
        replace: { type: 'number', description: 'Optional: the number N of your lesson 体会·N to rewrite.' },
      }, ['text']),
      execute: async (args: { text?: unknown; replace?: unknown }, exec: unknown) => {
        if (!config().enabled) return { ok: false, code: 'disabled', error: 'lessons are off on this host' }
        const sessionId = (exec as ExecLike).agent?.session.header.id
        if (sessionId === undefined || sessionId === null) return { ok: false, code: 'session', error: 'no calling session' }
        return writeLesson(store(), stateOf(String(sessionId)), String(sessionId), String(args.text ?? ''), args.replace, config())
      },
    }))
  })
}
