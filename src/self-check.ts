/**
 * Wrap-up self-check (observer phase 2, PT-4; workbench-market 18 「自查模板」, owner rulings R103–R106).
 *
 * Just before a turn that would otherwise close (`agent/turn-stopping`), a session with an active goal is asked one
 * question — is this stop right? — by steering one silent message into it: a fixed part the plugin carries (versioned,
 * the session cannot change it) and the session's own domain part, which the session writes itself with
 * `selfcheck_write` (no owner confirmation; every write keeps the previous version; an owner's panel edit wins). The
 * session answers with `selfcheck_conclude` (done, waiting registered, continuing, or orphan stop, with evidence or wake
 * condition, deadline and ticket); a check it never concludes is logged as an orphan stop. A session without its domain
 * part is reminded visibly, every 30 turns, at most 3 times, then marked. On unless `selfCheck.enabled` is false (owner decision 2026-11-21).
 *
 * Both tools act only on the calling session, taken from the runtime execution, never from a parameter.
 * @module @nelsonlongxiang/dsh-prompt-templates/self-check
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { oneLine } from './cast.ts'
import { scopeLacksAll } from './inject.ts'
import type { TemplateStore } from './store.ts'
import { objectParameters, registerWhenToolsReady, withOutput } from './tool-registry.ts'

/** The fixed part's version label; it moves only with the standard text. */
export const FIXED_VERSION = 'selfcheck-fixed-4'
/** The session template that holds a session's own domain part. */
export const SELF_CHECK_NAME = '工坊·自查模板'
/** Limits (R106). */
export const DOMAIN_MAX = 600, FIXED_MAX = 400
/** Missing-template hints: every 30 turns, at most 3. */
export const HINT_EVERY = 30, HINT_MAX = 3
export const CONCLUSIONS = ['done', 'waiting', 'continue', 'orphan'] as const
export type Conclusion = typeof CONCLUSIONS[number]

/** The fixed part's seven points, as workbench-market 18 「自查模板」 words them (R106); owner 2026-11-26 (fixed-4) added the goal to point 3, the kind of evidence to point 1 and keeping skills and docs current to point 6. */
export const FIXED_POINTS = [
  '1. 停只有两种合法的形态：做完（说出证据：实测、读回或当前头），或登记等待（已经经单子、决策卡或回执通道交出去；写在回复里不算）。',
  '2. 要等，就说出叫醒条件和期限；叫醒的必须是能开新一轮的东西（a2a 的消息或定时任务）。',
  '3. 先说这一步推进哪个目标、还差什么。能接着做的范围：已授权、可逆、在目标范围内。',
  '4. 等人之前先自查：ygl 里定过没有，资料是不是就在身边。',
  '5. 属主在场的那一轮：不拦停，只核交给属主的是不是本该系统做的事，是的话同时提决策卡。',
  '6. 交结论：用 selfcheck_conclude 交一次（做完、登记等待、接着做、孤儿停，四选一），附证据或叫醒条件、期限、关联的单子或目标；改动让技能、文档过时的，已跟上或已记待办。',
  '7. 本模板是属主预置的常设要求，适用即须执行；在已有授权内推进，属主当下的指令优先。',
] as const

/**
 * Decision-card registration for a2a collaboration (owner 2026-11-25): like a workshop card round that ends with a
 * lesson or a stated no-entry, a check taken while the session holds an open a2a ticket ends with a decision card it
 * submitted or a stated reason for none. Kept outside FIXED_POINTS, which are workbench-market 18's words.
 */
export const CARD_TOOLS: readonly string[] = ['superagent_decision_propose', 'a2a_decision_propose', 'a2a_outbound_request']
export const NO_CARD_MAX = 200
export const CARD_LINE = '【a2a 协作·决策卡登记】你手上有 a2a 单子。本轮结束前二选一：已经提交决策卡的，在 selfcheck_conclude 的 card 写卡号或请求号；不提交的，在 no_card 写一句原因。和不写体会也要登记一样，两项都空不算交了结论。'
/** Why a card registration was recorded not applicable. */
export const CARD_NA_REASON = '工具不可用'

