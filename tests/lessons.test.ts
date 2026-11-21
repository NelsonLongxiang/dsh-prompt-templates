import { createTestDirectory } from './temp-dir.mjs'
/**
 * 体会 (docs/spec-lesson-inject.md, phase 1): lessons as session templates, digest prompts after a settled experience,
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
import { DEFAULT_LESSONS_CONFIG, LESSON_CATEGORY, lessonsOf, newLessonState, observeForLessons, prepareLessonMessages, writeLesson } from '../src/lessons.ts'
import type { LessonsConfig, LessonState } from '../src/lessons.ts'
import { TemplateStore } from '../src/store.ts'

const S = 'sess-1'
const ON: LessonsConfig = { ...DEFAULT_LESSONS_CONFIG, enabled: true }
const ok = { isError: false }
const fail = { isError: true, error: { info: { code: 'EXIT_1' } } }
const bash = (command: string, result: { isError: boolean } = ok): ObservationFeatures => extractFeatures('bash', { command }, result as never)

function textOf(messages: unknown[]): string {
  return messages.map(m => ((m as { content: Array<{ text: string }> }).content[0]?.text) ?? '').join('\n')
}

function world(config: LessonsConfig = ON): { store: TemplateStore, state: LessonState, call: (command: string, result?: { isError: boolean }, session?: string, state?: LessonState) => void, step: (turn: number, step?: number) => unknown[], write: (text: string, replace?: unknown) => ReturnType<typeof writeLesson> } {
  const store = new TemplateStore(':memory:')
  const state = newLessonState()
  let n = 0
  return {
    store,
    state,
    call(command, result = ok, session = S, own = state) { n += 1; observeForLessons(store, own, session, `call-${String(n)}`, bash(command, result)) },
    step(turn, step = 1) { return prepareLessonMessages(store, state, config, S, turn, step) },
    write(text, replace) { return writeLesson(store, state, S, text, replace, config) },
  }
}

test('write: a lesson is a 体会 session template; rewrites keep versions; the owner\'s edit locks it; limits; delete takes its cue', () => {
  const w = world({ ...ON, maxPerSession: 2 })
  try {
    w.call('TOKEN_X=abc /opt/py/bin/python build.py')
    assert.equal((w.write('   ') as { code: string }).code, 'length')
    assert.equal((w.write('x'.repeat(161)) as { code: string }).code, 'length')
    const first = w.write('打包前先跑 make check，失败时别原样重试。')
    assert.deepEqual(first.ok && { index: first.index, version: first.version }, { index: 1, version: 'lesson-r1' })
    const id = first.ok ? first.id : ''
    const template = w.store.get(id)
    assert.equal(template?.name, '体会·1')
    assert.equal(template?.scope, 'session')
    assert.equal(template?.session_id, S)
    assert.equal(template?.category, LESSON_CATEGORY)
    assert.equal(template?.inject_enabled, false, 'a lesson is never scheduled')
    const cue = w.store.lessons.cue(id)
    assert.equal(cue?.origin, 'last-call')
    assert.equal(cue?.tool_name, 'bash')
    assert.notEqual(cue?.stable_fingerprint, '', 'bound to the last call\'s preparation')
    // Rewrite: the old text is kept as a version.
    const second = w.write('打包前先跑 make check。', 1)
    assert.equal(second.ok && second.version, 'lesson-r2')
    assert.equal(w.store.get(id)?.content, '打包前先跑 make check。')
    // 160 characters counted as characters, not UTF-16 units.
    assert.equal(w.write('😀'.repeat(160), 1).ok, true)
    // The owner edits it on the panel: the version is cleared and the session can no longer rewrite it.
    w.store.update(id, { content: '属主改过的话' })
    assert.equal((w.write('再改一次', 1) as { code: string }).code, 'owner-edited')
    assert.equal((w.write('不存在', 9) as { code: string }).code, 'not-found')
    assert.equal(w.write('第二条').ok, true)
    assert.equal((w.write('第三条') as { code: string }).code, 'full')
    assert.deepEqual(lessonsOf(w.store, 'other-session'), [], 'lessons belong to their session')
    assert.ok(w.store.delete(id))
    assert.equal(w.store.lessons.cue(id), undefined, 'the cue goes with the template')
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
    assert.ok(recalled.includes('【工坊·体会｜你之前写下的】别再手工带 TOKEN_X'))
    assert.ok(recalled.includes('…'), 'clipped to maxRecallChars')
    assert.ok(recalled.includes('不授予任何权限'))
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

// ---- host wiring ----

const BASE = '/plugins/dsh-prompt-templates'
interface Route { handler: (req: unknown, res: unknown) => void }
type Tool = { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }

async function request(route: Route, url: string): Promise<{ status: number, body: any }> {
  const req = new EventEmitter() as EventEmitter & { method: string, url: string }
  req.method = 'GET'
  req.url = url
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${url}`)), 2000)
    const res = { status: 0, writeHead(code: number) { this.status = code; return this }, end(payload: string) { clearTimeout(timer); resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }) } }
    route.handler(req, res)
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

test('Config keeps lessons off by default', () => {
  const decoded = host.Config({ dbPath: '/tmp/x.sqlite3' }) as { lessons: Record<string, unknown> }
  assert.deepEqual(decoded.lessons, { enabled: false, mode: 'inject', maxPerSession: 20, digestCooldownTurns: 10, recallCooldownTurns: 20, maxRecallChars: 300 })
  assert.throws(() => host.Config({ dbPath: '/tmp/x.sqlite3', lessons: { mode: 'loud' } }))
})

test('host: off by default nothing is prompted, recalled or written', async () => {
  await withHost({}, async (ctx, route, tools) => {
    await result(ctx, 'c1', 'make test', true)
    await result(ctx, 'c2', 'make test')
    assert.deepEqual(await preStep(ctx, 1), [])
    assert.deepEqual(await tools.get('lesson_write')?.execute({ text: 'x' }, { agent: agentOf(S) }), { ok: false, code: 'disabled', error: 'lessons are off on this host' })
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
    const written = await tools.get('lesson_write')?.execute({ text: '先看第一条报错，再决定要不要重跑。' }, { agent: agentOf(S) })
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
