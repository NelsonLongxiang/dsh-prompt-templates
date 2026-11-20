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
import { DOMAIN_MAX, FIXED_ABSENT, FIXED_PRESENT, FIXED_MAX, HINT_EVERY, SELF_CHECK_NAME } from '../src/self-check.ts'
import { TemplateStore } from '../src/store.ts'

type Steered = { content?: Array<{ text?: string }>; source?: { kind?: string; scheduled?: string; present?: boolean } }

async function harness(o: { enabled?: boolean; goal?: string } = {}) {
  const dir = createTestDirectory('pt-selfcheck-')
  const dbPath = join(dir, 'db.sqlite3')
  const ctx = new Context()
  const goal = { phase: o.goal ?? 'active' }
  const events: Array<{ type: string; data: { source: { kind: string } } }> = []
  const steered: Steered[] = []
  const agent = { id: 'agent-1', session: { header: { id: 'sess-1' }, snapshotEvents: () => events }, steer: (m: Steered) => { steered.push(m) } }
  const tools = new Map<string, { execute(a: unknown, e: unknown): Promise<Record<string, unknown>> }>()
  ctx.provide('agents' as never, { roots: () => [agent], turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } as never)
  ctx.provide('goals' as never, { get: () => goal } as never)
  ctx.provide('tools' as never, { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } } as never)
  const fiber = await ctx.plugin(host, { dbPath, selfCheck: { enabled: o.enabled ?? true } })
  const stop = async (turn: number, aborted = false) => { const ac = new AbortController(); if (aborted) ac.abort(); await ctx.serial('agent/turn-stopping' as never, { agent, turn, signal: ac.signal } as never) }
  const act = () => ctx.emit('tools/result' as never, { agent } as never, {} as never)
  const call = async (name: string, args: Record<string, unknown>, as = agent) => await tools.get(name)!.execute(args, { agent: as })
  const read = () => { const s = new TemplateStore(dbPath); try { return s.selfChecks.list('sess-1') } finally { s.close() } }
  const humanTurn = () => { events.length = 0; events.push({ type: 'turn', data: { source: { kind: 'x' } } } as never, { type: 'user/message', data: { source: { kind: 'user' } } }) }
  const a2aTurn = () => { events.length = 0; events.push({ type: 'turn', data: { source: { kind: 'x' } } } as never, { type: 'user/message', data: { source: { kind: 'a2a' } } }) }
  const dispose = async () => { await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { goal, steered, tools, stop, act, call, read, humanTurn, a2aTurn, dispose, dbPath }
}

test('the fixed part fits its budget', () => {
  assert.ok(FIXED_ABSENT.length <= FIXED_MAX, `absent ${FIXED_ABSENT.length}`)
  assert.ok(FIXED_PRESENT.length <= FIXED_MAX, `present ${FIXED_PRESENT.length}`)
})

test('off by default: no injection, tools refuse', async () => {
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

test('owner present: only the one check, not the five; absent: the full fixed part plus the domain part', async () => {
  const h = await harness()
  try {
    assert.deepEqual(await h.call('selfcheck_write', { text: '做完 = 测试跑过且回执到了。' }), { ok: true, version: 'self-r1' })
    h.humanTurn(); h.act(); await h.stop(1)
    const present = h.steered.at(-1)!
    assert.equal(present.source?.present, true)
    assert.ok(present.content![0]!.text!.includes('属主在场'))
    assert.ok(!present.content![0]!.text!.includes('做完 = 测试跑过'))
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