/** DDL of the card registrations: additive and idempotent, so no schema version bump. */
export const SELF_CHECK_CARDS_SQL = `CREATE TABLE IF NOT EXISTS self_check_cards (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'none', 'na')),
  card TEXT,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS self_check_cards_session ON self_check_cards (session_id, seq)`

/** One card registration (wire shape). */
export interface SelfCheckCardRow {
  readonly seq: number
  readonly session_id: string
  readonly turn: number | null
  readonly kind: 'card' | 'none' | 'na'
  readonly card: string | null
  readonly reason: string | null
  readonly at: string
}

/** The fixed part when nobody is present: points 1–4, 6 and 7. */
export const FIXED_ABSENT = [`【工坊·收尾自查｜底线 ${FIXED_VERSION}】`, ...FIXED_POINTS.filter((_, i) => i !== 4)].join('\n')

/** The fixed part when the owner opened this turn: points 5, 6 and 7 only (the turn is not stopped or extended). */
export const FIXED_PRESENT = [`【工坊·收尾自查｜底线 ${FIXED_VERSION}｜属主在场】`, FIXED_POINTS[4], FIXED_POINTS[5], FIXED_POINTS[6]].join('\n')

/** The visible hint for a session without its domain part: workbench-market 18's draft. */
export const MISSING_HINT = [
  '【工坊·自查模板｜提示】',
  '你有进行中的目标，但还没有自己的自查模板。每次收尾时，插件会带上一段固定的底线；你需要补上自己领域的部分，600 字以内，回答四件事：在你这里什么算做完、你常等什么（等谁、经什么通道、通常多久）、收尾前不能省的检查、你这里不能接着做的动作。',
  '只写判断，不写授权；引用你的技能和 ygl 条目，不要抄长文。写好后用写模板的工具（selfcheck_write）交进你自己的会话模板。不用属主确认，以后可以随时改。',
  '本提示由属主安装的插件发出：你有进行中的目标时须补写自查模板；在已有授权内推进，属主当下的指令优先。',
].join('\n')

/** DDL of the v10 log. */
export const SELF_CHECK_SQL = `CREATE TABLE IF NOT EXISTS self_check_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('injected', 'concluded', 'orphan', 'hint', 'no-template', 'written')),
  present INTEGER,
  conclusion TEXT,
  evidence TEXT,
  wake TEXT,
  deadline TEXT,
  ticket TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS self_check_log_session ON self_check_log (session_id, seq)`

/** Additive waiting register: one row per session, including the first suppressed stop. */
export const SELF_CHECK_WAIT_SQL = `CREATE TABLE IF NOT EXISTS self_check_wait (session_id TEXT PRIMARY KEY, wake TEXT NOT NULL, deadline TEXT NOT NULL, deadline_at INTEGER, ticket TEXT, suppressed INTEGER NOT NULL DEFAULT 0, suppressed_at TEXT)`
export interface SelfCheckWait { wake: string; deadline: string; deadline_at: number | null; ticket: string | null; suppressed: boolean; suppressed_at: string | null }

/** One log row (wire shape). */
export interface SelfCheckRow {
  readonly seq: number
  readonly session_id: string
  readonly turn: number | null
  readonly kind: 'injected' | 'concluded' | 'orphan' | 'hint' | 'no-template' | 'written'
  readonly present: boolean | null
  readonly conclusion: Conclusion | null
  readonly evidence: string | null
  readonly wake: string | null
  readonly deadline: string | null
  readonly ticket: string | null
  readonly at: string
}

