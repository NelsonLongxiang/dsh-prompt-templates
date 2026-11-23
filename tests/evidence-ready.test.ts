import { createTestDirectory } from './temp-dir.mjs'
/**
 * #81 evidence-ready reminders, first stage, with same-shape test data (a fake ticket, version and evidence reference):
 * the next actionable step, read-back from the session log, repeats, newer versions, restart and the boundaries.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { EVIDENCE_MAX_ATTEMPTS, EVIDENCE_SCHEDULED, EVIDENCE_WAIT_MS, prepareEvidence } from '../src/evidence-ready.ts'
import { TemplateStore } from '../src/store.ts'

const A2A = '@nelsonlongxiang/dsh-open-a2a-net'
const REF = { ticketId: 'T-test-1', version: 'abcdef0123456789abcdef0123456789abcdef01', ref: 'ygl:evidence/demo-1', action: '是否发起独立复核' }
type Msg = { source?: { scheduled?: string; items?: Array<{ id: string }> }; content?: Array<{ text?: string }> }

async function harness(enabled: boolean) {
  const dir = createTestDirectory('pt-evidence-')
  const dbPath = join(dir, 'db.sqlite3')
  const ctx = new Context()
  const fiber = await ctx.plugin(host, { dbPath, cast: { enabled } })
  const callerCtx = async (pkg: string | undefined): Promise<Context> => {
    let inner: Context | undefined
    await ctx.plugin({ name: 'caller', inject: ['promptTemplates'], apply: (c: Context) => { inner = c } } as never)
    if (pkg !== undefined) (inner as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: pkg } }
    return inner!
  }
  // A step with no new messages (a tool-result step): the reminder must still go in.
  const preStep = async (sessionId: string, turn: number, step: number, log: Msg[] = []) => await ctx.waterfall('agent/pre-step', {
    agent: { session: { header: { id: sessionId }, snapshotEvents: () => log.map(m => ({ type: 'user/message', data: { source: m.source } })) } }, messages: [], turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] })) as { kind: string; messages: Msg[] }
  const ours = (out: { messages: Msg[] }) => out.messages.filter(m => m.source?.scheduled === EVIDENCE_SCHEDULED)
  const dispose = async () => { await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, callerCtx, preStep, ours, dispose, dbPath }
}

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

test('#81: delivered at the very next step, even one with no new messages, to that session only; read back from the log; a repeat resets nothing', async () => {
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
    const status = () => (a2a.promptTemplates.evidenceReadyStatus({ sessionId: 's1' }) as { items: Array<{ state: string; turn: number | null; step: number | null }> }).items
    assert.deepEqual(status().map(r => [r.state, r.turn, r.step]), [['prepared', 4, 2]])
    // The next step finds it in the durable log: persisted, never sent again.
    assert.equal(h.ours(await h.preStep('s1', 4, 3, step)).length, 0)
    assert.equal(status()[0]!.state, 'persisted')
    assert.equal(h.ours(await h.preStep('s1', 5, 1, step)).length, 0)
    // A repeat of the same reference adds nothing and keeps the delivered state.
    assert.deepEqual(a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF }), { ok: true, id: handed.id, state: 'persisted', created: false })
    assert.equal(h.ours(await h.preStep('s1', 5, 2, step)).length, 0)
    // The intervention log records a plugin delivery; no workshop card round and no card statistics.
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

test('#81: missing from the log, it is given again, at most EVIDENCE_MAX_ATTEMPTS times, then failed', async () => {
  const h = await harness(true)
  try {
    const a2a = await h.callerCtx(A2A)
    a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF })
    let deliveries = 0
    for (let step = 1; step <= EVIDENCE_MAX_ATTEMPTS + 2; step += 1) deliveries += h.ours(await h.preStep('s1', 1, step)).length
    assert.equal(deliveries, EVIDENCE_MAX_ATTEMPTS)
    assert.equal((a2a.promptTemplates.evidenceReadyStatus({ sessionId: 's1' }) as { items: Array<{ state: string; attempts: number }> }).items[0]!.state, 'failed')
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
    const states = () => Object.fromEntries((a2a.promptTemplates.evidenceReadyStatus({ sessionId: 's1' }) as { items: Array<{ id: string; state: string }> }).items.map(r => [r.id, r.state]))
    assert.equal(states()[v1.id], 'superseded')
    // v2 was given to a step but the step never made it to the log; v3 arrives: v2 is superseded, not sent again.
    const v3 = a2a.promptTemplates.evidenceReady({ sessionId: 's1', ...REF, version: 'v3' }) as { id: string }
    const next = h.ours(await h.preStep('s1', 1, 2))
    assert.deepEqual(next[0]!.source?.items?.map(i => i.id), [v3.id])
    assert.equal(states()[v2.id], 'superseded')
  } finally { await h.dispose() }
})

test('#81: across a restart the durable rows reconcile against the log; an unreadable log is unknown, never sent again', () => {
  const dir = createTestDirectory('pt-evidence-restart-')
  try {
    const dbPath = join(dir, 'db.sqlite3')
    const at = Date.parse('2026-11-23T10:00:00Z')
    let store = new TemplateStore(dbPath)
    const a = store.evidence.offer({ sessionId: 's1', ...REF, version: 'va', caller: A2A }, new Date(at).toISOString()).row
    const b = store.evidence.offer({ sessionId: 's2', ...REF, version: 'vb', caller: A2A }, new Date(at).toISOString()).row
    assert.equal(prepareEvidence(store.evidence, 's1', 1, 1, [], at).length, 1)
    assert.equal(prepareEvidence(store.evidence, 's2', 1, 1, [], at).length, 1)
    store.close()
    // The process stops. A new one opens the same file.
    store = new TemplateStore(dbPath)
    try {
      const inLog = [{ type: 'user/message', data: { source: { kind: 'user', scheduled: EVIDENCE_SCHEDULED, items: [{ id: a.id }] } } }]
      assert.equal(prepareEvidence(store.evidence, 's1', 2, 1, inLog, at + 1000).length, 0)
      assert.equal(store.evidence.get(a.id)!.state, 'persisted')
      assert.equal(prepareEvidence(store.evidence, 's2', 2, 1, null, at + 1000).length, 0)
      assert.equal(store.evidence.get(b.id)!.state, 'unknown')
      assert.equal(prepareEvidence(store.evidence, 's2', 2, 2, [], at + 2000).length, 0, 'unknown is never sent again')
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('#81: a reference that waited past EVIDENCE_WAIT_MS without a step expires and is not delivered', () => {
  const dir = createTestDirectory('pt-evidence-expire-')
  try {
    const store = new TemplateStore(join(dir, 'db.sqlite3'))
    try {
      const at = Date.parse('2026-11-23T10:00:00Z')
      const row = store.evidence.offer({ sessionId: 's1', ...REF, caller: A2A }, new Date(at).toISOString()).row
      assert.equal(prepareEvidence(store.evidence, 's1', 9, 1, [], at + EVIDENCE_WAIT_MS + 1).length, 0)
      assert.equal(store.evidence.get(row.id)!.state, 'expired')
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
