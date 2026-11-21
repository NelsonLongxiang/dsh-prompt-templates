import { createTestDirectory } from './temp-dir.mjs'
/**
 * 体会 (docs/spec-lesson-inject.md, phases 1 and 2): lessons as session templates, pinned lessons loaded at a start, digest prompts after a settled experience,
 * situational recall, budgets, the v11 migration and the host wiring (tools/result, agent/pre-step, lesson_write, route).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { DEFAULT_EVENT_INJECT_CONFIG, observeToolResult, prepareEventReminders } from '../src/event-inject.ts'
import { extractFeatures } from '../src/event-features.ts'
import type { ObservationFeatures } from '../src/event-features.ts'
import { DEFAULT_LESSONS_CONFIG, LESSON_CATEGORY, allowedTypes, decideLessonType, lessonTimeline, lessonsOf, newLessonState, observeForLessons, pinLesson, prepareLessonMessages, proposeLessonType, writeLesson } from '../src/lessons.ts'
import { contentDigest } from '../src/interventions.ts'
import type { LessonsConfig, LessonState } from '../src/lessons.ts'
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

test('write: a lesson is a typed 体会 session template; one per type; rewriting a type soft-overwrites (old text kept, superseded); the owner\'s edit locks it', () => {
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
    // The owner edits it on the panel: the version is cleared and the session can no longer overwrite that type.
    w.store.update(id, { content: '属主改过的话' })
    assert.equal((w.write('再改一次', '找') as { code: string }).code, 'owner-edited')
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
    assert.ok(text.includes('并标明类型') && text.includes('软覆盖'))
    assert.ok(text.includes('不授予任何权限'))
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

test('recall: a matching call brings the lesson back at the next step after its cooldown, clipped; other calls, sessions and promoted lessons do not', () => {
  const w = world({ ...ON, recallCooldownTurns: 2, maxRecallChars: 40 })
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    const lesson = '别再手工带 TOKEN_X 和解释器路径，先用项目的 make 入口；它会处理环境。这句话故意写长一点，用来看截断。'
    const written = w.write(lesson)
    assert.ok(written.ok)
    const id = written.ok ? written.id : ''
    // Same preparation, another task: same situation. Cooldown counts from the turn it was written (1).
    w.call('TOKEN_X=abc /opt/py/bin/python deploy.py')
    assert.deepEqual(w.step(2), [], 'cooldown from the turn it was written')
    w.call('TOKEN_X=abc /opt/py/bin/python lint.py')
    const recalled = textOf(w.step(3))
    assert.ok(recalled.includes('【工坊·体会·收｜RSI 一轮】别再手工带 TOKEN_X'))
    assert.ok(recalled.includes('适用即须按它调整这一步') && recalled.includes('type: 收'))
    assert.doesNotMatch(recalled, /不适用就忽略|你在同类情境下写的参考/)
    assert.ok(recalled.includes('…'), 'clipped to maxRecallChars')
    assert.ok(recalled.includes('不扩大授权'))
    assert.equal(w.store.lessons.cue(id)?.recall_count, 1)
    assert.equal(w.store.lessons.log(S).at(-1)?.kind, 'recalled')
    w.call('TOKEN_X=abc /opt/py/bin/python test.py')
    assert.deepEqual(w.step(4), [], 'cooldown from the last recall')
    // A different tool or a different preparation and target: no recall.
    w.call('make build')
    assert.deepEqual(w.step(9), [])
    // Another session doing the same thing does not get this session's lesson.
    const other = newLessonState()
    w.call('TOKEN_X=abc /opt/py/bin/python build.py', ok, 'sess-2', other)
    assert.deepEqual(prepareLessonMessages(w.store, other, { ...ON, recallCooldownTurns: 2 }, 'sess-2', 20, 1), [])
    // Promoted to global by the owner: no longer recalled in this session (phase 1 does not cross sessions).
    w.store.makeGlobal(id)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    assert.deepEqual(w.step(30), [])
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
test('pinned (phase 2): only the owner pins, at most maxPinned; loaded once at the next step after a start, within 400 characters; recall skips what is loaded', () => {
  const w = world({ ...ON, maxPinned: 2, recallCooldownTurns: 1 })
  try {
    w.call('make build')
    const ids = ['先跑 make check 再打包。', '报错先看第一条。', 'x'.repeat(160)].map(text => { const r = w.write(text); return r.ok ? r.id : '' })
    const [a, b, c] = ids as [string, string, string]
    assert.equal(w.store.lessons.cue(a)?.pinned, 0, 'a written lesson is not pinned')
    assert.deepEqual(pinLesson(w.store, a, true, 2), { ok: true, id: a, pinned: true })
    assert.equal(pinLesson(w.store, b, true, 2).ok, true)
    assert.equal((pinLesson(w.store, c, true, 2) as { code: string }).code, 'pinned-full')
    assert.equal(pinLesson(w.store, a, true, 2).ok, true, 'pinning a pinned one again is not over the limit')
    assert.equal((pinLesson(w.store, 'nope', true, 2) as { code: string }).code, 'not-found')
    // No start seen: nothing loaded.
    assert.deepEqual(w.step(1), [])
    w.state.pinnedDue = 'compact'
    const loaded = textOf(w.step(2))
    assert.ok(loaded.includes('【工坊·体会｜常驻】'))
    assert.ok(loaded.includes('1. 先跑 make check 再打包。') && loaded.includes('2. 报错先看第一条。'))
    assert.ok(!loaded.includes('xxxx'), 'an unpinned lesson is not loaded')
    assert.ok(loaded.includes('不授予任何权限'))
    assert.deepEqual(w.store.lessons.log(S).filter(r => r.kind === 'pinned-loaded').map(r => [r.template_id, r.origin]), [[a, 'compact'], [b, 'compact']])
    assert.deepEqual(w.step(3), [], 'loaded once per start')
    // Loaded pinned lessons are not recalled again; an unpinned one still is.
    w.call('make build')
    const step4 = textOf(w.step(4))
    assert.ok(step4.includes(`｜RSI 一轮】${'x'.repeat(160)}`), 'the unpinned one is recalled')
    assert.ok(!step4.includes('make check') && !step4.includes('报错先看'), 'the loaded pinned ones are not')
    // Unpin b, pin the long one: 160 + the 15 of a fit in 400; the cap is on characters, oldest first.
    assert.equal(pinLesson(w.store, b, false, 2).ok, true)
    assert.equal(pinLesson(w.store, c, true, 2).ok, true)
    w.state.pinnedDue = 'resume'
    const again = textOf(w.step(5))
    assert.ok(again.includes('1. 先跑 make check 再打包。') && again.includes(`2. ${'x'.repeat(160)}`) && !again.includes('报错先看第一条'))
    w.call('make build')
    const recalled = textOf(w.step(6))
    assert.ok(recalled.includes('｜RSI 一轮】报错先看第一条。'), 'unpinned, it is recalled again')
    // Promoted to global: no longer this session's lesson, so it cannot be pinned or loaded here.
    w.store.makeGlobal(a)
    assert.equal((pinLesson(w.store, a, false, 2) as { code: string }).code, 'not-found')
    w.state.pinnedDue = 'startup'
    const third = textOf(w.step(7))
    assert.ok(third.includes(`1. ${'x'.repeat(160)}`) && !third.includes('make check'))
  } finally { w.store.close() }
})

test('pinned: the characters cap stops before a lesson that would pass 400', () => {
  const w = world({ ...ON, maxPinned: 10 })
  try {
    w.call('make build')
    const ids = [1, 2, 3].map(i => { const r = w.write(String(i).repeat(150)); return r.ok ? r.id : '' })
    for (const id of ids) assert.equal(pinLesson(w.store, id, true, 10).ok, true)
    w.state.pinnedDue = 'startup'
    const text = textOf(w.step(1))
    assert.ok(text.includes('1'.repeat(150)) && text.includes('2'.repeat(150)) && !text.includes('3'.repeat(150)))
  } finally { w.store.close() }
})

test('pinned: a lowered maxPinned caps the load; a lesson pinned since the last start is still recalled until it is loaded', () => {
  const w = world({ ...ON, maxPinned: 1, recallCooldownTurns: 1 })
  try {
    w.call('make build')
    const [a, b] = ['先跑 make check。', '报错先看第一条。'].map(text => { const r = w.write(text); return r.ok ? r.id : '' }) as [string, string]
    // Pinned while the limit was higher; the owner then lowered it to 1.
    assert.equal(pinLesson(w.store, a, true, 5).ok, true)
    assert.equal(pinLesson(w.store, b, true, 5).ok, true)
    w.state.pinnedDue = 'startup'
    const loaded = textOf(w.step(1))
    assert.ok(loaded.includes('1. 先跑 make check。') && !loaded.includes('报错先看'), 'only maxPinned are loaded')
    // b is pinned but not in the context: recall still brings it back.
    w.call('make build')
    assert.ok(textOf(w.step(2)).includes('｜RSI 一轮】报错先看第一条。'))
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

test('host: prompt, write through the tool, recall in the visible channel; the route lists lessons without their text', async () => {
  await withHost({ lessons: { enabled: true, mode: 'visible', recallCooldownTurns: 1 } }, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test', true)
    await result(ctx, 'c2', 'make test')
    const prompt = await preStep(ctx, 1)
    assert.equal(prompt.length, 1)
    assert.equal(prompt[0]?.source?.['kind'], 'user')
    assert.equal(prompt[0]?.source?.['scheduled'], 'prompt-template-lesson')
    assert.match(prompt[0]?.content?.[0]?.text ?? '', /^⚙️ 体会 · 第 1 轮第 1 步/)
    const written = await tools.get('lesson_write')?.execute({ text: '先看第一条报错，再决定要不要重跑。', type: '找' }, { agent: agentOf(S) })
    assert.equal(written?.['ok'], true)
    await result(ctx, 'c3', 'make test', true)
    const recalled = await preStep(ctx, 2)
    assert.ok((recalled[0]?.content?.[0]?.text ?? '').includes('先看第一条报错'))
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.items.length, 1)
    assert.equal(read.body.items[0].origin, 'recovered')
    assert.equal(read.body.items[0].recall_count, 1)
    assert.ok(!JSON.stringify(read.body).includes('先看第一条报错'), 'the route carries no lesson text')
    assert.deepEqual(read.body.log.map((row: { kind: string }) => row.kind), ['prompted', 'written', 'recalled'])
    assert.equal((await request(route, `${BASE}/lessons`)).status, 400)
  })
})

async function created(ctx: Context, source: string): Promise<void> {
  await (ctx as unknown as { serial: (...args: unknown[]) => Promise<unknown> }).serial('agent/created', { agent: agentOf(S), source })
}

test('host (phase 2): the owner pins over PATCH; startup, resume and compact load the pinned lessons at the next step, clear does not', async () => {
  await withHost({ lessons: { enabled: true, maxPinned: 1 } }, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test')
    const first = await tools.get('lesson_write')?.execute({ text: '先看第一条报错。', type: '找' }, { agent: agentOf(S) })
    const second = await tools.get('lesson_write')?.execute({ text: '改配置前先备份。', type: '验' }, { agent: agentOf(S) })
    const id = String(first?.['id']), other = String(second?.['id'])
    assert.equal((await request(route, `${BASE}/lessons/${id}`, 'PATCH', { pinned: 'yes' })).status, 400)
    assert.equal((await request(route, `${BASE}/lessons/missing`, 'PATCH', { pinned: true })).status, 404)
    assert.deepEqual((await request(route, `${BASE}/lessons/${id}`, 'PATCH', { pinned: true })).body, { id, pinned: true })
    const full = await request(route, `${BASE}/lessons/${other}`, 'PATCH', { pinned: true })
    assert.equal(full.status, 409)
    assert.equal(full.body.error.code, 'pinned-full')
    const read = await request(route, `${BASE}/lessons?session_id=${S}`)
    assert.deepEqual(read.body.items.map((item: { pinned: boolean }) => item.pinned), [true, false])
    await created(ctx, 'clear')
    assert.deepEqual(await preStep(ctx, 1), [], 'clear is a fresh start: nothing loaded')
    for (const [turn, source] of [[2, 'startup'], [4, 'resume'], [6, 'compact']] as const) {
      await created(ctx, source)
      const loaded = await preStep(ctx, turn)
      assert.equal(loaded[0]?.source?.['kind'], 'prompt-template-lesson')
      assert.ok((loaded[0]?.content?.[0]?.text ?? '').includes('1. 先看第一条报错。'), source)
      assert.ok(!(loaded[0]?.content?.[0]?.text ?? '').includes('改配置前先备份'))
      assert.deepEqual(await preStep(ctx, turn + 1), [], `${source}: once`)
    }
    const log = (await request(route, `${BASE}/lessons?session_id=${S}`)).body.log as Array<{ kind: string, origin: string }>
    assert.deepEqual(log.filter(row => row.kind === 'pinned-loaded').map(row => row.origin), ['startup', 'resume', 'compact'])
  })
})

test('host (phase 2): off, a start loads nothing', async () => {
  await withHost({}, async ctx => {
    await created(ctx, 'startup')
    assert.deepEqual(await preStep(ctx, 1), [])
  })
})

test('RSI rounds: every recall opens a round; rewriting the recalled lesson or writing a new one closes it; two turns without a write miss it', () => {
  const w = world({ ...ON, recallCooldownTurns: 1 })
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    const first = w.write('别手工带 TOKEN_X，先用 make 入口。')
    assert.ok(first.ok)
    const id = first.ok ? first.id : ''
    assert.equal(first.ok && first.round, null, 'no round open yet')
    // Round 1: recalled at turn 2, closed by rewriting the same lesson.
    w.call('TOKEN_X=abc /opt/py/bin/python lint.py')
    assert.ok(textOf(w.step(2)).includes('RSI 一轮'))
    assert.equal(w.store.lessons.openRounds(S).length, 1)
    const updated = w.write('别手工带 TOKEN_X，先用 make 入口；lint 也走 make lint。', '收')
    assert.equal(updated.ok && updated.round, 'updated')
    assert.equal(w.store.lessons.openRounds(S).length, 0)
    // Round 2: recalled at turn 4, closed by a new lesson.
    w.call('TOKEN_X=abc /opt/py/bin/python test.py')
    assert.ok(textOf(w.step(4)).includes('RSI 一轮'))
    const added = w.write('测试也走 make test，不手拼解释器。')
    assert.equal(added.ok && added.round, 'written')
    // Round 3: recalled at turn 6, nothing written in turns 6 and 7: missed at turn 8.
    w.call('TOKEN_X=abc /opt/py/bin/python deploy.py')
    assert.ok(textOf(w.step(6)).includes('RSI 一轮'))
    w.step(7)
    assert.equal(w.store.lessons.openRounds(S).length, 1, 'still within the grace turn')
    w.step(8)
    assert.equal(w.store.lessons.openRounds(S).length, 0)
    assert.deepEqual(w.store.lessons.rounds(id), { opened: 3, closed: 2, missed: 1 })
    const kinds = w.store.lessons.log(S).map(row => row.kind)
    assert.deepEqual(kinds.filter(k => k.startsWith('round')), ['round-closed', 'round-closed', 'round-missed'])
  } finally { w.store.close() }
})

test('RSI rounds: a lesson the owner edited asks for a new lesson instead of a rewrite', () => {
  const w = world({ ...ON, recallCooldownTurns: 1 })
  try {
    w.step(1)
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    const first = w.write('别手工带 TOKEN_X。')
    const id = first.ok ? first.id : ''
    w.store.update(id, { content: '属主改过：别手工带 TOKEN_X。', version: null })
    w.call('TOKEN_X=abc /opt/py/bin/python lint.py')
    const text = textOf(w.step(2))
    assert.ok(text.includes('这条已归属主，不能改写'))
    assert.doesNotMatch(text, /type: 收/)
    assert.ok(text.includes('写入别的类型'))
  } finally { w.store.close() }
})