/** The log over the plugin's own SQLite file. */
export class SelfCheckLog {
  readonly #db: DatabaseSync
  constructor(db: DatabaseSync) { this.#db = db }
  record(row: Omit<SelfCheckRow, 'seq' | 'at'> & { at?: string }): void {
    this.#db.prepare(`INSERT INTO self_check_log (session_id, turn, kind, present, conclusion, evidence, wake, deadline, ticket, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.session_id, row.turn, row.kind, row.present === null ? null : row.present ? 1 : 0, row.conclusion, row.evidence, row.wake, row.deadline, row.ticket, row.at ?? new Date().toISOString())
  }
  list(sessionId: string, limit = 100): SelfCheckRow[] {
    const rows = this.#db.prepare('SELECT * FROM (SELECT * FROM self_check_log WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(sessionId, Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as Array<Omit<SelfCheckRow, 'present'> & { present: number | null }>
    return rows.map(r => ({ ...r, present: r.present === null ? null : r.present === 1 }))
  }
  waiting(sessionId: string): SelfCheckWait | undefined {
    const row = this.#db.prepare('SELECT wake, deadline, deadline_at, ticket, suppressed, suppressed_at FROM self_check_wait WHERE session_id = ?').get(sessionId) as (Omit<SelfCheckWait, 'suppressed'> & { suppressed: number }) | undefined
    return row ? { ...row, suppressed: row.suppressed === 1 } : undefined
  }
  setWaiting(sessionId: string, wake: string, deadline: string, ticket: string | null): void {
    // Free-form legacy deadlines remain externally wakeable; never guess a timezone or create a schedule.
    const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(deadline) ? Date.parse(deadline) : NaN
    this.#db.prepare('INSERT INTO self_check_wait (session_id, wake, deadline, deadline_at, ticket, suppressed, suppressed_at) VALUES (?, ?, ?, ?, ?, 0, NULL) ON CONFLICT(session_id) DO UPDATE SET wake=excluded.wake, deadline=excluded.deadline, deadline_at=excluded.deadline_at, ticket=excluded.ticket, suppressed=0, suppressed_at=NULL')
      .run(sessionId, wake, deadline, Number.isFinite(instant) ? instant : null, ticket)
  }
  clearWaiting(sessionId: string): void { this.#db.prepare('DELETE FROM self_check_wait WHERE session_id = ?').run(sessionId) }
  suppressWaiting(sessionId: string): void {
    if (this.waiting(sessionId)?.suppressed) return
    this.#db.prepare('UPDATE self_check_wait SET suppressed = 1, suppressed_at = ? WHERE session_id = ? AND suppressed = 0').run(new Date().toISOString(), sessionId)
  }
  recordCard(row: Omit<SelfCheckCardRow, 'seq' | 'at'>): void {
    this.#db.prepare('INSERT INTO self_check_cards (session_id, turn, kind, card, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.session_id, row.turn, row.kind, row.card, row.reason, new Date().toISOString())
  }
  cards(sessionId: string, limit = 100): SelfCheckCardRow[] {
    return this.#db.prepare('SELECT * FROM (SELECT * FROM self_check_cards WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(sessionId, Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as SelfCheckCardRow[]
  }
  count(sessionId: string, kind: SelfCheckRow['kind']): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM self_check_log WHERE session_id = ? AND kind = ?').get(sessionId, kind) as { n: number }).n)
  }
}

/** A session's own domain part: the session template named SELF_CHECK_NAME. */
export function domainOf(store: TemplateStore, sessionId: string): { id: string; content: string; version: string | null } | undefined {
  const row = store.list('session', sessionId).find(t => t.name === SELF_CHECK_NAME)
  return row === undefined ? undefined : { id: row.id, content: row.content, version: row.version ?? null }
}

/**
 * Write the calling session's own domain part. Each write keeps the previous text as a stored version and labels the
 * new one `self-r<N>`. A template whose version the owner cleared by editing it on the panel is the owner's: the
 * session cannot overwrite it.
 */
export function writeDomain(store: TemplateStore, log: SelfCheckLog, sessionId: string, text: string): { ok: true; version: string } | { ok: false; code: string; error: string } {
  const body = text.trim()
  if (body === '' || body.length > DOMAIN_MAX) return { ok: false, code: 'length', error: `the domain part is 1..${String(DOMAIN_MAX)} characters` }
  const current = domainOf(store, sessionId)
  if (current === undefined) {
    store.create({ name: SELF_CHECK_NAME, content: body, scope: 'session', session_id: sessionId, description: '收尾自查的领域部分（会话自己写）' })
    const made = domainOf(store, sessionId)!
    store.update(made.id, { content: body, version: 'self-r1' })
    log.record({ session_id: sessionId, turn: null, kind: 'written', present: null, conclusion: null, evidence: null, wake: null, deadline: null, ticket: 'self-r1' })
    return { ok: true, version: 'self-r1' }
  }
  if (current.version === null || !/^self-r\d+$/.test(current.version)) return { ok: false, code: 'owner-edited', error: 'the owner edited this self-check template on the panel; it is theirs now' }
  const next = `self-r${String(Number(current.version.slice(6)) + 1)}`
  store.keepVersion(current.id, current.version, SELF_CHECK_NAME, current.content, 'self-check')
  store.update(current.id, { content: body, version: next })
  log.record({ session_id: sessionId, turn: null, kind: 'written', present: null, conclusion: null, evidence: null, wake: null, deadline: null, ticket: next })
  return { ok: true, version: next }
}

/** The silent self-check message steered at the stop boundary. */
export function renderSelfCheck(turn: number, present: boolean, domain: string | undefined, card = false): UserMessage {
  const fixed = present ? FIXED_PRESENT : FIXED_ABSENT
  const parts = ['<system-reminder>', fixed, ...(card ? [CARD_LINE] : []), ...(domain !== undefined && !present ? ['', '【你自己的领域部分】', domain] : []), '</system-reminder>']
  return createUserMessage({
    content: [{ type: 'text', text: parts.join('\n') }],
    source: { kind: 'prompt-template-selfcheck', turn, present, fixed: FIXED_VERSION } as unknown as UserMessage['source'],
  })
}

/** The visible missing-template hint. */
export function renderHint(turn: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `⚙️ 自查模板提示 · 第 ${String(turn)} 轮\n\n${MISSING_HINT}` }],
    source: { kind: 'user', scheduled: 'prompt-template-selfcheck-hint', turn } as unknown as UserMessage['source'],
  })
}

