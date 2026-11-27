import { createTestDirectory } from './temp-dir.mjs'
/**
 * Observer phase 2 (PT-4): the wrap-up self-check on a real Cordis context, with stand-ins for the agent registry, the
 * goal service and the tool registry (what a DSH host composes).
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { CARD_LINE, CARD_NA_REASON, DOMAIN_MAX, FIXED_ABSENT, FIXED_PRESENT, FIXED_MAX, FIXED_POINTS, FIXED_VERSION, HINT_EVERY, MISSING_HINT, SELF_CHECK_NAME } from '../src/self-check.ts'
import { TemplateStore } from '../src/store.ts'

type Steered = { content?: Array<{ text?: string }>; source?: { kind?: string; scheduled?: string; present?: boolean } }

async function harness(o: { enabled?: boolean; goal?: string; ticket?: boolean; agentCtx?: unknown } = {}) {
  const dir = createTestDirectory('pt-selfcheck-')
  const dbPath = join(dir, 'db.sqlite3')
  const ctx = new Context()
  const goal = { phase: o.goal ?? 'active' }
  const events: Array<{ type: string; data: { source: { kind: string } } }> = []
  const steered: Steered[] = []
  const agent = { id: 'agent-1', ...(o.agentCtx !== undefined ? { ctx: o.agentCtx } : {}), session: { header: { id: 'sess-1' }, snapshotEvents: () => events }, steer: (m: Steered) => { steered.push(m) } }
  const tools = new Map<string, { execute(a: unknown, e: unknown): Promise<Record<string, unknown>> }>()
  ctx.provide('agents' as never, { roots: () => [agent], turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } as never)
  ctx.provide('goals' as never, { get: () => goal } as never)
  if (o.ticket !== undefined) ctx.provide('a2aTickets' as never, { hasOpenTicket: () => o.ticket } as never)
  ctx.provide('tools' as never, { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } } as never)
  // No explicit switch exercises the shipped default (on since the 2026-11-21 owner decision).
  const fiber = await ctx.plugin(host, { dbPath, ...(o.enabled === undefined ? {} : { selfCheck: { enabled: o.enabled } }) })
  const stop = async (turn: number, aborted = false) => { const ac = new AbortController(); if (aborted) ac.abort(); await ctx.serial('agent/turn-stopping' as never, { agent, turn, signal: ac.signal } as never) }
  const act = () => ctx.emit('tools/result' as never, { agent } as never, {} as never)
  const result = (name: string, rootCallId = 'r', parent?: symbol, token?: symbol) => ctx.emit('tools/result' as never, { agent, name, rootCallId, ...(parent ? { parent } : {}), ...(token ? { token } : {}) } as never, {} as never)
  const wake = (kind: string) => ctx.emit('session/event' as never, agent.session as never, { type: 'user/message', data: { source: { kind } } } as never)
  const call = async (name: string, args: Record<string, unknown>, as = agent) => await tools.get(name)!.execute(args, { agent: as })
  const read = () => { const s = new TemplateStore(dbPath); try { return s.selfChecks.list('sess-1') } finally { s.close() } }
  const humanTurn = () => { events.length = 0; events.push({ type: 'turn', data: { source: { kind: 'x' } } } as never, { type: 'user/message', data: { source: { kind: 'user' } } }) }
  const a2aTurn = () => { events.length = 0; events.push({ type: 'turn', data: { source: { kind: 'x' } } } as never, { type: 'user/message', data: { source: { kind: 'a2a' } } }) }
  const preStep = async (turn: number) => await ctx.waterfall('agent/pre-step' as never, { agent, messages: [{ role: 'user' }], turn, step: 1, signal: new AbortController().signal } as never, (async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] })) as never) as unknown as { messages: Steered[] }
  const dispose = async () => { await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, goal, steered, tools, stop, act, result, wake, call, read, humanTurn, a2aTurn, preStep, dispose, dbPath }
}

test('the fixed part fits its budget', () => {
  assert.ok(FIXED_ABSENT.length <= FIXED_MAX, `absent ${FIXED_ABSENT.length}`)
  assert.ok(FIXED_PRESENT.length <= FIXED_MAX, `present ${FIXED_PRESENT.length}`)
})

test('Config turns the self-check on by default (owner decision 2026-11-21)', () => {
  const decoded = host.Config({ dbPath: '/tmp/x.sqlite3' }) as { selfCheck: Record<string, unknown> }
  assert.deepEqual(decoded.selfCheck, { enabled: true })
  assert.deepEqual((host.Config({ dbPath: '/tmp/x.sqlite3', selfCheck: { enabled: false } }) as { selfCheck: Record<string, unknown> }).selfCheck, { enabled: false })
})

test('selfCheck.enabled false: no injection, tools refuse', async () => {
  const h = await harness({ enabled: false })
  try {
    h.act(); await h.stop(1)
    assert.equal(h.steered.length, 0)
    assert.equal((await h.call('selfcheck_write', { text: 'x' })).code, 'disabled')
  } finally { await h.dispose() }
})

test('fires at the stop boundary only with an active goal and a new action; once a turn; never on abort', async () => {
  const h = await harness()
  try {
    h.goal.phase = 'complete'; h.act(); await h.stop(1)
    assert.equal(h.steered.length, 0, 'no active goal')
    h.goal.phase = 'active'
    await h.stop(2, true)
    assert.equal(h.steered.length, 0, 'aborted turns (errors, the owner stopping) do not trigger')
    h.a2aTurn(); await h.stop(3)
    assert.equal(h.steered.filter(m => m.source?.kind === 'prompt-template-selfcheck').length, 1)
    // The steered check runs another step; when the turn stops again without a conclusion, it is an orphan stop.
    await h.stop(3)
    assert.equal(h.steered.filter(m => m.source?.kind === 'prompt-template-selfcheck').length, 1, 'once a turn')
    assert.deepEqual(h.read().filter(r => r.kind === 'orphan').map(r => r.turn), [3])
    // No new action since the last check: the next stop is accepted.
    await h.stop(4)
    assert.equal(h.steered.filter(m => m.source?.kind === 'prompt-template-selfcheck').length, 1)
    h.act(); await h.stop(5)
    assert.equal(h.steered.filter(m => m.source?.kind === 'prompt-template-selfcheck').length, 2)
  } finally { await h.dispose() }
})

test('#100 maintenance tool results, including nested run_code, do not feed another self-check',async()=>{
  const h=await harness()
  try{
    h.a2aTurn();h.act();await h.stop(1)
    await h.call('selfcheck_conclude',{conclusion:'continue'})
    for(const name of ['selfcheck_conclude','selfcheck_write','lesson_none','lesson_write','lesson_timeline'])h.result(name)
    const nested=Symbol('nested')
    h.result('lesson_none','nested',nested);h.result('selfcheck_conclude','nested',nested);h.result('run_code','nested',undefined,nested)
    await h.stop(2)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,1)
    const mixed=Symbol('mixed')
    h.result('read','mixed',mixed);h.result('lesson_none','mixed',mixed);h.result('run_code','mixed',undefined,mixed);await h.stop(3)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,2)
  }finally{await h.dispose()}
})

test('#100 waiting suppresses automatic self-check once until external input or business work',async()=>{
  const h=await harness()
  try{
    h.a2aTurn();h.act();await h.stop(1)
    assert.equal((await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'a2a receipt',deadline:'2099-01-01T00:00:00Z',ticket:'direct-test'})).ok,true)
    for(let turn=2;turn<7;turn++){
      const root=Symbol('read-only composite')
      h.result('get_goal','read-only',root);h.result('run_code','read-only',undefined,root);await h.stop(turn)
    }
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,1)
    const store=new TemplateStore(h.dbPath)
    try{const waiting=store.selfChecks.waiting('sess-1');assert.equal(waiting?.suppressed,true);assert.ok(waiting?.suppressed_at);const revision=store.revision();store.selfChecks.suppressWaiting('sess-1');assert.deepEqual(store.selfChecks.waiting('sess-1'),waiting);assert.equal(store.revision(),revision,'suppression record is written once, not once per automatic round')}finally{store.close()}
    h.wake('goal');h.wake('prompt-template-selfcheck');await h.stop(7)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,1)
    h.wake('a2a');h.act();await h.stop(8)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,2)
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'schedule',deadline:'2099-01-01T00:00:00Z'})
    h.result('write');await h.stop(9)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,3)
  }finally{await h.dispose()}
})

test('#100 unknown run_code bodies remain business actions; only proven maintenance-only wrappers are excluded',async()=>{
  const h=await harness()
  try{
    h.act();h.a2aTurn();await h.stop(1)
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'a2a',deadline:'2099-01-01T00:00:00Z'})
    h.result('run_code','pure',undefined,Symbol('pure'))
    await h.stop(2)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,2,'a wrapper without observed children may perform IO and must not be classified as maintenance')
  }finally{await h.dispose()}
})

test('#100 waiting register survives reopen and malformed deadline remains externally wakeable',async()=>{
  const h=await harness()
  try{
    h.act();h.a2aTurn();await h.stop(1)
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'a2a',deadline:'今晚'})
    const s=new TemplateStore(h.dbPath)
    try{assert.equal(s.selfChecks.waiting('sess-1')?.deadline_at,null);assert.equal(s.selfChecks.waiting('sess-1')?.wake,'a2a');assert.equal(s.selfChecks.waiting('other'),undefined)}finally{s.close()}
    await h.stop(2);assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,1)
    h.wake('schedule');await h.stop(3)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,2)
  }finally{await h.dispose()}
})

test('#100 deadline, human input, and real schedule wake self-check without changing goal phase',async()=>{
  const h=await harness()
  try{
    h.act();h.a2aTurn();await h.stop(1)
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'schedule',deadline:'2000-01-01T00:00:00Z'})
    h.act();await h.stop(2)
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,2)
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'owner',deadline:'2099-01-01T00:00:00Z'})
    h.humanTurn();h.wake('user');h.act();await h.stop(3)
    assert.ok((await h.preStep(4)).messages.some(m=>m.source?.present===true))
    await h.call('selfcheck_conclude',{conclusion:'waiting',wake:'schedule',deadline:'2099-01-01T00:00:00Z'})
    h.a2aTurn();h.wake('schedule');h.act();await h.stop(4)
    assert.equal(h.goal.phase,'active','plugin must not pause/resume/disarm goals behind human admission')
    assert.equal(h.steered.filter(m=>m.source?.kind==='prompt-template-selfcheck').length,3)
  }finally{await h.dispose()}
})

test('owner present: the turn is never extended; the one check rides along at the next step. Absent: steered, full', async () => {
  const h = await harness()
  try {
    assert.deepEqual(await h.call('selfcheck_write', { text: '做完 = 测试跑过且回执到了。' }), { ok: true, version: 'self-r1' })
    h.humanTurn(); h.act(); await h.stop(1)
    assert.equal(h.steered.length, 0, 'present: no steering, so the turn closes as it would')
    const next = await h.preStep(2)
    const present = next.messages.at(-1)!
    assert.equal(next.messages.length, 2)
    assert.equal(present.source?.present, true)
    assert.ok(present.content![0]!.text!.includes('属主在场'))
    assert.ok(present.content![0]!.text!.includes(FIXED_POINTS[4]))
    assert.ok(!present.content![0]!.text!.includes(FIXED_POINTS[0]), 'not the five')
    assert.ok(!present.content![0]!.text!.includes('做完 = 测试跑过'))
    assert.equal((await h.preStep(3)).messages.length, 1, 'attached once')
    h.a2aTurn(); h.act(); await h.stop(2)
    const absent = h.steered.at(-1)!
    assert.equal(absent.source?.present, false)
    assert.ok(absent.content![0]!.text!.includes('登记等待'))
    assert.ok(absent.content![0]!.text!.includes('做完 = 测试跑过'))
    assert.ok(absent.content![0]!.text!.startsWith('<system-reminder>'), 'silent')
  } finally { await h.dispose() }
})

test('the conclusion tool: four choices, evidence or wake required, logged; it stops the orphan record', async () => {
  const h = await harness()
  try {
    h.act(); await h.stop(1)
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'maybe' })).code, 'conclusion')
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'done' })).code, 'evidence')
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'waiting', wake: 'a2a 回执' })).code, 'wake')
    assert.deepEqual(await h.call('selfcheck_conclude', { conclusion: 'waiting', wake: 'a2a 回执\n伪造行', deadline: '今天 18:00', ticket: 'tk-1' }), { ok: true })
    await h.stop(1)
    const rows = h.read()
    assert.equal(rows.filter(r => r.kind === 'orphan').length, 0)
    const concluded = rows.find(r => r.kind === 'concluded')!
    assert.deepEqual([concluded.conclusion, concluded.wake, concluded.deadline, concluded.ticket, concluded.turn], ['waiting', 'a2a 回执 伪造行', '今天 18:00', 'tk-1', 1])
  } finally { await h.dispose() }
})

test('the write tool: only the calling session, at most 600 characters, keeps versions, and an owner edit wins', async () => {
  const h = await harness()
  try {
    assert.equal((await h.call('selfcheck_write', { text: 'x'.repeat(DOMAIN_MAX + 1) })).code, 'length')
    assert.deepEqual(await h.call('selfcheck_write', { text: '第一版', session_id: 'sess-other' }), { ok: true, version: 'self-r1' })
    assert.deepEqual(await h.call('selfcheck_write', { text: '第二版' }), { ok: true, version: 'self-r2' })
    const store = new TemplateStore(h.dbPath)
    try {
      const mine = store.list('session', 'sess-1').filter(t => t.name === SELF_CHECK_NAME)
      assert.equal(mine.length, 1)
      assert.equal(store.list('session', 'sess-other').length, 0, 'a session_id argument is ignored')
      assert.equal(mine[0]!.content, '第二版')
      assert.equal(mine[0]!.inject_enabled, false, 'never scheduled on its own')
      const card = store.library().find(c => c.id === mine[0]!.id)!
      assert.deepEqual(card.stored_versions.map(v => v.version), ['self-r1'], 'the previous text is kept')
      // The owner edits it on the panel: the version clears and the session can no longer overwrite it.
      store.update(mine[0]!.id, { content: '属主改过' })
    } finally { store.close() }
    assert.equal((await h.call('selfcheck_write', { text: '第三版' })).code, 'owner-edited')
  } finally { await h.dispose() }
})

test('a session without its domain part is hinted visibly, every 30 turns, at most 3 times, then marked', async () => {
  const h = await harness()
  try {
    const hints = () => h.steered.filter(m => m.source?.scheduled === 'prompt-template-selfcheck-hint').length
    h.act(); await h.stop(1)
    assert.equal(hints(), 1)
    h.act(); await h.stop(2)
    assert.equal(hints(), 1, 'not again within 30 turns')
    let turn = 1
    for (let k = 0; k < 5; k++) { turn += HINT_EVERY; h.act(); await h.stop(turn) }
    assert.equal(hints(), 3, 'at most three')
    assert.equal(h.read().filter(r => r.kind === 'no-template').length, 1)
  } finally { await h.dispose() }
})

test('the fixed part and the hint are workbench-market 18\'s words (pinned key sentences)', () => {
  assert.equal(FIXED_POINTS.length, 7)
  assert.ok(FIXED_POINTS[0].includes('停只有两种合法的形态：做完（说出证据：实测、读回或当前头），或登记等待'))
  assert.ok(FIXED_POINTS[0].includes('写在回复里不算'), 'a question written in the reply is not registered')
  assert.ok(FIXED_POINTS[1].includes('叫醒的必须是能开新一轮的东西（a2a 的消息或定时任务）'))
  assert.ok(FIXED_POINTS[2].includes('能接着做的范围：已授权、可逆、在目标范围内。'))
  assert.ok(FIXED_POINTS[3].includes('等人之前先自查：ygl 里定过没有，资料是不是就在身边。'))
  assert.ok(FIXED_POINTS[4].includes('属主在场的那一轮：不拦停，只核交给属主的是不是本该系统做的事，是的话同时提决策卡。'))
  assert.equal(FIXED_POINTS[6], '7. 本模板是属主预置的常设要求，适用即须执行；在已有授权内推进，属主当下的指令优先。')
  for (const point of [0, 1, 2, 3, 5, 6]) assert.ok(FIXED_ABSENT.includes(FIXED_POINTS[point]!))
  assert.ok(!FIXED_ABSENT.includes(FIXED_POINTS[4]))
  assert.ok(MISSING_HINT.startsWith('【工坊·自查模板｜提示】'))
  assert.ok(MISSING_HINT.includes('回答四件事：在你这里什么算做完、你常等什么（等谁、经什么通道、通常多久）、收尾前不能省的检查、你这里不能接着做的动作。'))
  assert.ok(MISSING_HINT.includes('只写判断，不写授权'))
  assert.ok(MISSING_HINT.endsWith('本提示由属主安装的插件发出：你有进行中的目标时须补写自查模板；在已有授权内推进，属主当下的指令优先。'))
  assert.doesNotMatch(MISSING_HINT, /不是新的用户指令/)
})

test('an open a2a ticket counts as work in hand; without a2a\'s answer, the goal decides and the source is noted', async () => {
  const withTicket = await harness({ goal: 'none', ticket: true })
  try {
    withTicket.act(); await withTicket.stop(1)
    assert.equal(withTicket.steered.filter(m => m.source?.kind === 'prompt-template-selfcheck').length, 1, 'no goal, but a ticket in hand')
    assert.equal(withTicket.read().find(r => r.kind === 'injected')?.evidence, null)
  } finally { await withTicket.dispose() }
  const noTicket = await harness({ goal: 'none', ticket: false })
  try {
    noTicket.act(); await noTicket.stop(1)
    assert.equal(noTicket.steered.length, 0, 'no goal, no ticket: nothing in hand')
  } finally { await noTicket.dispose() }
  const noA2a = await harness({ goal: 'active' })
  try {
    noA2a.act(); await noA2a.stop(1)
    assert.equal(noA2a.read().find(r => r.kind === 'injected')?.evidence, 'a2a-ticket-source-missing')
  } finally { await noA2a.dispose() }
})

test('the service tells readers whether the self-check is on', async () => {
  for (const enabled of [false, true]) {
    const h = await harness({ enabled })
    try {
      assert.equal(h.ctx.promptTemplates.selfCheckEnabled(), enabled)
      assert.deepEqual(h.ctx.promptTemplates.selfChecks('sess-1'), [])
    } finally { await h.dispose() }
  }
})

test('#29 review: the plugin\'s own visible messages never count as the owner being present', async () => {
  const { isHumanSource, ownerPresent } = await import('../src/self-check.ts')
  const { renderVisibleInjectionMessage } = await import('../src/inject.ts')
  const { renderEventReminder } = await import('../src/event-inject.ts')
  const { renderCastMessage } = await import('../src/cast.ts')
  const { renderHint } = await import('../src/self-check.ts')
  const sources: Record<string, unknown> = {
    scheduled: (renderVisibleInjectionMessage(2, [{ id: 't', name: 'n', content: 'c', every: 2, mode: 'visible' }]) as unknown as { source: unknown }).source,
    event: (renderEventReminder(2, 1, 'visible', ['b'], [{ dedup_key: 'd', episode_id: 'e', rule: 'repeated-failure@1', evidence_revision: 1 }]) as unknown as { source: unknown }).source,
    cast: (renderCastMessage(2, 1, [{ templateId: 't', name: 'n', version: null, content: 'c', caller: 'x', reason: 'r', at: 0 }] as never, 's') as unknown as { source: unknown }).source,
    hint: (renderHint(2) as unknown as { source: unknown }).source,
  }
  for (const [name, source] of Object.entries(sources)) {
    assert.equal((source as { kind?: string }).kind, 'user', `${name} renders as a user message`)
    assert.equal(isHumanSource(source), false, `${name} is not a person`)
    const agent = { id: 'a', session: { header: { id: 's' }, snapshotEvents: () => [{ type: 'turn' }, { type: 'user/message', data: { source } }] } }
    assert.equal(ownerPresent({ turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } as never, agent as never), false, name)
  }
  assert.equal(isHumanSource({ kind: 'user' }), true)
  assert.equal(isHumanSource({ kind: 'a2a' }), false)
  assert.equal(isHumanSource(undefined), false)
  // In doubt (a broken registry), absent.
  assert.equal(ownerPresent({ turnBoundaryOf: () => { throw new Error('x') } } as never, { id: 'a', session: { header: { id: 's' } } } as never), false)
})

test('#29 review: selfChecks gives the a2a plugin the rows whole and any other plugin a summary only', async () => {
  const h = await harness()
  try {
    h.act(); await h.stop(1)
    await h.call('selfcheck_conclude', { conclusion: 'waiting', wake: '回执', deadline: '2026-11-20T09:00:00Z', ticket: 'tk-1' })
    let a2a: Context | undefined, stranger: Context | undefined
    await h.ctx.plugin({ name: 'a', inject: ['promptTemplates'], apply: (c: Context) => { a2a = c } } as never)
    await h.ctx.plugin({ name: 'b', inject: ['promptTemplates'], apply: (c: Context) => { stranger = c } } as never)
    ;(a2a as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: '@nelsonlongxiang/dsh-open-a2a-net' } }
    ;(stranger as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: 'some-other-plugin' } }
    const full = a2a!.promptTemplates.selfChecks('sess-1').find(r => r.kind === 'concluded')!
    assert.deepEqual([full.wake, full.deadline, full.ticket], ['回执', '2026-11-20T09:00:00Z', 'tk-1'])
    const summary = stranger!.promptTemplates.selfChecks('sess-1').find(r => r.kind === 'concluded')!
    assert.deepEqual([summary.conclusion, summary.session_id, summary.evidence, summary.wake, summary.deadline, summary.ticket], ['waiting', 'sess-1', null, null, null, null])
  } finally { await h.dispose() }
})

test('#29 review (N7, N5): a done conclusion\'s evidence is masked for other plugins and for a caller with no entry', async () => {
  const h = await harness()
  try {
    h.act(); await h.stop(1)
    assert.deepEqual(await h.call('selfcheck_conclude', { conclusion: 'done', evidence: 'EVIDENCE-TEXT 测试跑过 rc=0' }), { ok: true })
    let a2a: Context | undefined, stranger: Context | undefined, noEntry: Context | undefined
    await h.ctx.plugin({ name: 'a', inject: ['promptTemplates'], apply: (c: Context) => { a2a = c } } as never)
    await h.ctx.plugin({ name: 'b', inject: ['promptTemplates'], apply: (c: Context) => { stranger = c } } as never)
    await h.ctx.plugin({ name: 'c', inject: ['promptTemplates'], apply: (c: Context) => { noEntry = c } } as never)
    ;(a2a as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: '@nelsonlongxiang/dsh-open-a2a-net' } }
    ;(stranger as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: 'some-other-plugin' } }
    const done = (c: Context) => c.promptTemplates.selfChecks('sess-1').find(r => r.kind === 'concluded')!
    assert.equal(done(a2a!).evidence, 'EVIDENCE-TEXT 测试跑过 rc=0')
    assert.equal(done(stranger!).evidence, null)
    assert.equal(done(noEntry!).evidence, null, 'no loader entry: summary only')
    assert.equal(done(noEntry!).conclusion, 'done')
    assert.ok(!JSON.stringify(noEntry!.promptTemplates.selfChecks('sess-1')).includes('EVIDENCE-TEXT'))
  } finally { await h.dispose() }
})

test('a2a collaboration: a check with an open ticket ends with a decision card or a stated reason for none (owner 2026-11-25)', async () => {
  const h = await harness({ goal: 'none', ticket: true })
  const cards = () => { const st = new TemplateStore(h.dbPath); try { return st.selfChecks.cards('sess-1') } finally { st.close() } }
  try {
    h.act(); await h.stop(1)
    const check = h.steered.find(m => m.source?.kind === 'prompt-template-selfcheck')
    assert.ok(check?.content?.[0]?.text?.includes(CARD_LINE), 'the check carries the card line')
    const bare = await h.call('selfcheck_conclude', { conclusion: 'continue' })
    assert.equal(bare.code, 'card', 'neither a card nor a reason: refused')
    assert.equal(h.read().filter(r => r.kind === 'concluded').length, 0, 'a refused conclusion is not logged')
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'continue', card: 'd-1', no_card: 'x' })).code, 'card', 'not both')
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'continue', no_card: 'x'.repeat(201) })).code, 'card', 'reason too long')
    assert.deepEqual(await h.call('selfcheck_conclude', { conclusion: 'continue', card: 'decision 42' }), { ok: true, card: 'decision 42' })
    h.act(); await h.stop(2)
    assert.deepEqual(await h.call('selfcheck_conclude', { conclusion: 'waiting', wake: 'a2a 回执', deadline: '今晚', no_card: '本轮只是在等回执，没有要属主取舍的事' }), { ok: true, card: 'none' })
    assert.deepEqual(cards().map(r => [r.turn, r.kind, r.card, r.reason]), [[1, 'card', 'decision 42', null], [2, 'none', null, '本轮只是在等回执，没有要属主取舍的事']])
  } finally { await h.dispose() }

  // No ticket in hand: no card line, no card required, nothing registered.
  const goalOnly = await harness({ goal: 'active', ticket: false })
  try {
    goalOnly.act(); await goalOnly.stop(1)
    assert.ok(!goalOnly.steered.find(m => m.source?.kind === 'prompt-template-selfcheck')?.content?.[0]?.text?.includes(CARD_LINE))
    assert.deepEqual(await goalOnly.call('selfcheck_conclude', { conclusion: 'continue' }), { ok: true })
  } finally { await goalOnly.dispose() }

  // A ticket in hand but a confirmed scope without any card tool: recorded not applicable, not required.
  const scope = {}
  const agentCtx = { [Symbol('dsh.scope')]: scope, tools: { get: () => undefined } }
  const na = await harness({ goal: 'none', ticket: true, agentCtx })
  try {
    na.act(); await na.stop(1)
    assert.ok(!na.steered.find(m => m.source?.kind === 'prompt-template-selfcheck')?.content?.[0]?.text?.includes(CARD_LINE))
    assert.deepEqual(await na.call('selfcheck_conclude', { conclusion: 'continue' }), { ok: true })
    const st = new TemplateStore(na.dbPath)
    try { assert.deepEqual(st.selfChecks.cards('sess-1').map(r => [r.kind, r.reason]), [['na', CARD_NA_REASON]]) } finally { st.close() }
  } finally { await na.dispose() }
})

test('a2a collaboration, owner present: the attached check carries the card line too', async () => {
  const h = await harness({ goal: 'none', ticket: true })
  try {
    h.humanTurn(); h.act(); await h.stop(1)
    const out = await h.preStep(2)
    assert.ok(out.messages.some(m => m.content?.[0]?.text?.includes(CARD_LINE)))
    assert.equal((await h.call('selfcheck_conclude', { conclusion: 'done', evidence: 'x' })).code, 'card')
  } finally { await h.dispose() }
})

test('forward wording (owner 2026-11-25): point 7 leads with the action', () => {
  assert.equal(FIXED_POINTS[6], '7. 本模板是属主预置的常设要求，适用即须执行；在已有授权内推进，属主当下的指令优先。')
})

test('goal, evidence and upkeep (owner 2026-11-26): the fixed part moved to selfcheck-fixed-4', () => {
  assert.equal(FIXED_VERSION, 'selfcheck-fixed-4')
  assert.ok(FIXED_POINTS[0].includes('做完（说出证据：实测、读回或当前头）'), 'point 1 names what counts as evidence')
  assert.ok(FIXED_POINTS[2].startsWith('3. 先说这一步推进哪个目标、还差什么。'), 'point 3 asks for the goal first')
  assert.ok(FIXED_POINTS[5].includes('改动让技能、文档过时的，已跟上或已记待办'), 'point 6 asks whether skills and docs kept up')
  for (const text of [FIXED_ABSENT, FIXED_PRESENT]) assert.ok(text.includes('selfcheck-fixed-4'))
  assert.ok(FIXED_ABSENT.includes(FIXED_POINTS[2]!) && FIXED_ABSENT.includes(FIXED_POINTS[5]!))
  assert.ok(FIXED_PRESENT.includes(FIXED_POINTS[5]!), 'the owner-present turn also gets the upkeep question')
  assert.ok(FIXED_ABSENT.length <= FIXED_MAX && FIXED_PRESENT.length <= FIXED_MAX)
})
