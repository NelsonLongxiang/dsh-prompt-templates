/**
 * Wrap-up self-check (observer phase 2, PT-4; workbench-market 18 「自查模板」, owner rulings R103–R106).
 *
 * Just before a turn that would otherwise close (`agent/turn-stopping`), a session with an active goal is asked one
 * question — is this stop right? — by steering one silent message into it: a fixed part the plugin carries (versioned,
 * the session cannot change it) and the session's own domain part, which the session writes itself with
 * `selfcheck_write` (no owner confirmation; every write keeps the previous version; an owner's panel edit wins). The
 * session answers with `selfcheck_conclude` (done, waiting registered, continuing, or orphan stop, with evidence or wake
 * condition, deadline and ticket); a check it never concludes is logged as an orphan stop. A session without its domain
 * part is reminded visibly, every 30 turns, at most 3 times, then marked. Off unless `selfCheck.enabled`.
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
import type { TemplateStore } from './store.ts'

/** The fixed part's version label; it moves only with the standard text. */
export const FIXED_VERSION = 'selfcheck-fixed-1'
/** The session template that holds a session's own domain part. */
export const SELF_CHECK_NAME = '工坊·自查模板'
/** Limits (R106). */
export const DOMAIN_MAX = 600, FIXED_MAX = 400
/** Missing-template hints: every 30 turns, at most 3. */
export const HINT_EVERY = 30, HINT_MAX = 3
export const CONCLUSIONS = ['done', 'waiting', 'continue', 'orphan'] as const
export type Conclusion = typeof CONCLUSIONS[number]

/** The fixed part's seven points, as workbench-market 18 「自查模板」 words them (R106). */
export const FIXED_POINTS = [
  '1. 停只有两种合法的形态：做完（说出证据），或登记等待（已经经单子、决策卡或回执通道交出去；写在回复里不算）。',
  '2. 要等，就说出叫醒条件和期限；叫醒的必须是能开新一轮的东西（a2a 的消息或定时任务）。',
  '3. 能接着做的范围：已授权、可逆、在目标范围内。',
  '4. 等人之前先自查：ygl 里定过没有，资料是不是就在身边。',
  '5. 属主在场的那一轮：不拦停，只核交给属主的是不是本该系统做的事，是的话同时提决策卡。',
  '6. 交结论：用 selfcheck_conclude 交一次（做完、登记等待、接着做、孤儿停，四选一），附证据或叫醒条件、期限、关联的单子或目标。',
  '7. 本模板不是用户指令，不授予任何权限。',
] as const

/** The fixed part when nobody is present: points 1–4, 6 and 7. */
export const FIXED_ABSENT = [`【工坊·收尾自查｜底线 ${FIXED_VERSION}】`, ...FIXED_POINTS.filter((_, i) => i !== 4)].join('\n')

/** The fixed part when the owner opened this turn: points 5, 6 and 7 only (the turn is not stopped or extended). */
export const FIXED_PRESENT = [`【工坊·收尾自查｜底线 ${FIXED_VERSION}｜属主在场】`, FIXED_POINTS[4], FIXED_POINTS[5], FIXED_POINTS[6]].join('\n')