/** Per-session state of the trigger (memory; the log carries what matters across restarts). */
interface SessionState { injectedTurn?: number; concluded?: boolean; cardDue?: boolean; orphanLogged?: boolean; actions: number; actionsAtCheck?: number; lastHintTurn?: number; attachNext?: UserMessage[] }

type AgentLike = { id: unknown; session: { header: { id: unknown }; snapshotEvents?: () => ReadonlyArray<{ type?: string; data?: { source?: { kind?: string } } }> }; steer?: (message: UserMessage) => void }
type AgentsLike = { roots?: () => unknown[]; turnBoundaryOf?: (session: unknown) => { openTurnStartSeq: number | null } }
type GoalsLike = { get?: (agent: unknown) => { phase?: string } | undefined }
const WAIT_READS = new Set(['read', 'glob', 'grep', 'get_goal', 'a2a_status', 'a2a_tasks', 'a2a_whoami', 'a2a_teams', 'job_output', 'job_list', 'working_directory'])
/** a2a's optional read (dispatcher, PT-4 addition 1): whether a session holds an open a2a ticket. */
type A2aTicketsLike = { hasOpenTicket?: (sessionId: string) => boolean | undefined }

/** What makes a session's work unfinished: an active goal, or an open a2a ticket; `unknown` when a2a gives no answer. */
export function workInHand(goals: GoalsLike | undefined, tickets: A2aTicketsLike | undefined, agent: unknown, sessionId: string): { open: boolean; ticket: boolean; ticketSource: 'a2a' | 'missing' } {
  const goal = goals?.get?.(agent)?.phase === 'active'
  let ticket: boolean | undefined
  try { ticket = typeof tickets?.hasOpenTicket === 'function' ? tickets.hasOpenTicket(sessionId) : undefined } catch { ticket = undefined }
  return { open: goal || ticket === true, ticket: ticket === true, ticketSource: typeof ticket === 'boolean' ? 'a2a' : 'missing' }
}

/** Whether the owner opened this turn: a direct human message in the open turn (as dsh-tool-goal reads it). */
export function ownerPresent(agents: AgentsLike | undefined, agent: AgentLike): boolean {
  try {
    const boundary = agents?.turnBoundaryOf?.(agent.session)
    const start = boundary?.openTurnStartSeq
    if (start === null || start === undefined) return false
    const events = agent.session.snapshotEvents?.() ?? []
    for (let seq = start + 1; seq < events.length; seq++) if (events[seq]?.type === 'user/message' && isHumanSource(events[seq]?.data?.source)) return true
    return false
  } catch {
    // When in doubt, absent: better to run every point than to skip them (#29 review).
    return false
  }
}

