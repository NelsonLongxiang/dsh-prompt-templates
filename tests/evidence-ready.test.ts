import { createTestDirectory } from './temp-dir.mjs'
/**
 * #81 evidence-ready reminders, first stage, with same-shape test data (a fake ticket, version and evidence reference).
 * Delivery is proven only by an observed append of our message and a successful awaited sessions.flush (#82 review R3);
 * everything else is unknown and never resent. Limits are written as literals here, not read from the implementation.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { EVIDENCE_SCHEDULED, prepareEvidence } from '../src/evidence-ready.ts'
import { TemplateStore } from '../src/store.ts'
import { PLUGIN_CALLERS } from '../src/interventions.ts'

const A2A = PLUGIN_CALLERS[0]!
const REF = { ticketId: 'T-test-1', version: 'abcdef0123456789abcdef0123456789abcdef01', ref: 'ygl:evidence/demo-1', action: '是否发起独立复核' }
const HOUR = 3_600_000
type Msg = { source?: { scheduled?: string; items?: Array<{ id: string }> }; content?: Array<{ text?: string }> }
type Flush = 'ok' | 'none' | 'throw' | 'missing'

async function harness(enabled: boolean, existingDir?: string) {
  const dir = existingDir ?? createTestDirectory('pt-evidence-')
  const dbPath = join(dir, 'db.sqlite3')
  const ctx = new Context()
  const flushMode: { value: Flush } = { value: 'ok' }
  const flushes: string[] = []
  ctx.provide('sessions' as never, { flush: async (session: { header: { id: string } }) => {
    flushes.push(session.header.id)
    if (flushMode.value === 'throw') throw new Error('durable write failed')
    if (flushMode.value === 'missing') return undefined
    return flushMode.value === 'ok'
  } } as never)
  const fiber = await ctx.plugin(host, { dbPath, cast: { enabled } })
  const callerCtx = async (pkg: string | undefined): Promise<Context> => {
    let inner: Context | undefined
    await ctx.plugin({ name: 'caller', inject: ['promptTemplates'], apply: (c: Context) => { inner = c } } as never)
    if (pkg !== undefined) (inner as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: pkg } }
    return inner!
  }
  const session = (id: string) => ({ header: { id } })
  // A step with no new messages (a tool-result step): the reminder must still go in.
  const preStep = async (sessionId: string, turn: number, step: number) => await ctx.waterfall('agent/pre-step', {
    agent: { session: session(sessionId) }, messages: [], turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] })) as { kind: string; messages: Msg[] }
  // The host appends a delivered message to the session log: the store publishes it on session/event.
  const land = (sessionId: string, messages: Msg[], scheduled?: string) => {
    for (const m of messages) ctx.emit('session/event' as never, session(sessionId) as never, { type: 'user/message', data: { source: scheduled === undefined ? m.source : { ...m.source, scheduled } } } as never)
  }
  const ours = (out: { messages: Msg[] }) => out.messages.filter(m => m.source?.scheduled === EVIDENCE_SCHEDULED)
  const close = async () => { await fiber.dispose() }
  const dispose = async () => { await close(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, callerCtx, preStep, land, ours, close, dispose, dbPath, dir, flushMode, flushes }
}
const statusOf = (c: Context, sessionId = 's1') => (c.promptTemplates.evidenceReadyStatus({ sessionId }) as { items: Array<{ id: string; state: string; attempts: number; turn: number | null; step: number | null }> }).items

test('#81: off by default; only the recognized caller may hand in or read back', async () => {
  const off = await harness(false)
  try {
    const a2a = await off.callerCtx(A2A)
    assert.equal((a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF }) as { code: string }).code, 'disabled')
    assert.equal(off.ours(await off.preStep('s1', 1, 2)).length, 0)
  } finally { await off.dispose() }
  const h = await harness(true)
  try {
    for (const pkg of ['some-other-plugin', undefined]) {
      const stranger = await h.callerCtx(pkg)
      assert.equal((stranger.promptTemplates.evidenceReady({ sessionId: 's1', ...REF }) as { code: string }).code, 'caller')
      assert.equal((stranger.promptTemplates.evidenceReadyStatus({ sessionId: 's1' }) as { code: string }).code, 'caller')
    }
    const a2a = await h.callerCtx(A2A)
    assert.equal((a2a.promptTemplates.evidenceReady({ sessionId: '', ...REF }) as { code: string }).code, 'session')
    assert.equal((a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, ref: '' }) as { code: string }).code, 'field')
    assert.equal((a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, action: 'x'.repeat(301) }) as { code: string }).code, 'field')
  } finally { await h.dispose() }
})

test('#81: delivered at the very next step, to that session only; persisted only after the append is seen and flushed; a repeat resets nothing', async () => {
  const h = await harness(true)
  try {
    const a2a = await h.callerCtx(A2A)
    const handed = a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF }) as { ok: true; id: string; state: string; created: boolean }
    assert.deepEqual([handed.ok, handed.state, handed.created], [true, 'queued', true])
    assert.equal(h.ours(await h.preStep('s2', 4, 2)).length, 0, 'another session gets nothing')
    const step = h.ours(await h.preStep('s1', 4, 2))
    assert.equal(step.length, 1)
    const text = step[0]!.content?.[0]?.text ?? ''
    for (const part of [REF.ticketId, REF.version, REF.ref, REF.action, A2A, '不是验证结论、授权或实际动作']) assert.ok(text.includes(part), part)
    assert.deepEqual(step[0]!.source?.items?.map(i => i.id), [handed.id])
    assert.deepEqual(statusOf(a2a).map(r => [r.state, r.turn, r.step]), [['prepared', 4, 2]])
    h.land('s1', step)
    assert.equal(h.ours(await h.preStep('s1', 4, 3)).length, 0)
    assert.equal(statusOf(a2a)[0]!.state, 'persisted')
    assert.ok(h.flushes.includes('s1'), 'the durability checkpoint was awaited')
    assert.equal(h.ours(await h.preStep('s1', 5, 1)).length, 0)
    assert.deepEqual(a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF }), { ok: true, id: handed.id, state: 'persisted', created: false })
    assert.equal(h.ours(await h.preStep('s1', 5, 2)).length, 0)
    const rows = a2a.promptTemplates.interventions({ sessionId: 's1' })
    assert.deepEqual(rows.map(r => [r.source, r.caller, r.template_id, r.template_version]), [['plugin', A2A, 'evidence:T-test-1', REF.version]])
    const store = new TemplateStore(h.dbPath)
    try {
      assert.deepEqual(store.lessons.cardStats('s1'), [])
      assert.equal(store.lessons.openCardRounds('s1').length, 0)
      assert.equal(store.lessons.log('s1', 100).length, 0)
    } finally { store.close() }
  } finally { await h.dispose() }
})

test('#82 review R3: appended but the flush throws, has no durable listener, or there is no session store: unknown, never resent', async () => {
  for (const mode of ['throw', 'none', 'missing'] as const) {
    const h = await harness(true)
    try {
      const a2a = await h.callerCtx(A2A)
      a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF })
      const step = h.ours(await h.preStep('s1', 1, 1))
      h.land('s1', step)
      h.flushMode.value = mode
      assert.equal(h.ours(await h.preStep('s1', 1, 2)).length, 0, mode)
      assert.equal(statusOf(a2a)[0]!.state, 'unknown', mode)
      h.flushMode.value = 'ok'
      assert.equal(h.ours(await h.preStep('s1', 1, 3)).length, 0, mode + ': a later good flush does not resend an unknown one')
      assert.equal(statusOf(a2a)[0]!.state, 'unknown', mode)
    } finally { await h.dispose() }
  }
})

test('#82 review R3: prepared before a restart cannot be proven by this process: unknown, never resent', async () => {
  const first = await harness(true)
  try {
    const a2a = await first.callerCtx(A2A)
    a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF })
    assert.equal(first.ours(await first.preStep('s1', 1, 1)).length, 1)
  } catch (error) { await first.dispose(); throw error }
  await first.close()
  const second = await harness(true, first.dir)
  try {
    const again = await second.callerCtx(A2A)
    assert.equal(second.ours(await second.preStep('s1', 2, 1)).length, 0)
    assert.equal(statusOf(again)[0]!.state, 'unknown')
    assert.equal(second.ours(await second.preStep('s1', 2, 2)).length, 0)
  } finally { await second.dispose() }
})

test('#81: never appended (the step did not make it into the log), it is given again, 3 times in all, then failed; a foreign source marker does not count', async () => {
  const h = await harness(true)
  try {
    const a2a = await h.callerCtx(A2A)
    a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF })
    let deliveries = 0
    for (let step = 1; step <= 6; step += 1) {
      const given = h.ours(await h.preStep('s1', 1, step))
      deliveries += given.length
      h.land('s1', given, 'some-other-marker')
    }
    assert.equal(deliveries, 3)
    assert.equal(statusOf(a2a)[0]!.state, 'failed')
  } finally { await h.dispose() }
})

test('#81: a newer version of the ticket supersedes the older one, queued or prepared, and only the newer goes in', async () => {
  const h = await harness(true)
  try {
    const a2a = await h.callerCtx(A2A)
    const v1 = a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, version: 'v1' }) as { id: string }
    const v2 = a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, version: 'v2' }) as { id: string }
    const step = h.ours(await h.preStep('s1', 1, 1))
    assert.deepEqual(step[0]!.source?.items?.map(i => i.id), [v2.id])
    const states = () => Object.fromEntries(statusOf(a2a).map(r => [r.id, r.state]))
    assert.equal(states()[v1.id], 'superseded')
    const v3 = a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, version: 'v3' }) as { id: string }
    const next = h.ours(await h.preStep('s1', 1, 2))
    assert.deepEqual(next[0]!.source?.items?.map(i => i.id), [v3.id])
    assert.equal(states()[v2.id], 'superseded')
  } finally { await h.dispose() }
})

test('#82 review R1: two versions in the same millisecond keep their order: the newer, still absent, is given again, never superseded by the older', () => {
  for (const olderPrepared of [false, true]) {
    const dir = createTestDirectory('pt-evidence-samems-')
    try {
      const dbPath = join(dir, 'db.sqlite3')
      const at = Date.parse('2026-11-23T10:00:00Z'), iso = new Date(at).toISOString()
      let store = new TemplateStore(dbPath)
      const v1 = store.evidence.offer({ sessionId: 's1', ...REF, version: 'v1', caller: A2A }, iso).row
      if (olderPrepared) assert.equal(prepareEvidence(store.evidence, 's1', 1, 1, () => 'absent', at).length, 1)
      const v2 = store.evidence.offer({ sessionId: 's1', ...REF, version: 'v2', caller: A2A }, iso).row
      const given = prepareEvidence(store.evidence, 's1', 1, 2, () => 'absent', at)
      assert.deepEqual(given.map(r => r.id), [v2.id], String(olderPrepared))
      assert.equal(store.evidence.get(v1.id)!.state, 'superseded')
      store.close()
      store = new TemplateStore(dbPath)
      try {
        const again = prepareEvidence(store.evidence, 's1', 2, 1, () => 'absent', at)
        assert.deepEqual(again.map(r => r.id), [v2.id], 'the newer is given again')
      } finally { store.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('#81: a reference that waited more than 24 hours without a step expires and is not delivered', () => {
  const dir = createTestDirectory('pt-evidence-expire-')
  try {
    const store = new TemplateStore(join(dir, 'db.sqlite3'))
    try {
      const at = Date.parse('2026-11-23T10:00:00Z')
      const kept = store.evidence.offer({ sessionId: 's1', ...REF, version: 'kept', caller: A2A }, new Date(at).toISOString()).row
      assert.equal(prepareEvidence(store.evidence, 's1', 9, 1, () => 'absent', at + 24 * HOUR).length, 1, 'exactly 24 hours still goes in')
      assert.equal(store.evidence.get(kept.id)!.state, 'prepared')
      const late = store.evidence.offer({ sessionId: 's2', ...REF, caller: A2A }, new Date(at).toISOString()).row
      assert.equal(prepareEvidence(store.evidence, 's2', 9, 1, () => 'absent', at + 24 * HOUR + 1).length, 0)
      assert.equal(store.evidence.get(late.id)!.state, 'expired')
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