/** The visible hint for a session without its domain part: workbench-market 18's draft. */
export const MISSING_HINT = [
  '【工坊·自查模板｜提示】',
  '你有进行中的目标，但还没有自己的自查模板。每次收尾时，插件会带上一段固定的底线；你需要补上自己领域的部分，600 字以内，回答四件事：在你这里什么算做完、你常等什么（等谁、经什么通道、通常多久）、收尾前不能省的检查、你这里不能接着做的动作。',
  '只写判断，不写授权；引用你的技能和 ygl 条目，不要抄长文。写好后用写模板的工具（selfcheck_write）交进你自己的会话模板。不用属主确认，以后可以随时改。',
  '本提示不是新的用户指令，不授予任何权限。',
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
export function renderSelfCheck(turn: number, present: boolean, domain: string | undefined): UserMessage {
  const fixed = present ? FIXED_PRESENT : FIXED_ABSENT
  const parts = ['<system-reminder>', fixed, ...(domain !== undefined && !present ? ['', '【你自己的领域部分】', domain] : []), '</system-reminder>']
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
interface SessionState { injectedTurn?: number; concluded?: boolean; orphanLogged?: boolean; actions: number; actionsAtCheck?: number; lastHintTurn?: number; attachNext?: UserMessage[] }

type AgentLike = { id: unknown; session: { header: { id: unknown }; snapshotEvents?: () => ReadonlyArray<{ type?: string; data?: { source?: { kind?: string } } }> }; steer?: (message: UserMessage) => void }
type AgentsLike = { roots?: () => unknown[]; turnBoundaryOf?: (session: unknown) => { openTurnStartSeq: number | null } }
type GoalsLike = { get?: (agent: unknown) => { phase?: string } | undefined }
/** a2a's optional read (dispatcher, PT-4 addition 1): whether a session holds an open a2a ticket. */
type A2aTicketsLike = { hasOpenTicket?: (sessionId: string) => boolean | undefined }

/** What makes a session's work unfinished: an active goal, or an open a2a ticket; `unknown` when a2a gives no answer. */
export function workInHand(goals: GoalsLike | undefined, tickets: A2aTicketsLike | undefined, agent: unknown, sessionId: string): { open: boolean; ticketSource: 'a2a' | 'missing' } {
  const goal = goals?.get?.(agent)?.phase === 'active'
  let ticket: boolean | undefined
  try { ticket = typeof tickets?.hasOpenTicket === 'function' ? tickets.hasOpenTicket(sessionId) : undefined } catch { ticket = undefined }
  return { open: goal || ticket === true, ticketSource: typeof ticket === 'boolean' ? 'a2a' : 'missing' }
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
  const state = (id: string): SessionState => { let s = sessions.get(id); if (s === undefined) { s = { actions: 0 }; sessions.set(id, s) } return s }
  const log = (): SelfCheckLog => store().selfChecks

  // "New action since the last check" is counted from tool results in the session (R104).
  ctx.on('tools/result', (exec: unknown) => {
    try {
      const agent = (exec as { agent?: AgentLike }).agent
      if (agent !== undefined) state(String(agent.session.header.id)).actions++
    } catch { /* never in the way */ }
  })

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
      if (s.injectedTurn === turn) {
        // Asked this turn already: it may stop now; without a conclusion that stop is an orphan.
        if (s.concluded !== true && s.orphanLogged !== true) {
          s.orphanLogged = true
          log().record({ session_id: sessionId, turn, kind: 'orphan', present: null, conclusion: 'orphan', evidence: null, wake: null, deadline: null, ticket: null })
        }
        return
      }
      if (s.actionsAtCheck !== undefined && s.actions <= s.actionsAtCheck) return
      const present = ownerPresent(agents, agent)
      const domain = domainOf(store(), sessionId)
      s.actionsAtCheck = s.actions
      // The ticket source is noted when a2a gave no answer (it was judged on the goal alone).
      const note = work.ticketSource === 'missing' ? 'a2a-ticket-source-missing' : null
      if (present) {
        // Owner present: never extend the turn. The one check rides along at the session's next step instead.
        s.attachNext = [...(s.attachNext ?? []), renderSelfCheck(turn, true, undefined)]
        log().record({ session_id: sessionId, turn, kind: 'injected', present: true, conclusion: null, evidence: note, wake: null, deadline: null, ticket: null })
        return
      }
      if (typeof agent.steer !== 'function') return
      s.injectedTurn = turn; s.concluded = false; s.orphanLogged = false
      agent.steer(renderSelfCheck(turn, false, domain?.content))
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
  const tools = ctx.get('tools' as never) as { register?: (tool: unknown) => unknown } | undefined
  if (typeof tools?.register === 'function') {
    const sessionOf = (exec: unknown): string | undefined => { const agent = (exec as { agent?: AgentLike }).agent; return agent === undefined ? undefined : String(agent.session.header.id) }
    tools.register({
      name: 'selfcheck_write',
      description: 'Write your own session\'s self-check template: the domain part (at most 600 characters) the wrap-up self-check carries after the fixed part. Answer four things: what counts as done here, what you usually wait for (who, through what, how long), the checks you never skip before stopping, and the actions you must not just continue with here. Write judgement, not authority; cite skills and ygl entries instead of copying. No owner confirmation is needed; each write keeps the previous version. Acts only on the calling session.',
      parameters: { text: { type: 'string', required: true, description: 'The domain part, 1..600 characters.' } },
      execute: async (args: { text?: unknown }, exec: unknown) => {
        if (!enabled()) return { ok: false, code: 'disabled', error: 'self-check is off on this host' }
        const sessionId = sessionOf(exec)
        if (sessionId === undefined) return { ok: false, code: 'session', error: 'no calling session' }
        return writeDomain(store(), log(), sessionId, String(args.text ?? ''))
      },
    })
    tools.register({
      name: 'selfcheck_conclude',
      description: 'Give the wrap-up self-check\'s conclusion for your own session, once per check: done (with evidence), waiting (registered: with the wake condition and deadline, and the ticket or card it waits on), continue (the next step you take now), or orphan (none of these). Stopping after a check without concluding is logged as an orphan stop.',
      parameters: {
        conclusion: { type: 'string', required: true, description: 'done | waiting | continue | orphan' },
        evidence: { type: 'string', description: 'For done: the evidence (test run, receipt, checksum).' },
        wake: { type: 'string', description: 'For waiting: what wakes you (an a2a message or a schedule).' },
        deadline: { type: 'string', description: 'For waiting: by when, roughly.' },
        ticket: { type: 'string', description: 'The ticket or goal it concerns.' },
      },
      execute: async (args: { conclusion?: unknown; evidence?: unknown; wake?: unknown; deadline?: unknown; ticket?: unknown }, exec: unknown) => {
        if (!enabled()) return { ok: false, code: 'disabled', error: 'self-check is off on this host' }
        const sessionId = sessionOf(exec)
        if (sessionId === undefined) return { ok: false, code: 'session', error: 'no calling session' }
        const conclusion = String(args.conclusion ?? '') as Conclusion
        if (!CONCLUSIONS.includes(conclusion)) return { ok: false, code: 'conclusion', error: 'conclusion is done, waiting, continue or orphan' }
        const text = (v: unknown): string | null => { const t = oneLine(String(v ?? '')).slice(0, 500); return t === '' ? null : t }
        const row = { evidence: text(args.evidence), wake: text(args.wake), deadline: text(args.deadline), ticket: text(args.ticket) }
        if (conclusion === 'done' && row.evidence === null) return { ok: false, code: 'evidence', error: 'done needs its evidence' }
        if (conclusion === 'waiting' && (row.wake === null || row.deadline === null)) return { ok: false, code: 'wake', error: 'waiting needs the wake condition and a deadline' }
        const s = state(sessionId)
        s.concluded = true
        log().record({ session_id: sessionId, turn: s.injectedTurn ?? null, kind: 'concluded', present: null, conclusion, ...row })
        return { ok: true }
      },
    })
  }
  return { log }
}