/**
 * A direct human message: source kind `user` and none of this plugin's own markers (#29 review). The plugin's visible
 * messages — scheduled templates, event reminders, casts, the missing-template hint — also carry kind `user` (so the
 * chat renders them), but each carries `scheduled`; anything carrying it, or any other marker field, is not a person.
 */
export function isHumanSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const s = source as Record<string, unknown>
  if (s['kind'] !== 'user') return false
  return !('scheduled' in s) && !('turn' in s) && !('items' in s) && !('templates' in s)
}

/**
 * Register the trigger, the two tools and their reads. All of it is inert unless `enabled()`.
 */
export function registerSelfCheck(ctx: Context, store: () => TemplateStore, enabled: () => boolean): { log: () => SelfCheckLog } {
  const sessions = new Map<string, SessionState>()
  const nested = new Map<symbol, { sessionId: string; maintenanceOnly: boolean; wakesWaiting: boolean }>()
  const state = (id: string): SessionState => { let s = sessions.get(id); if (s === undefined) { s = { actions: 0 }; sessions.set(id, s) } return s }
  const log = (): SelfCheckLog => store().selfChecks

  // "New action since the last check" is counted from tool results in the session (R104).
  ctx.on('tools/result', (exec: unknown) => {
    try {
      if (!enabled()) return
      const { agent, name, parent, token } = exec as { agent?: AgentLike; name?: string; parent?: symbol; token?: symbol }
      if (!agent) return
      const sessionId = String(agent.session.header.id)
      let maintenance = !!name && /^(selfcheck_|lesson_)/.test(name)
      let wakesWaiting = !!name && !maintenance && !WAIT_READS.has(name)
      if (name === 'run_code' && typeof token === 'symbol') {
        const children = nested.get(token)
        nested.delete(token)
        maintenance = children?.sessionId === sessionId && children.maintenanceOnly
        if (children?.sessionId === sessionId) wakesWaiting = children.wakesWaiting
      }
      if (typeof parent === 'symbol') {
        const previous = nested.get(parent)
        nested.set(parent, { sessionId, maintenanceOnly: maintenance && (!previous || (previous.sessionId === sessionId && previous.maintenanceOnly)), wakesWaiting: wakesWaiting || (previous?.sessionId === sessionId && previous.wakesWaiting) })
        if (nested.size > 1024) nested.delete(nested.keys().next().value!)
      }
      // Do not inspect untrusted program text. Only observed same-session native children can prove a maintenance-only wrapper.
      if (maintenance) return
      state(sessionId).actions++
      if (wakesWaiting) log().clearWaiting(sessionId)
    } catch { /* never in the way */ }
  })

  ctx.on('session/event' as never, ((session: { header?: { id?: unknown }; id?: unknown }, event: { type?: string; data?: { source?: unknown } }) => {
    if (!enabled() || event.type !== 'user/message') return
    const source = event.data?.source as { kind?: string } | undefined
    if (!isHumanSource(source) && source?.kind !== 'a2a' && source?.kind !== 'schedule') return
    try {
      const id = String(session.header?.id ?? session.id ?? '')
      if (id) { log().clearWaiting(id); state(id).actions++ }
    } catch { /* external input is never blocked by diagnostic persistence */ }
  }) as never)

  let faultReported = false
  ctx.on('agent/turn-stopping', async ({ agent: a, turn, signal }: { agent: unknown; turn: number; signal: AbortSignal }) => {
    if (!enabled() || signal.aborted) return
    try {
      const agent = a as AgentLike
      const agents = ctx.get('agents' as never) as AgentsLike | undefined
      if (agents?.roots !== undefined && !agents.roots().includes(agent)) return
      const sessionId = String(agent.session.header.id)
      const work = workInHand(ctx.get('goals' as never) as GoalsLike | undefined, ctx.get('a2aTickets' as never) as A2aTicketsLike | undefined, agent, sessionId)
      if (!work.open) return
      const s = state(sessionId)
      const waiting = log().waiting(sessionId)
      const present = ownerPresent(agents, agent)
      if (waiting) {
        if (present || (waiting.deadline_at !== null && Date.now() >= waiting.deadline_at)) { log().clearWaiting(sessionId); s.actions++ }
        else { log().suppressWaiting(sessionId); return }
      }
      if (s.injectedTurn === turn) {
        // Asked this turn already: it may stop now; without a conclusion that stop is an orphan.
        if (s.concluded !== true && s.orphanLogged !== true) {
          s.orphanLogged = true
          log().record({ session_id: sessionId, turn, kind: 'orphan', present: null, conclusion: 'orphan', evidence: null, wake: null, deadline: null, ticket: null })
        }
        return
      }
      if (s.actionsAtCheck !== undefined && s.actions <= s.actionsAtCheck) return
      const domain = domainOf(store(), sessionId)
      s.actionsAtCheck = s.actions
      // The ticket source is noted when a2a gave no answer (it was judged on the goal alone).
      const note = work.ticketSource === 'missing' ? 'a2a-ticket-source-missing' : null
      // a2a collaboration: the check also asks for a decision card or a stated reason for none, unless the session has
      // no card tool at all (then recorded not applicable, as a card round without lesson tools is).
      let card = false
      if (work.ticket) {
        if (scopeLacksAll(agent, CARD_TOOLS)) log().recordCard({ session_id: sessionId, turn, kind: 'na', card: null, reason: CARD_NA_REASON })
        else card = true
      }
      s.cardDue = card
      if (present) {
        // Owner present: never extend the turn. The one check rides along at the session's next step instead.
        s.attachNext = [...(s.attachNext ?? []), renderSelfCheck(turn, true, undefined, card)]
        log().record({ session_id: sessionId, turn, kind: 'injected', present: true, conclusion: null, evidence: note, wake: null, deadline: null, ticket: null })
        return
      }
      if (typeof agent.steer !== 'function') return
      s.injectedTurn = turn; s.concluded = false; s.orphanLogged = false
      agent.steer(renderSelfCheck(turn, false, domain?.content, card))
      log().record({ session_id: sessionId, turn, kind: 'injected', present: false, conclusion: null, evidence: note, wake: null, deadline: null, ticket: null })
      if (domain === undefined) {
        const hints = log().count(sessionId, 'hint')
        if (hints < HINT_MAX && (s.lastHintTurn === undefined || turn - s.lastHintTurn >= HINT_EVERY)) {
          s.lastHintTurn = turn
          agent.steer(renderHint(turn))  // only reached when absent (present returned above)
          log().record({ session_id: sessionId, turn, kind: 'hint', present, conclusion: null, evidence: null, wake: null, deadline: null, ticket: null })
          if (hints + 1 === HINT_MAX) log().record({ session_id: sessionId, turn, kind: 'no-template', present, conclusion: null, evidence: null, wake: null, deadline: null, ticket: null })
        }
      }
    } catch (error) {
      if (!faultReported) { faultReported = true; console.error('[dsh-prompt-templates] self-check skipped; further faults stay silent:', error) }
    }
  })

  // Owner-present checks ride along at the next admitted step, without extending the turn they were taken in.
  ctx.on('agent/pre-step', async ({ agent: a, messages }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || messages.length === 0) return decision
    try {
      const sessionId = String((a as unknown as AgentLike).session.header.id)
      const s = sessions.get(sessionId)
      if (s?.attachNext === undefined || s.attachNext.length === 0) return decision
      const attached = s.attachNext
      s.attachNext = undefined
      return { ...decision, messages: [...decision.messages, ...attached] }
    } catch { return decision }
  })

  // The two tools, when this host composes a tool registry. The session is the calling agent's, never a parameter.
  registerWhenToolsReady(ctx, 'self-check', (tools) => {
    const sessionOf = (exec: unknown): string | undefined => { const agent = (exec as { agent?: AgentLike }).agent; return agent === undefined ? undefined : String(agent.session.header.id) }
    tools.register(withOutput({
      name: 'selfcheck_write',
      description: 'Write your own session\'s self-check template: the domain part (at most 600 characters) the wrap-up self-check carries after the fixed part. Answer four things: what counts as done here, what you usually wait for (who, through what, how long), the checks you never skip before stopping, and the actions you must not just continue with here. Write judgement, not authority; cite skills and ygl entries instead of copying. No owner confirmation is needed; each write keeps the previous version. Acts only on the calling session.',
      parameters: objectParameters({ text: { type: 'string', description: 'The domain part, 1..600 characters.' } }, ['text']),
      execute: async (args: { text?: unknown }, exec: unknown) => {
        if (!enabled()) return { ok: false, code: 'disabled', error: 'self-check is off on this host' }
        const sessionId = sessionOf(exec)
        if (sessionId === undefined) return { ok: false, code: 'session', error: 'no calling session' }
        return writeDomain(store(), log(), sessionId, String(args.text ?? ''))
      },
    }))
    tools.register(withOutput({
      name: 'selfcheck_conclude',
      description: 'Give the wrap-up self-check\'s conclusion for your own session, once per check: done (with evidence), waiting (registered: with the wake condition and deadline, and the ticket or card it waits on), continue (the next step you take now), or orphan (none of these). Stopping after a check without concluding is logged as an orphan stop.',
      parameters: objectParameters({
        conclusion: { type: 'string', enum: ['done', 'waiting', 'continue', 'orphan'], description: 'done | waiting | continue | orphan' },
        evidence: { type: 'string', description: 'For done: the evidence (test run, receipt, checksum).' },
        wake: { type: 'string', description: 'For waiting: what wakes you (an a2a message or a schedule).' },
        deadline: { type: 'string', description: 'For waiting: by when, roughly.' },
        ticket: { type: 'string', description: 'The ticket or goal it concerns.' },
        card: { type: 'string', description: 'In a2a collaboration: the decision card (or outbound request) you submitted this round, by its id.' },
        no_card: { type: 'string', description: 'In a2a collaboration: why you submit no decision card this round, in one sentence (1..200 characters).' },
      }, ['conclusion']),
      execute: async (args: { conclusion?: unknown; evidence?: unknown; wake?: unknown; deadline?: unknown; ticket?: unknown; card?: unknown; no_card?: unknown }, exec: unknown) => {
        if (!enabled()) return { ok: false, code: 'disabled', error: 'self-check is off on this host' }
        const sessionId = sessionOf(exec)
        if (sessionId === undefined) return { ok: false, code: 'session', error: 'no calling session' }
        const conclusion = String(args.conclusion ?? '') as Conclusion
        if (!CONCLUSIONS.includes(conclusion)) return { ok: false, code: 'conclusion', error: 'conclusion is done, waiting, continue or orphan' }
        const text = (v: unknown): string | null => { const t = oneLine(String(v ?? '')).slice(0, 500); return t === '' ? null : t }
        const row = { evidence: text(args.evidence), wake: text(args.wake), deadline: text(args.deadline), ticket: text(args.ticket) }
        if (conclusion === 'done' && row.evidence === null) return { ok: false, code: 'evidence', error: 'done needs its evidence' }
        if (conclusion === 'waiting' && (row.wake === null || row.deadline === null)) return { ok: false, code: 'wake', error: 'waiting needs the wake condition and a deadline' }
        const card = oneLine(String(args.card ?? '')).slice(0, 200)
        const noCard = oneLine(String(args.no_card ?? ''))
        if (card !== '' && noCard !== '') return { ok: false, code: 'card', error: 'give the decision card you submitted or the reason for none, not both' }
        if (noCard !== '' && [...noCard].length > NO_CARD_MAX) return { ok: false, code: 'card', error: `no_card is 1..${String(NO_CARD_MAX)} characters` }
        const s = state(sessionId)
        if (s.cardDue === true && card === '' && noCard === '') return { ok: false, code: 'card', error: 'you hold an a2a ticket: give the decision card you submitted this round (card) or one sentence why none (no_card)' }
        if (conclusion === 'waiting') log().setWaiting(sessionId, row.wake!, row.deadline!, row.ticket)
        else log().clearWaiting(sessionId)
        s.concluded = true
        const turn = s.injectedTurn ?? null
        log().record({ session_id: sessionId, turn, kind: 'concluded', present: null, conclusion, ...row })
        if (card !== '' || noCard !== '') log().recordCard({ session_id: sessionId, turn, kind: card !== '' ? 'card' : 'none', card: card === '' ? null : card, reason: noCard === '' ? null : noCard })
        s.cardDue = false
        return { ok: true, ...(card !== '' ? { card } : noCard !== '' ? { card: 'none' } : {}) }
      },
    }))
  })
  return { log }
}
