import { createTestDirectory } from './temp-dir.mjs'
/**
 * 体会 (docs/spec-lesson-inject.md, phases 1 and 2, §5.16): lessons as session templates, the session's lessons handed over at a start, digest prompts after a
 * settled experience, budgets, the v11 migration and the host wiring (tools/result, agent/pre-step, lesson_write, route).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { DEFAULT_EVENT_INJECT_CONFIG, observeToolResult, prepareEventReminders } from '../src/event-inject.ts'
import { extractFeatures } from '../src/event-features.ts'
import type { ObservationFeatures } from '../src/event-features.ts'
import { CHURN_REWRITES, DEFAULT_LESSONS_CONFIG, LESSON_CATEGORY, LESSONS_MUST_READ_LINE, allowedTypes, lessonChurn, lessonKeep, lessonSimilarity, decideLessonType, lessonNone, lessonTimeline, lessonsOf, newLessonState, observeForLessons, openCardRound, pinLesson, prepareLessonMessages, proposeLessonType, renderLessonList, LESSON_LIST_MAX_CHARS, writeLesson } from '../src/lessons.ts'
import { contentDigest } from '../src/interventions.ts'
import type { LessonsConfig, LessonState } from '../src/lessons.ts'
import { lessonToolsMissing } from '../src/inject.ts'
import { TemplateStore } from '../src/store.ts'

const S = 'sess-1'
const TYPES = ['收', '放', '找', '落', '验', '记', '续']
const ON: LessonsConfig = { ...DEFAULT_LESSONS_CONFIG, enabled: true }
const ok = { isError: false }
const fail = { isError: true, error: { info: { code: 'EXIT_1' } } }
const bash = (command: string, result: { isError: boolean } = ok): ObservationFeatures => extractFeatures('bash', { command }, result as never)

function textOf(messages: unknown[]): string {
  return messages.map(m => ((m as { content: Array<{ text: string }> }).content[0]?.text) ?? '').join('\n')
}

function world(config: LessonsConfig = ON): { store: TemplateStore, state: LessonState, call: (command: string, result?: { isError: boolean }, session?: string, state?: LessonState) => void, step: (turn: number, step?: number) => unknown[], write: (text: string, type?: string) => ReturnType<typeof writeLesson> } {
  const store = new TemplateStore(':memory:')
  const state = newLessonState()
  let n = 0
  let next = 0
  return {
    store,
    state,
    call(command, result = ok, session = S, own = state) { n += 1; observeForLessons(store, own, session, `call-${String(n)}`, bash(command, result)) },
    step(turn, step = 1) { return prepareLessonMessages(store, state, config, S, turn, step) },
    write(text, type) { return writeLesson(store, state, S, text, type ?? TYPES[next++ % TYPES.length], config) },
  }
}

test('write: a lesson is a typed 体会 session template; one per type; rewriting a type soft-overwrites (old text kept, superseded), the owner\'s edited text included', () => {
  const w = world()
  try {
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    assert.equal((w.write('   ', '找') as { code: string }).code, 'length')
    assert.equal((w.write('x'.repeat(161), '找') as { code: string }).code, 'length')
    assert.equal((w.write('没类型', 'other') as { code: string }).code, 'type')
    const first = w.write('打包前先跑 make check，失败时别原样重试。', '找')
    assert.deepEqual(first.ok && { type: first.type, version: first.version, superseded: first.superseded }, { type: '找', version: 'lesson-r1', superseded: false })
    const id = first.ok ? first.id : ''
    const template = w.store.get(id)
    assert.equal(template?.name, '体会·找')
    assert.equal(template?.scope, 'session')
    assert.equal(template?.session_id, S)
    assert.equal(template?.category, LESSON_CATEGORY)
    assert.equal(template?.inject_enabled, false, 'a lesson is never scheduled')
    const cue = w.store.lessons.cue(id)
    assert.equal(cue?.origin, 'last-call')
    assert.equal(cue?.tool_name, 'bash')
    assert.notEqual(cue?.stable_fingerprint, '', 'bound to the last call\'s preparation')
    // Same type again: soft overwrite. Same template, old text kept as a version and logged superseded; cue rebound.
    w.call('make release')
    const second = w.write('打包前先跑 make check。', '找')
    assert.deepEqual(second.ok && { id: second.id, version: second.version, superseded: second.superseded }, { id, version: 'lesson-r2', superseded: true })
    assert.equal(w.store.get(id)?.content, '打包前先跑 make check。')
    assert.equal(lessonsOf(w.store, S).filter(lesson => lesson.type === '找').length, 1, 'one lesson per type')
    assert.equal(w.store.lessons.versionText(id, contentDigest('打包前先跑 make check，失败时别原样重试。')), '打包前先跑 make check，失败时别原样重试。', 'the old text is kept')
    assert.deepEqual(w.store.lessons.log(S).map(row => row.kind), ['written', 'superseded', 'written'])
    assert.equal(w.store.lessons.cue(id)?.stable_fingerprint, bash('make release').stableFingerprint, 'the cue follows the latest write')
    // Another type is another lesson; 160 characters counted as characters.
    const other = w.write('😀'.repeat(160), '验')
    assert.equal(other.ok, true)
    assert.deepEqual(lessonsOf(w.store, S).map(lesson => lesson.key), ['找', '验'], 'chain order')
    // The owner edits it on the panel (version cleared). The session may still soft-overwrite it; the owner's text is kept.
    w.store.update(id, { content: '属主改过的话' })
    const over = w.write('再改一次', '找')
    assert.deepEqual(over.ok && { version: over.version, owner_edited: over.owner_edited }, { version: 'lesson-r3', owner_edited: true })
    assert.equal(w.store.lessons.versionText(id, contentDigest('属主改过的话')), '属主改过的话', 'the owner\'s text is kept')
    assert.equal(w.store.lessons.log(S).filter(r => r.kind === 'superseded').at(-1)?.origin, 'owner-edited')
    w.store.update(id, { content: '属主又改了' })
    const again = w.write('第三次', '找')
    assert.equal(again.ok && again.version, 'lesson-r4', 'labels never collide with stored history')
    assert.deepEqual(lessonsOf(w.store, 'other-session'), [], 'lessons belong to their session')
    assert.ok(w.store.delete(id))
    assert.equal(w.store.lessons.cue(id), undefined, 'the cue goes with the template')
  } finally { w.store.close() }
})

test('types: the session proposes its own type; it is usable only after the owner approves; rejected stays unusable; timeline shows it all', () => {
  const w = world()
  try {
    w.call('make build')
    assert.equal((proposeLessonType(w.store, S, '找', '重复', 1) as { code: string }).code, 'builtin')
    assert.equal((proposeLessonType(w.store, S, '12', '编号', 1) as { code: string }).code, 'name')
    assert.equal((proposeLessonType(w.store, S, '协作', '', 1) as { code: string }).code, 'description')
    assert.deepEqual(proposeLessonType(w.store, S, '协作', '跨会话交接时学到的，七类都不贴切', 1), { ok: true, name: '协作', status: 'pending' })
    assert.equal((w.write('交接先写清缺口。', '协作') as { code: string }).code, 'type', 'pending is not usable')
    assert.equal(decideLessonType(w.store, S, '协作', true).ok, true)
    assert.ok(allowedTypes(w.store, S).includes('协作'))
    assert.equal(w.write('交接先写清缺口。', '协作').ok, true)
    proposeLessonType(w.store, S, '杂项', '不知道放哪', 2)
    decideLessonType(w.store, S, '杂项', false)
    assert.equal((w.write('随便写', '杂项') as { code: string }).code, 'type', 'rejected is not usable')
    assert.equal((decideLessonType(w.store, S, '没有', true) as { code: string }).code, 'not-found')
    assert.deepEqual(allowedTypes(w.store, 'sess-2'), ['收', '放', '找', '落', '验', '记', '续'], 'a proposal belongs to its session')
    w.write('交接先写清缺口和期限。', '协作')
    const timeline = lessonTimeline(w.store, S)
    assert.deepEqual(timeline.map(e => [e.kind, e.type]), [
      ['written', '协作'], ['superseded', '协作'], ['type-decided', '杂项'], ['type-proposed', '杂项'], ['written', '协作'], ['type-decided', '协作'], ['type-proposed', '协作'],
    ])
    assert.equal(timeline[0]?.text, '交接先写清缺口和期限。')
    assert.equal(timeline[1]?.text, '交接先写清缺口。', 'the soft-deleted text is in the timeline')
    assert.equal(timeline[2]?.outcome, 'rejected')
    assert.deepEqual(lessonTimeline(w.store, S, 2).length, 2)
    assert.deepEqual(lessonTimeline(w.store, S, 20, '杂项').map(e => e.kind), ['type-decided', 'type-proposed'])
  } finally { w.store.close() }
})

test('digest: a target that failed and then succeeded gets one prompt; the lesson written binds that experience', () => {
  const w = world()
  try {
    w.call('make test', fail)
    assert.deepEqual(w.step(1), [], 'a failure alone settles nothing')
    w.call('make test')
    const prompt = w.step(2)
    assert.equal(prompt.length, 1)
    const text = textOf(prompt)
    assert.match(text, /^<system-reminder>/)
    assert.ok(text.includes('【工坊·体会】刚才这件事（示例：make test）告一段落'))
    assert.ok(text.includes('lesson_write'))
    assert.ok(text.includes('和类型') && text.includes('软覆盖'))
    assert.ok(text.includes('做对了什么、错在哪'), '§5.16: the prompt asks about both sides')
    assert.ok(text.includes('outcome: wrong 或 right') && text.includes('当……时，先……，因为……'))
    assert.ok(text.includes('有可迁移的就必须用 lesson_write') && text.includes('这次无可记'))
    assert.ok(text.includes('不扩大授权') && !text.includes('不是新的用户指令'))
    assert.ok(!/a2a_/.test(text))
    assert.deepEqual(w.step(2, 2), [], 'one digest prompt per turn')
    assert.deepEqual(w.step(30), [], 'the same experience is prompted once')
    // A later unrelated call does not steal the binding: the lesson binds the experience the prompt followed.
    w.call('ls docs')
    const written = w.write('测试先失败再过，别急着重跑，先看第一条报错。')
    assert.ok(written.ok)
    const cue = w.store.lessons.cue(written.ok ? written.id : '')
    assert.equal(cue?.origin, 'recovered')
    assert.equal(cue?.target_fingerprint, bash('make test').targetFingerprint)
    assert.deepEqual(w.store.lessons.log(S).map(row => row.kind), ['prompted', 'written'])
  } finally { w.store.close() }
})

test('digest budget: cooldown between prompts, and three unanswered prompts slow it down threefold', () => {
  const w = world({ ...ON, digestCooldownTurns: 2 })
  try {
    const recover = (target: string): void => { w.call(`make ${target}`, fail); w.call(`make ${target}`) }
    recover('a')
    assert.equal(w.step(1).length, 1)
    recover('b')
    assert.deepEqual(w.step(2), [], 'cooldown (2 turns)')
    assert.equal(w.step(3).length, 1)
    assert.equal(w.step(5).length, 0, 'nothing new to prompt for')
    recover('c')
    assert.equal(w.step(5).length, 1)
    // Three prompts, nothing written: the next one waits 3 × 2 turns after the last.
    recover('d')
    assert.deepEqual(w.step(7), [])
    assert.deepEqual(w.step(10), [])
    assert.equal(w.step(11).length, 1)
    // Writing resets the count.
    assert.equal(w.write('先看报错再重试。').ok, true)
    recover('e')
    assert.equal(w.step(13).length, 1)
  } finally { w.store.close() }
})

test('digest: an event episode whose behaviour changed after a reminder, and a self-check done, each prompt once', () => {
  const w = world()
  try {
    const events = w.store.events
    events.updatePolicy('repeated-preparation', { enabled: true })
    const cfg = { ...DEFAULT_EVENT_INJECT_CONFIG, enabled: true }
    const exec = (n: number, command: string) => ({ callId: `e-${String(n)}`, name: 'bash', arguments: { command }, agent: { session: { header: { id: S } } } })
    for (let n = 1; n <= 3; n += 1) observeToolResult(events, cfg, exec(n, `TOKEN_X=abc /opt/py/bin/python task${String(n)}.py`), ok as never)
    const memo = { scanned: 0, keys: new Set<string>() }
    assert.equal(prepareEventReminders(events, cfg, S, 1, 1, () => [], memo).length, 1)
    observeToolResult(events, cfg, exec(4, 'make build'), ok as never)
    const [episode] = events.episodes(S)
    assert.equal(episode?.signal, 'changed')
    const prompt = textOf(w.step(2))
    assert.ok(prompt.includes('【工坊·体会】'))
    const log = w.store.lessons.log(S)
    assert.equal(log.at(-1)?.origin, 'changed')
    assert.equal(log.at(-1)?.origin_ref, episode?.episode_id)
    assert.deepEqual(w.step(40), [], 'once per episode')
  } finally { w.store.close() }

  const d = world()
  try {
    d.store.selfChecks.record({ session_id: S, turn: 4, kind: 'concluded', present: null, conclusion: 'done', evidence: 'tests pass', wake: null, deadline: null, ticket: null })
    assert.equal(d.step(4).length, 1)
    assert.equal(d.store.lessons.log(S).at(-1)?.origin, 'selfcheck-done')
    assert.deepEqual(d.step(30), [], 'once per conclusion')
  } finally { d.store.close() }

  const stale = world()
  try {
    stale.store.selfChecks.record({ session_id: S, turn: 4, kind: 'concluded', present: null, conclusion: 'done', evidence: 'x', wake: null, deadline: null, ticket: null })
    assert.deepEqual(stale.step(9), [], 'an old conclusion is not an experience that just settled')
  } finally { stale.store.close() }
})

test('§5.16 no recall: a call in a lesson\'s situation injects nothing, opens no round, and only counts toward recurrence', () => {
  const w = world({ ...ON, recallCooldownTurns: 1 })
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    const written = w.write('当要跑构建时，先用项目的 make 入口，因为手带 TOKEN_X 和解释器路径会漏环境。')
    assert.ok(written.ok)
    const id = written.ok ? written.id : ''
    assert.equal(written.ok && written.round, null, 'no round to close')
    for (let turn = 2; turn <= 6; turn += 1) {
      w.call('TOKEN_X=abc /opt/py/bin/python lint.py')
      assert.deepEqual(w.step(turn), [], 'nothing is recalled')
    }
    assert.equal(w.store.lessons.openRounds(S).length, 0)
    assert.ok(!w.store.lessons.log(S).some(row => row.kind === 'recalled'))
    assert.equal(w.store.lessons.recurrence(id).before.hits, 5, 'still counted in the background')
  } finally { w.store.close() }
})

test('v10 databases migrate to v11 in place: the lesson tables are added, templates kept', () => {
  const dir = createTestDirectory('pt-lessons-mig-')
  try {
    const path = join(dir, 'db.sqlite3')
    const first = new TemplateStore(path)
    first.create({ name: 'keep', content: 'body' })
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE lesson_cues; DROP TABLE lesson_log; PRAGMA user_version=10')
    raw.close()
    const reopened = new TemplateStore(path)
    try {
      assert.equal(reopened.list().filter(t => t.name === 'keep').length, 1)
      assert.deepEqual(reopened.lessons.log(S), [])
    } finally { reopened.close() }
    const check = new DatabaseSync(path)
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11)
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    assert.ok(tables.includes('lesson_cues') && tables.includes('lesson_log'))
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('§5.16 deliver: after a start the next step hands over all of the session\'s lessons once — pinned first, then chain order, tagged wrong or right — with how to use them', () => {
  const w = world()
  try {
    w.call('make build')
    assert.deepEqual(w.step(1), [], 'no start seen: nothing handed over')
    const a = writeLesson(w.store, w.state, S, '当报错看着像表面原因时，先拿完整输出。', '找', ON, undefined, 'wrong')
    const b = writeLesson(w.store, w.state, S, '当要动返回字段时，先 grep 所有断言它的测试。', '落', ON, undefined, 'right')
    const c = w.write('当属主只说改时，先不合并。', '收')
    assert.ok(a.ok && b.ok && c.ok)
    assert.deepEqual(lessonsOf(w.store, S).map(l => [l.key, l.outcome]), [['收', null], ['找', 'wrong'], ['落', 'right']])
    assert.equal(pinLesson(w.store, b.ok ? b.id : '', true, 3).ok, true, 'old data: the owner pinned one')
    w.state.deliverDue = 'compact'
    const text = textOf(w.step(2))
    assert.match(text, /^<system-reminder>/)
    assert.ok(text.includes('【工坊·体会｜本会话】你在这个会话里写下的体会（共 3 条）'))
    const order = ['- 落·做对：当要动返回字段时', '- 收：当属主只说改时', '- 找·做错：当报错看着像表面原因时'].map(line => text.indexOf(line))
    assert.ok(order.every(n => n > 0) && order[0]! < order[1]! && order[1]! < order[2]!, 'pinned first, then the chain order')
    assert.ok(text.includes('走到链路哪一环，就看那一类') && text.includes('回头看一眼') && text.includes('lesson_keep'))
    assert.ok(text.indexOf('不扩大授权') < text.indexOf(LESSONS_MUST_READ_LINE), 'the must-read line comes last')
    assert.deepEqual(w.store.lessons.log(S).filter(r => r.kind === 'delivered').map(r => r.origin), ['compact', 'compact', 'compact'])
    assert.deepEqual(w.step(3), [], 'once per start')
    assert.ok(!lessonTimeline(w.store, S, 50).some(e => (e.kind as string) === 'delivered'), 'deliveries stay out of the timeline')
    // Promoted to global: no longer this session's lesson.
    w.store.makeGlobal(c.ok ? c.id : '')
    w.state.deliverDue = 'resume'
    assert.ok(textOf(w.step(4)).includes('（共 2 条）'))
  } finally { w.store.close() }
})

test('§5.16 deliver: the list stops at 1600 characters and names how many are left; no lessons, nothing sent', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ key: `t${String(i)}`, content: 'x'.repeat(150), outcome: null }))
  const text = renderLessonList(many)
  const lines = text.split('\n').filter(line => line.startsWith('- '))
  assert.ok(lines.length < 14 && lines.reduce((n, line) => n + [...line].length, 0) <= LESSON_LIST_MAX_CHARS)
  assert.ok(text.includes(`还有 ${String(14 - lines.length)} 条没列出，用 lesson_timeline 查。`))
  const w = world()
  try {
    w.state.deliverDue = 'startup'
    assert.deepEqual(w.step(1), [])
  } finally { w.store.close() }
})

test('§5.16 outcome: optional on lesson_write, only wrong or right; tied to the text it tags', () => {
  const w = world()
  try {
    const bad = writeLesson(w.store, w.state, S, '当……时，先……', '找', ON, undefined, 'maybe')
    assert.equal(!bad.ok && bad.code, 'outcome')
    assert.equal(lessonsOf(w.store, S).length, 0, 'a refused write writes nothing')
    assert.ok(writeLesson(w.store, w.state, S, '当报错时，先读完整输出。', '找', ON, undefined, 'wrong').ok)
    assert.equal(lessonsOf(w.store, S)[0]?.outcome, 'wrong')
    assert.ok(writeLesson(w.store, w.state, S, '当报错时，先读到出错的那一层。', '找', ON).ok)
    assert.equal(lessonsOf(w.store, S)[0]?.outcome, null, 'an untagged rewrite is untagged')
    assert.ok(writeLesson(w.store, w.state, S, '当报错时，先读到出错的那一层再改。', '找', ON, undefined, 'right').ok)
    assert.equal(lessonsOf(w.store, S)[0]?.outcome, 'right')
  } finally { w.store.close() }
})


// ---- host wiring ----

const BASE = '/plugins/dsh-prompt-templates'
interface Route { handler: (req: unknown, res: unknown) => void }
type Tool = { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }

async function request(route: Route, url: string, method = 'GET', payload?: unknown): Promise<{ status: number, body: any }> {
  const req = new EventEmitter() as EventEmitter & { method: string, url: string }
  req.method = method
  req.url = url
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${url}`)), 2000)
    const res = { status: 0, writeHead(code: number) { this.status = code; return this }, end(payload: string) { clearTimeout(timer); resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }) } }
    route.handler(req, res)
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
}

async function withHost(config: Record<string, unknown>, fn: (ctx: Context, route: Route, tools: Map<string, Tool>) => Promise<void>): Promise<void> {
  const dir = createTestDirectory('pt-lessons-host-')
  const ctx = new Context()
  const routes: Route[] = []
  const tools = new Map<string, Tool>()
  ctx.provide('webServer', { register(route: Route) { routes.push(route); return () => {} } })
  ctx.provide('tools' as never, { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } } as never)
  const fiber = await ctx.plugin(host, { ...config, dbPath: join(dir, 'db.sqlite3') })
  try {
    assert.ok(routes[0])
    await fn(ctx, routes[0], tools)
  } finally {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

const agentOf = (sessionId: string): unknown => ({ session: { header: { id: sessionId }, snapshotEvents: () => [] } })

async function result(ctx: Context, callId: string, command: string, isError = false): Promise<void> {
  const exec = { callId, rootCallId: callId, name: 'bash', arguments: { command }, agent: agentOf(S), signal: new AbortController().signal }
  const outcome = isError ? { isError: true, error: { message: 'x', info: { name: 'E', code: 'EXIT_1' } }, content: [] } : { isError: false, value: null, content: [] }
  await (ctx as unknown as { emit: (...args: unknown[]) => unknown }).emit('tools/result', exec, outcome)
}

async function preStep(ctx: Context, turn: number): Promise<Array<{ source?: Record<string, unknown>, content?: Array<{ text?: string }> }>> {
  const decision = await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<{ messages?: [] }> }).waterfall('agent/pre-step', {
    agent: agentOf(S), messages: [], turn, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages ?? []
}

test('Config turns lessons on by default (owner decision 2026-11-21)', () => {
  const decoded = host.Config({ dbPath: '/tmp/x.sqlite3' }) as { lessons: Record<string, unknown> }
  assert.deepEqual(decoded.lessons, { enabled: true, mode: 'inject', maxPerSession: 20, digestCooldownTurns: 10, recallCooldownTurns: 20, maxRecallChars: 300, maxPinned: 3 })
  assert.throws(() => host.Config({ dbPath: '/tmp/x.sqlite3', lessons: { mode: 'loud' } }))
})

test('host: with no lessons config the tool is live (on by default since 2026-11-21)', async () => {
  await withHost({}, async (_ctx, _route, tools) => {
    const written = await tools.get('lesson_write')?.execute({ text: '先看第一条报错，再决定要不要重跑。', type: '找' }, { agent: agentOf(S) })
    assert.equal(written?.['ok'], true)
  })
})

test('host: with lessons.enabled false nothing is prompted, recalled or written', async () => {
  await withHost({ lessons: { enabled: false } }, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test', true)
    await result(ctx, 'c2', 'make test')
    assert.deepEqual(await preStep(ctx, 1), [])
    assert.deepEqual(await tools.get('lesson_write')?.execute({ text: 'x', type: '找' }, { agent: agentOf(S) }), { ok: false, code: 'disabled', error: 'lessons are off on this host' })
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.deepEqual({ items: read.body.items, log: read.body.log, schema: read.body.schema }, { items: [], log: [], schema: 11 })
  })
})

test('host: prompt, write through the tool (with outcome), hand over at a start in the visible channel; lesson_pin is gone; the route lists lessons without their text', async () => {
  await withHost({ lessons: { enabled: true, mode: 'visible' } }, async (ctx, route, tools) => {
    assert.equal(tools.get('lesson_pin'), undefined, '§5.16: lesson_pin is withdrawn')
    await result(ctx, 'c1', 'make test', true)
    await result(ctx, 'c2', 'make test')
    const prompt = await preStep(ctx, 1)
    assert.equal(prompt.length, 1)
    assert.equal(prompt[0]?.source?.['kind'], 'user')
    assert.equal(prompt[0]?.source?.['scheduled'], 'prompt-template-lesson')
    assert.match(prompt[0]?.content?.[0]?.text ?? '', /^⚙️ 体会 · 第 1 轮第 1 步/)
    const bad = await tools.get('lesson_write')?.execute({ text: '当报错时先看第一条。', type: '找', outcome: 'half' }, { agent: agentOf(S) })
    assert.equal(bad?.['code'], 'outcome')
    const written = await tools.get('lesson_write')?.execute({ text: '当测试先失败再过时，先看第一条报错，再决定要不要重跑。', type: '找', outcome: 'wrong', evidence: 'CI run 7' }, { agent: agentOf(S) })
    assert.equal(written?.['ok'], true)
    await result(ctx, 'c3', 'make test', true)
    assert.deepEqual(await preStep(ctx, 2), [], 'a matching call recalls nothing')
    await created(ctx, 'startup')
    const handed = await preStep(ctx, 3)
    assert.ok((handed[0]?.content?.[0]?.text ?? '').includes('- 找·做错：当测试先失败再过时'))
    assert.equal((await tools.get('lesson_keep')?.execute({ type: '找', evidence: 'make test 第二次先读首条报错后通过' }, { agent: agentOf(S) }))?.['ok'], true, 'a keep needs no round')
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.items.length, 1)
    assert.equal(read.body.items[0].origin, 'recovered')
    assert.equal(read.body.items[0].outcome, 'wrong')
    assert.equal(read.body.items[0].latest_evidence, 'make test 第二次先读首条报错后通过', 'the latest keep wins over the write evidence')
    assert.equal(read.body.items[0].recall_count, 1, 'handed over once')
    assert.ok(!JSON.stringify(read.body).includes('先看第一条报错'), 'the route carries no lesson text')
    assert.deepEqual(read.body.log.map((row: { kind: string }) => row.kind), ['prompted', 'written', 'delivered', 'round-closed'])
    assert.equal((await request(route, `${BASE}/lessons`)).status, 400)
  })
})

test('host (B3b, §5.16): the owner attaches an external verdict to any lesson, recalled or not; it is recorded, closes nothing, and the timeline shows it', async () => {
  await withHost({ lessons: { enabled: true } }, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test', true)
    const written = await tools.get('lesson_write')?.execute({ text: '先看第一条报错，再决定要不要重跑。', type: '找' }, { agent: agentOf(S) })
    const id = String(written?.['id'])
    const before = (await request(route, `${BASE}/lessons?session_id=${S}`)).body.items[0]
    assert.deepEqual(before.verdicts, { pass: 0, fail: 0, latest: null })
    assert.equal((await request(route, `${BASE}/lessons/${id}/verdict`, 'POST', { verdict: 'maybe', ref: 'x' })).status, 400)
    assert.equal((await request(route, `${BASE}/lessons/${id}/verdict`, 'POST', { verdict: 'fail', ref: '  ' })).status, 400)
    assert.equal((await request(route, `${BASE}/lessons/${id}/verdict`, 'POST', { verdict: 'fail', ref: 'x'.repeat(201) })).status, 400)
    assert.equal((await request(route, `${BASE}/lessons/missing/verdict`, 'POST', { verdict: 'fail', ref: 'x' })).status, 404)
    const ok = await request(route, `${BASE}/lessons/${id}/verdict`, 'POST', { verdict: 'fail', ref: 'CI run 42\nred' })
    assert.equal(ok.status, 200, 'never recalled is fine now')
    assert.equal(ok.body.verdict, 'fail')
    assert.equal(ok.body.round, null)
    assert.equal(ok.body.ref, 'CI run 42 red', 'one line')
    assert.equal((await request(route, `${BASE}/lessons/${id}/verdict`, 'POST', { verdict: 'pass', ref: 'PR #9 approved' })).status, 200)
    const after = (await request(route, `${BASE}/lessons?session_id=${S}`)).body.items[0]
    assert.deepEqual(after.rounds, before.rounds, 'a verdict never closes, opens or misses a round')
    assert.equal(after.verdicts.pass, 1)
    assert.equal(after.verdicts.fail, 1)
    assert.equal(after.verdicts.latest.verdict, 'pass')
    assert.equal(after.verdicts.latest.ref, 'PR #9 approved')
    const timeline = await tools.get('lesson_timeline')?.execute({}, { agent: agentOf(S) }) as { entries?: Array<{ kind: string, outcome?: string, evidence?: string, type: string | null }> } | undefined
    const verdicts = (timeline?.entries ?? []).filter(e => e.kind === 'round-verdict')
    assert.deepEqual(verdicts.map(e => [e.outcome, e.evidence, e.type]), [['pass', 'PR #9 approved', '找'], ['fail', 'CI run 42 red', '找']])
  })
})

test('host (B5b): GET /version reports the loaded server version from the package manifest, the schema and the features', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string, version: string }
  await withHost({ lessons: { enabled: false }, cast: { enabled: true } }, async (_ctx, route) => {
    const read = await request(route, `${BASE}/version`)
    assert.equal(read.status, 200)
    assert.equal(read.body.name, manifest.name)
    assert.equal(read.body.version, manifest.version)
    assert.equal(read.body.schema, 11)
    assert.ok(!Number.isNaN(Date.parse(read.body.loaded_at)))
    assert.deepEqual(read.body.features, { inject: true, lessons: false, selfCheck: true, cast: true, eventInject: false })
    assert.equal((await request(route, `${BASE}/version`, 'POST', {})).status, 405)
  })
  assert.deepEqual(host.loadedPackage(new URL('file:///nonexistent/package.json')), { name: 'unknown', version: 'unknown' })
})

async function created(ctx: Context, source: string): Promise<void> {
  await (ctx as unknown as { serial: (...args: unknown[]) => Promise<unknown> }).serial('agent/created', { agent: agentOf(S), source })
}

test('host (§5.16): startup, resume and compact hand over all lessons at the next step, the owner\'s pinned ones first; clear does not; the PATCH route still pins', async () => {
  await withHost({ lessons: { enabled: true, maxPinned: 1 } }, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test')
    const first = await tools.get('lesson_write')?.execute({ text: '先看第一条报错。', type: '找' }, { agent: agentOf(S) })
    const second = await tools.get('lesson_write')?.execute({ text: '改配置前先备份。', type: '验' }, { agent: agentOf(S) })
    const id = String(first?.['id']), other = String(second?.['id'])
    assert.equal((await request(route, `${BASE}/lessons/${id}`, 'PATCH', { pinned: 'yes' })).status, 400)
    assert.equal((await request(route, `${BASE}/lessons/missing`, 'PATCH', { pinned: true })).status, 404)
    assert.deepEqual((await request(route, `${BASE}/lessons/${other}`, 'PATCH', { pinned: true })).body, { id: other, pinned: true })
    const full = await request(route, `${BASE}/lessons/${id}`, 'PATCH', { pinned: true })
    assert.equal(full.status, 409)
    assert.equal(full.body.error.code, 'pinned-full')
    await created(ctx, 'clear')
    assert.deepEqual(await preStep(ctx, 1), [], 'clear is a fresh start: nothing handed over')
    for (const [turn, source] of [[2, 'startup'], [4, 'resume'], [6, 'compact']] as const) {
      await created(ctx, source)
      const loaded = await preStep(ctx, turn)
      const text = loaded[0]?.content?.[0]?.text ?? ''
      assert.equal(loaded[0]?.source?.['kind'], 'prompt-template-lesson')
      assert.ok(text.indexOf('- 验：改配置前先备份。') > 0 && text.indexOf('- 验：') < text.indexOf('- 找：先看第一条报错。'), `${source}: pinned first`)
      assert.deepEqual(await preStep(ctx, turn + 1), [], `${source}: once`)
    }
    const log = (await request(route, `${BASE}/lessons?session_id=${S}`)).body.log as Array<{ kind: string, origin: string }>
    assert.deepEqual(log.filter(row => row.kind === 'delivered').map(row => row.origin), ['startup', 'startup', 'resume', 'resume', 'compact', 'compact'])
  })
})

test('host (phase 2): off, a start loads nothing', async () => {
  await withHost({}, async ctx => {
    await created(ctx, 'startup')
    assert.deepEqual(await preStep(ctx, 1), [])
  })
})

test('card rounds (option A): a workshop injection opens one round per turn; a lesson or a stated no-entry closes it; two turns without either miss it', () => {
  const w = world()
  try {
    const cards = [{ id: 'c-review', name: '工坊-行动审视', version: null }, { id: 'c-accept', name: '工坊-验收流程', version: 'v4' }]
    const line = openCardRound(w.store, S, 1, cards)
    assert.ok(line?.includes('【工坊·卡片轮次】本轮注入了工坊卡（工坊-行动审视、工坊-验收流程）'))
    assert.ok(line?.includes('lesson_write') && line.includes('lesson_none') && line.includes('不扩大授权'))
    assert.equal(openCardRound(w.store, S, 1, cards), null, 'one round per injection turn')
    assert.equal(w.store.lessons.openCardRounds(S).length, 1)
    // Round 1: closed by a lesson; the card round is credited.
    w.call('make build')
    const lesson = w.write('审视时先查已有入口。', '找')
    assert.equal(lesson.ok && lesson.round, 'written')
    assert.equal(w.store.lessons.openCardRounds(S).length, 0)
    // Round 2: closed by a stated no-entry; an empty or long reason is refused.
    openCardRound(w.store, S, 3, [cards[0]!])
    assert.equal((lessonNone(w.store, S, '  ', 3) as { code: string }).code, 'reason')
    assert.equal((lessonNone(w.store, S, 'x'.repeat(121), 3) as { code: string }).code, 'reason')
    assert.deepEqual(lessonNone(w.store, S, '本轮照卡做了，无新发现', 3), { ok: true, round: 'none', card_round: 'card:3' })
    assert.equal((lessonNone(w.store, S, '再来一次', 3) as { code: string }).code, 'no-card-round')
    // Round 3: nothing by turn 7 → missed.
    openCardRound(w.store, S, 5, [cards[1]!])
    w.step(6)
    assert.equal(w.store.lessons.openCardRounds(S).length, 1, 'still within the grace turn')
    w.step(7)
    assert.equal(w.store.lessons.openCardRounds(S).length, 0)
    assert.deepEqual(w.store.lessons.cardStats(S), [
      { template_id: 'c-review', name: '工坊-行动审视', injected: 2, lessons: 1, none: 1, missed: 0, na: 0, recurrence: { hits: 0, fails: 0 } },
      { template_id: 'c-accept', name: '工坊-验收流程', injected: 2, lessons: 1, none: 0, missed: 1, na: 0, recurrence: { hits: 0, fails: 0 } },
    ])
    const timeline = lessonTimeline(w.store, S, 50)
    const none = timeline.find(e => e.kind === 'round-closed' && e.outcome === 'none')
    assert.deepEqual(none && { reason: none.reason, card: none.card }, { reason: '本轮照卡做了，无新发现', card: 'card:3' })
    assert.ok(timeline.some(e => e.kind === 'card-injected' && e.card === '工坊-验收流程'))
    assert.ok(timeline.some(e => e.kind === 'round-missed' && e.card === 'card:5'))
  } finally { w.store.close() }
})

test('card rounds: lesson_none closes only a card round; no digest prompt while a card round is open', () => {
  const w = world({ ...ON, digestCooldownTurns: 1 })
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    w.write('别手工带 TOKEN_X。', '收')
    assert.equal((lessonNone(w.store, S, '不适用', 2) as { code: string; error: string }).code, 'no-card-round')
    openCardRound(w.store, S, 2, [{ id: 'c1', name: '工坊-行动审视', version: null }])
    // A settled experience while the card round is open: no separate digest prompt.
    w.call('make test', { isError: true }); w.call('make test')
    assert.ok(!textOf(w.step(3)).includes('告一段落'), 'the card round already asks')
    assert.equal(lessonNone(w.store, S, '无新发现', 3).ok, true)
    w.call('make test2', { isError: true }); w.call('make test2')
    assert.ok(textOf(w.step(4)).includes('告一段落'), 'digest resumes once no card round is open')
  } finally { w.store.close() }
})

test('host: a scheduled workshop card carries the card-round line and opens the round; lesson_none closes it; the route reports the card yield; non-workshop cards open none', async () => {
  await withHost({ lessons: { enabled: true } }, async (ctx, route, tools) => {
    assert.equal((await request(route, `${BASE}/categories`, 'POST', { name: '工坊', scope: 'global', session_id: null })).status, 200)
    const card = (await request(route, `${BASE}/templates`, 'POST', { name: '工坊-行动审视', content: '先审视实际调用。', scope: 'global', category: '工坊', inject_enabled: true, inject_every: 2, mode: 'inject' })).body.template
    await request(route, `${BASE}/templates`, 'POST', { name: '普通卡', content: '普通内容。', scope: 'global', inject_enabled: true, inject_every: 3, mode: 'inject' })
    const step = async (turn: number) => {
      const decision = await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<{ messages?: Array<{ content?: Array<{ text?: string }> }> }> }).waterfall('agent/pre-step', {
        agent: agentOf(S), messages: [{ role: 'user' }], turn, step: 1, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [] }))
      return (decision.messages ?? []).map(m => m.content?.[0]?.text ?? '').join('\n')
    }
    const two = await step(2)
    assert.ok(two.includes('先审视实际调用。') && two.includes('【工坊·卡片轮次】本轮注入了工坊卡（工坊-行动审视）'))
    const three = await step(3)
    assert.ok(three.includes('普通内容。') && !three.includes('卡片轮次'), 'a non-workshop card opens no round')
    const closed = await tools.get('lesson_none')?.execute({ reason: '照卡审视过，没有新问题' }, { agent: agentOf(S) })
    assert.deepEqual(closed, { ok: true, round: 'none', card_round: 'card:2' })
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.deepEqual(read.body.cards, [{ template_id: card.id, name: '工坊-行动审视', injected: 1, lessons: 0, none: 1, missed: 0, na: 0, recurrence: { hits: 0, fails: 0 } }])
  })
})

// Ticket 091ec9f4: a session whose own tool scope lacks the lesson tools gets a not-applicable round; every other session is unchanged.
const scopeKey = {}
const scopedAgent = (visible: (name: string) => boolean): unknown => ({ session: { header: { id: S }, snapshotEvents: () => [] },
  ctx: { [Symbol('dsh.scope')]: scopeKey, tools: { get: (name: string, scope?: object) => scope === scopeKey && visible(name) ? { name } : undefined } } })
const withoutLessonTools = scopedAgent(name => name !== 'lesson_write' && name !== 'lesson_none')

test('lessonToolsMissing: true only when the agent\'s own scope shows neither lesson_write nor lesson_none', () => {
  assert.equal(lessonToolsMissing(withoutLessonTools), true)
  assert.equal(lessonToolsMissing(scopedAgent(() => true)), false)
  assert.equal(lessonToolsMissing(scopedAgent(name => name !== 'lesson_write')), false, 'lesson_none alone can close a round')
  assert.equal(lessonToolsMissing(scopedAgent(name => name !== 'lesson_none')), false, 'lesson_write alone can close a round')
  assert.equal(lessonToolsMissing(agentOf(S)), false, 'no tool scope is no proof')
  assert.equal(lessonToolsMissing({ ctx: { [Symbol('dsh.scope')]: scopeKey } }), false, 'no tools service is no proof')
  assert.equal(lessonToolsMissing({ ctx: Object.defineProperty({ [Symbol('dsh.scope')]: scopeKey }, 'tools', { get: () => { throw new Error('not injected') } }) }), false, 'a fault is no proof')
  assert.equal(lessonToolsMissing(undefined), false)
})

test('card rounds: without the lesson tools the round is not applicable (never open, never missed); with them nothing changes', () => {
  const w = world()
  try {
    const cards = [{ id: 'c-na', name: '工坊-行动审视', version: null }]
    const line = openCardRound(w.store, S, 1, cards, { lessonToolsMissing: true })
    assert.ok(line?.includes('记为不适用（工具不可用）') && !line.includes('必须用 lesson_write'))
    assert.equal(w.store.lessons.openCardRounds(S).length, 0)
    assert.equal((lessonNone(w.store, S, '没有工具', 1) as { code: string }).code, 'no-card-round')
    w.step(5)
    assert.equal(w.store.lessons.log(S, 100).filter(row => row.kind === 'round-missed').length, 0)
    assert.deepEqual(w.store.lessons.cardStats(S), [{ template_id: 'c-na', name: '工坊-行动审视', injected: 1, lessons: 0, none: 0, missed: 0, na: 1, recurrence: { hits: 0, fails: 0 } }])
    const na = lessonTimeline(w.store, S, 50).find(entry => entry.kind === 'round-na')
    assert.deepEqual(na && { card: na.card, reason: na.reason }, { card: 'card:1', reason: 'tools-unavailable' })
    // With the tools (the default) the same card opens a round that two quiet turns miss.
    assert.ok(openCardRound(w.store, S, 10, cards)?.includes('必须用 lesson_write'))
    assert.equal(w.store.lessons.openCardRounds(S).length, 1)
    w.step(12)
    assert.equal(w.store.lessons.log(S, 100).filter(row => row.kind === 'round-missed').length, 1)
  } finally { w.store.close() }
})

test('host: a workshop card for a session without the lesson tools carries the not-applicable line; with the tools or with no readable scope, the usual round', async () => {
  await withHost({ lessons: { enabled: true } }, async (ctx, route) => {
    await request(route, `${BASE}/categories`, 'POST', { name: '工坊', scope: 'global', session_id: null })
    const card = (await request(route, `${BASE}/templates`, 'POST', { name: '工坊-行动审视', content: '先审视实际调用。', scope: 'global', category: '工坊', inject_enabled: true, inject_every: 1, mode: 'inject' })).body.template
    const step = async (turn: number, agent: unknown) => {
      const decision = await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<{ messages?: Array<{ content?: Array<{ text?: string }> }> }> }).waterfall('agent/pre-step', {
        agent, messages: [{ role: 'user' }], turn, step: 1, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [] }))
      return (decision.messages ?? []).map(m => m.content?.[0]?.text ?? '').join('\n')
    }
    const without = await step(1, withoutLessonTools)
    assert.ok(without.includes('先审视实际调用。') && without.includes('记为不适用（工具不可用）') && !without.includes('必须用 lesson_write'))
    assert.ok((await step(2, scopedAgent(() => true))).includes('必须用 lesson_write'), 'with the tools: the usual round')
    assert.ok((await step(3, agentOf(S))).includes('必须用 lesson_write'), 'no readable scope: the usual round')
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.deepEqual(read.body.cards, [{ template_id: card.id, name: '工坊-行动审视', injected: 3, lessons: 0, none: 0, missed: 0, na: 1, recurrence: { hits: 0, fails: 0 } }])
  })
})

test('host: with lessons off a workshop card is injected without a card round', async () => {
  await withHost({ lessons: { enabled: false } }, async (ctx, route) => {
    await request(route, `${BASE}/categories`, 'POST', { name: '工坊', scope: 'global', session_id: null })
    await request(route, `${BASE}/templates`, 'POST', { name: '工坊-行动审视', content: '先审视实际调用。', scope: 'global', category: '工坊', inject_enabled: true, inject_every: 1, mode: 'visible' })
    const decision = await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<{ messages?: Array<{ content?: Array<{ text?: string }> }> }> }).waterfall('agent/pre-step', {
      agent: agentOf(S), messages: [{ role: 'user' }], turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    const text = (decision.messages ?? []).map(m => m.content?.[0]?.text ?? '').join('\n')
    assert.ok(text.includes('先审视实际调用。') && !text.includes('卡片轮次'))
  })
})

// Owner 2026-11-21 (system RSI loop map, item 2): a recall round may end with a verified keep, but only with evidence.
test('verified keep (§5.16): any lesson that held is kept with evidence, unchanged, no round needed; a bare "still right" or an unknown type is refused; a card round is unaffected', () => {
  const w = world()
  try {
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    const first = w.write('别手工带 TOKEN_X，先用 make 入口。', '收')
    const id = first.ok ? first.id : ''
    const bare = lessonKeep(w.store, S, '收', '仍然对', 2)
    assert.equal(bare.ok, false)
    assert.equal(!bare.ok && bare.code, 'evidence')
    assert.equal(lessonKeep(w.store, S, '验', 'make build 退出 0，日志无 TOKEN_X', 2).ok, false, 'no lesson of that type')
    const kept = lessonKeep(w.store, S, '收', 'make lint 退出 0，命令行里没有 TOKEN_X', 2)
    assert.deepEqual(kept, { ok: true, round: 'kept', type: '收' })
    assert.equal(w.store.get(id)?.content, '别手工带 TOKEN_X，先用 make 入口。', 'the text is unchanged')
    assert.deepEqual(w.store.lessons.rounds(id), { opened: 0, closed: 1, missed: 0, kept: 1 })
    assert.equal(w.store.lessons.latestKeep(id), 'make lint 退出 0，命令行里没有 TOKEN_X')
    const entry = lessonTimeline(w.store, S, 5).find(e => e.kind === 'round-closed')
    assert.equal(entry?.outcome, 'kept')
    assert.equal(entry?.evidence, 'make lint 退出 0，命令行里没有 TOKEN_X')
    // A rewrite makes the old keep stale for the ribbon tab.
    w.write('别手工带 TOKEN_X，先用 make 入口；lint 也走 make。', '收')
    assert.equal(w.store.lessons.latestKeep(id), undefined)
    openCardRound(w.store, S, 3, [{ id: 'card-1', name: '自主推进', version: 'v4' }])
    assert.equal(lessonKeep(w.store, S, '收', 'make lint 退出 0，命令行里没有 TOKEN_X', 3).ok, true)
    assert.equal(w.store.lessons.openCardRounds(S).length, 1, 'a keep does not close a card round')
  } finally { w.store.close() }
})

test('churn hint: three rewrites in a row that change nothing of substance are flagged; a real change clears it; nothing is blocked', () => {
  const w = world(ON)
  try {
    assert.equal(lessonSimilarity('先用 make 入口。', '先用 make 入口！'), 1)
    assert.ok(lessonSimilarity('别手工带 TOKEN_X，先用 make 入口。', 'CI 绿不等于测试跑了，先看测试数') < 0.5)
    const base = '别手工带 TOKEN_X，先用 make build 入口，不手拼解释器路径。'
    const first = w.write(base, '收')
    const id = first.ok ? first.id : ''
    for (let i = 0; i < CHURN_REWRITES - 1; i++) {
      assert.ok(w.write(base + (i % 2 === 0 ? '' : '。'), '收').ok, 'never blocked')
      assert.equal(lessonChurn(w.store, id), false, 'fewer than three rewrites')
    }
    assert.ok(w.write(base + '！', '收').ok)
    assert.equal(lessonChurn(w.store, id), true, 'three near-identical rewrites in a row')
    assert.ok(w.write('报错停在表面就动手会返工；下次先拿完整输出，读到出错的那一层再改。', '收').ok)
    assert.equal(lessonChurn(w.store, id), false, 'a substantive rewrite clears the hint')
  } finally { w.store.close() }
})

// B4a (owner 2026-11-21, system RSI loop map): does the lesson's situation still fail after the lesson is recalled?
test('recurrence: calls matching a lesson are counted before and after it was first handed over, with failures; a card sums its lessons; unknown outcomes are skipped', () => {
  const w = world()
  const failed = { isError: true, error: { info: { code: 'EXIT_1' } } }
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py', failed)
    openCardRound(w.store, S, 1, [{ id: 'c-push', name: '工坊-自主推进', version: 'v4' }])
    const first = w.write('别手工带 TOKEN_X，先用 make 入口。', '收')
    const id = first.ok ? first.id : ''
    assert.equal(first.ok && first.round, 'written', 'the lesson closes the card round')
    w.call('TOKEN_X=abc /opt/py/bin/python lint.py', failed)
    assert.deepEqual(w.store.lessons.recurrence(id), { before: { hits: 1, fails: 1 }, after: { hits: 0, fails: 0 } })
    w.state.deliverDue = 'compact'
    assert.ok(textOf(w.step(2)).includes('别手工带 TOKEN_X'), 'handed over')
    w.call('TOKEN_X=abc /opt/py/bin/python test.py', failed)
    w.call('TOKEN_X=abc /opt/py/bin/python test.py')
    w.call('TOKEN_X=abc /opt/py/bin/python deploy.py')
    assert.deepEqual(w.store.lessons.recurrence(id), { before: { hits: 1, fails: 1 }, after: { hits: 3, fails: 1 } })
    w.call('ls -la')
    assert.equal(w.store.lessons.recurrence(id).after.hits, 3)
    assert.deepEqual(w.store.lessons.cardStats(S).map(card => card.recurrence), [{ hits: 3, fails: 1 }])
    assert.ok(!w.store.lessons.log(S).some(row => (row.kind as string) === 'cue-hit'))
  } finally { w.store.close() }
})

// B2b (owner 2026-11-21, system RSI loop map): a lesson may carry checkable evidence; it is optional and never a gate.
test('evidence: optional on lesson_write, one line, at most 200 characters; tied to the text it backs; shown in the timeline', () => {
  const w = world(ON)
  try {
    const plain = w.write('报错停在表面就动手会返工；下次先拿完整输出。', '找')
    assert.ok(plain.ok, 'no evidence is fine')
    const id = plain.ok ? plain.id : ''
    const tooLong = writeLesson(w.store, w.state, S, 'CI 绿不等于测试跑了；先看测试数。', '验', ON, 'x'.repeat(201))
    assert.equal(!tooLong.ok && tooLong.code, 'evidence')
    assert.equal(lessonsOf(w.store, S).some(l => l.type === '验'), false, 'a refused write writes nothing')
    const backed = writeLesson(w.store, w.state, S, '报错停在表面就动手会返工；下次先读到出错的那一层。', '找', ON, '  dsh-prompt-templates#50\n根因见 #52  ')
    assert.ok(backed.ok)
    const current = lessonsOf(w.store, S).find(l => l.id === id)!
    assert.equal(w.store.lessons.evidence(id, contentDigest(current.content)), 'dsh-prompt-templates#50 根因见 #52', 'trimmed to one line')
    const writes = lessonTimeline(w.store, S, 20).filter(e => e.kind === 'written')
    assert.equal(writes.find(e => e.text === current.content)?.evidence, 'dsh-prompt-templates#50 根因见 #52')
    assert.equal(writes.find(e => e.text === '报错停在表面就动手会返工；下次先拿完整输出。')?.evidence, undefined, 'the earlier write had none')
  } finally { w.store.close() }
})
