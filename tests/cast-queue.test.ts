import { createTestDirectory } from './temp-dir.mjs'
/**
 * open-a2a-net #902 S1: the cast queue is durable (a restart keeps what waits), a cast carries a basis, the recognized
 * caller can list and withdraw queued casts, and library cards say whether they are workshop cards.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import * as host from '../src/index.ts'
import { TemplateStore } from '../src/store.ts'

const A2A = '@nelsonlongxiang/dsh-open-a2a-net'

type HostLog = Map<string, readonly SessionEvent[]>

/** Real session append and flush dispatch with a controllable persistence listener. */
async function node(dir: string, { persisted = new Map(), flush = true, readable = true }: {
  persisted?: HostLog; flush?: boolean | (() => Promise<void>); readable?: boolean
} = {}) {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  if (flush) ctx.on('session/flush', async session => {
    if (typeof flush === 'function') await flush()
    const prior = persisted.get(session.id) ?? []
    persisted.set(session.id, [...prior, ...session.snapshotEvents(prior.length as never)])
  })
  if (readable) ctx.provide('sessionPersistence' as never, {
    open: async (id: string, access: string) => {
      assert.equal(access, 'read')
      return { read: async () => ({ events: persisted.get(id) ?? [] }), close: async () => {} }
    },
  } as never)
  const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3'), cast: { enabled: true } })
  const callerCtx = async (pkg: string | undefined): Promise<Context> => {
    let inner: Context | undefined
    await ctx.plugin({ name: 'caller', inject: ['promptTemplates'], apply: (c: Context) => { inner = c } } as never)
    if (pkg !== undefined) (inner as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: pkg } }
    return inner!
  }
  const live = (id: string) => sessions.get(SessionId(id)) ?? sessions.create(SessionId(id))
  const append = (id: string, message: UserMessage) => live(id).append('user/message', message, { surfaceOp: 'append' })
  const endStep = (id: string, turn: number, step: number) => live(id).append('step/end', { turn, step })
  const endTurn = (id: string, turn: number) => live(id).append('turn/end', { turn, reason: { kind: 'aborted', reason: 'user' } } as never)
  const preStep = async (sessionId: string, turn: number, step = 1, commit = true, signal = new AbortController().signal) => {
    const result = await ctx.waterfall('agent/pre-step', {
      agent: { session: live(sessionId) }, messages: [{ role: 'user' }], turn, step, signal,
    }, async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] })) as { kind: string; messages: UserMessage[] }
    if (commit) {
      for (const message of result.messages.slice(1)) append(sessionId, message)
      await setImmediate()
    }
    return result
  }
  return { callerCtx, preStep, append, endStep, endTurn, stop: async () => { await fiber.dispose() } }
}


const makeCard = (dir: string, data: Parameters<TemplateStore['create']>[0]) => { const store = new TemplateStore(join(dir, 'db.sqlite3')); try { return store.create(data) } finally { store.close() } }

test('a queued cast survives a host restart and goes in at the next step after it, once', async () => {
  const dir = createTestDirectory('pt-castq-')
  try {
    const card = makeCard(dir, { name: '验收流程', content: 'check {{session}}', scope: 'global' })
    const first = await node(dir)
    const a2a = await first.callerCtx(A2A)
    const out = a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: '卡在验收', basis: 'ticket:t-1' })
    assert.equal(out.ok, true)
    await first.stop()
    const second = await node(dir)
    const step = await second.preStep('s1', 4, 2)
    assert.equal(step.messages.length, 2)
    const text = step.messages[1]?.content?.[0]?.text ?? ''
    assert.ok(text.includes('check s1') && text.includes('依据：ticket:t-1'))
    assert.equal((await second.preStep('s1', 4, 3)).messages.length, 1, 'delivered once')
    const reader = await second.callerCtx(A2A)
    const rows = reader.promptTemplates.interventions({ sessionId: 's1' })
    assert.deepEqual(rows.map(r => [r.source, r.basis]), [['plugin', 'ticket:t-1']])
    const queue = reader.promptTemplates.castQueue({ sessionId: 's1' })
    assert.equal(queue.ok, true)
    assert.deepEqual((queue as { items: Array<{ state: string; basis: string | null }> }).items.map(r => [r.state, r.basis]), [['delivered', 'ticket:t-1']])
    assert.ok(!JSON.stringify(queue).includes('check {{session}}'), 'the queue read carries no text')
    await second.stop()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('basis: optional, but when given it is one line of 1..200 characters', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'c', content: 'x', scope: 'global' })
    const a2a = await h.callerCtx(A2A)
    assert.equal((a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', basis: '' }) as { code: string }).code, 'basis')
    assert.equal((a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', basis: 'x'.repeat(201) }) as { code: string }).code, 'basis')
    assert.equal(a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', basis: 'event:\nforged header' }).ok, true)
    const rows = (a2a.promptTemplates.castQueue({ sessionId: 's1', state: 'waiting' }) as { items: Array<{ basis: string }> }).items
    assert.equal(rows[0]?.basis, 'event: forged header', 'folded to one line')
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('only the recognized caller lists and withdraws; a withdrawn cast never goes in; another session\'s id withdraws nothing', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'c', content: 'body', scope: 'global' })
    const stranger = await h.callerCtx('some-other-plugin')
    const a2a = await h.callerCtx(A2A)
    const cast = a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', basis: 'none: try' }) as { ok: true; id: string }
    assert.equal((stranger.promptTemplates.castQueue() as { code: string }).code, 'caller')
    assert.equal((stranger.promptTemplates.castWithdraw({ sessionId: 's1', id: cast.id }) as { code: string }).code, 'caller')
    assert.deepEqual(a2a.promptTemplates.castWithdraw({ sessionId: 's2', id: cast.id }), { ok: true, withdrawn: false })
    assert.deepEqual(a2a.promptTemplates.castWithdraw({ sessionId: 's1', id: cast.id }), { ok: true, withdrawn: true })
    assert.deepEqual(a2a.promptTemplates.castWithdraw({ sessionId: 's1', id: cast.id }), { ok: true, withdrawn: false }, 'only once')
    assert.equal((await h.preStep('s1', 2)).messages.length, 1, 'nothing goes in')
    assert.deepEqual((a2a.promptTemplates.castQueue({ sessionId: 's1' }) as { items: Array<{ state: string }> }).items.map(r => r.state), ['withdrawn'])
    // The same card can be cast again once the old one is withdrawn.
    assert.equal(a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'again' }).ok, true)
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('library cards say workshop for an atelier card and template otherwise', async () => {
  const dir = createTestDirectory('pt-castq-')
  try {
    const store = new TemplateStore(join(dir, 'db.sqlite3'))
    try {
      store.createCategory({ name: '工坊', scope: 'global' })
      const byCategory = store.create({ name: '行动审视', content: 'a', scope: 'global', category: '工坊' })
      const plain = store.create({ name: '日报', content: 'b', scope: 'global' })
      const cards = store.library()
      assert.equal(cards.find(c => c.id === byCategory.id)?.kind, 'workshop')
      assert.equal(cards.find(c => c.id === byCategory.id)?.category, '工坊')
      assert.equal(cards.find(c => c.id === plain.id)?.kind, 'template')
      assert.equal(cards.find(c => c.id === plain.id)?.category, null)
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('#902 S3 mode: insert goes in at the next step; queue waits for the first step of a turn; anything else is refused', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'c', content: 'body {{session}}', scope: 'global' })
    const a2a = await h.callerCtx(A2A)
    assert.equal((a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', mode: 'later' as never }) as { code: string }).code, 'mode')
    assert.equal(a2a.promptTemplates.cast({ sessionId: 's1', templateId: card.id, reason: 'r', mode: 'queue' }).ok, true)
    assert.equal((await h.preStep('s1', 3, 2)).messages.length, 1, 'a queue cast does not cut into a turn under way')
    assert.equal((await h.preStep('s1', 3, 5)).messages.length, 1)
    const items = (a2a.promptTemplates.castQueue({ sessionId: 's1' }) as { items: Array<{ state: string; mode: string }> }).items
    assert.deepEqual(items.map(r => [r.state, r.mode]), [['waiting', 'queue']])
    const next = await h.preStep('s1', 4, 1)
    assert.equal(next.messages.length, 2, 'it goes in at the first step of the next turn')
    assert.equal(a2a.promptTemplates.cast({ sessionId: 's2', templateId: card.id, reason: 'r' }).ok, true)
    assert.equal((await h.preStep('s2', 3, 4)).messages.length, 2, 'insert (the default) goes in mid-turn')
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

function queueRows(dir: string) {
  const db = new DatabaseSync(join(dir, 'db.sqlite3'), { readOnly: true })
  try { return db.prepare('SELECT * FROM cast_queue ORDER BY id').all() }
  finally { db.close() }
}

function updateFixture(dir: string, sql: string): void {
  const db = new DatabaseSync(join(dir, 'db.sqlite3'))
  try { db.exec(sql) }
  finally { db.close() }
}

test('prepared casts are not delivered until their exact host append is flushed', async () => {
  const dir = createTestDirectory('pt-castq-')
  let allowFlush: () => void = () => {}
  const barrier = new Promise<void>(resolve => { allowFlush = resolve })
  const h = await node(dir, { flush: () => barrier })
  try {
    const card = makeCard(dir, { name: 'card', content: 'private {{session}}', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    const request = { sessionId: 's1', templateId: card.id, reason: 'r', basis: 'ticket:1' }
    const cast = svc.cast(request)
    assert.ok(cast.ok)
    const prepared = await h.preStep('s1', 1, 1, false)
    const message = prepared.messages[1]!
    assert.ok(message.id)
    assert.equal(svc.castQueue({ state: 'prepared' }).ok, true)
    assert.equal(queueRows(dir)[0]?.state, 'prepared', 'a pre-step result alone is not delivery')
    assert.equal(queueRows(dir)[0]?.content, 'private {{session}}')
    assert.equal(queueRows(dir)[0]?.message_id, message.id)
    assert.deepEqual(svc.interventions(), [])
    assert.equal((svc.cast(request) as { code: string }).code, 'already-queued')
    assert.deepEqual(svc.castWithdraw({ sessionId: 's1', id: cast.id }), { ok: true, withdrawn: false })
    h.append('other', message)
    await setImmediate()
    assert.equal(queueRows(dir)[0]?.state, 'prepared', 'an append in a different session is not evidence')
    const event = h.append('s1', message)
    await setImmediate()
    assert.equal(queueRows(dir)[0]?.state, 'prepared', 'the durability barrier is still pending')
    assert.deepEqual(svc.interventions(), [])
    allowFlush()
    await setImmediate()
    const delivered = queueRows(dir)[0]!
    assert.equal(delivered.state, 'delivered')
    assert.equal(delivered.event_seq, event.seq)
    assert.equal(delivered.message_id, message.id)
    assert.equal(delivered.content, '', 'the queue erases terminal payloads')
    assert.match(String(delivered.message_sha256), /^[a-f0-9]{64}$/)
    assert.deepEqual(svc.interventions().map(row => [row.turn, row.step, row.basis]), [[1, 1, 'ticket:1']])
    assert.equal((await h.preStep('s1', 2)).messages.length, 1)
  } finally { allowFlush(); await setImmediate(); await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('an uncommitted step or aborted turn requeues the cast without a delivered audit row', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'card', content: 'recover me', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    const controller = new AbortController()
    const first = await h.preStep('s1', 1, 1, false, controller.signal)
    assert.equal(first.messages.length, 2)
    h.endStep('s1', 1, 1)
    await setImmediate()
    assert.equal(queueRows(dir)[0]?.state, 'waiting')
    const next = await h.preStep('s1', 1, 2, false, controller.signal)
    assert.notEqual(next.messages[1]?.id, first.messages[1]?.id)
    controller.abort()
    h.endTurn('s1', 1)
    await setImmediate()
    assert.equal(queueRows(dir)[0]?.state, 'waiting')
    assert.deepEqual(svc.interventions(), [])
    const restored = await h.preStep('s1', 2)
    assert.equal(restored.messages.length, 2)
    assert.equal(queueRows(dir)[0]?.state, 'delivered')
    assert.equal(svc.interventions().length, 1)
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('an in-memory append without a durability listener is unknown and is never retried', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir, { flush: false })
  try {
    const card = makeCard(dir, { name: 'card', content: 'private', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    const result = await h.preStep('s1', 1)
    assert.equal(result.messages.length, 2)
    const row = queueRows(dir)[0]!
    assert.equal(row.state, 'unknown')
    assert.equal(row.content, '')
    assert.equal(row.message_id, result.messages[1]?.id)
    assert.equal(row.event_seq, null)
    assert.deepEqual(svc.interventions(), [])
    assert.equal((await h.preStep('s1', 2)).messages.length, 1)
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a restart with a prepared message absent from the host log preserves uncertainty and does not replay it', async () => {
  const dir = createTestDirectory('pt-castq-')
  const first = await node(dir)
  let restarted: Awaited<ReturnType<typeof node>> | undefined
  try {
    const card = makeCard(dir, { name: 'card', content: 'private', scope: 'global' })
    const svc = (await first.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    assert.equal((await first.preStep('s1', 1, 1, false)).messages.length, 2)
    assert.equal(queueRows(dir)[0]?.state, 'prepared')
    await first.stop()
    restarted = await node(dir)
    assert.equal((await restarted.preStep('s1', 2)).messages.length, 1, 'an unresolved batch cannot be replayed')
    assert.equal(queueRows(dir)[0]?.state, 'unknown')
    assert.equal(queueRows(dir)[0]?.content, '')
    assert.deepEqual((await restarted.callerCtx(A2A)).promptTemplates.interventions(), [])
  } finally { await restarted?.stop(); await first.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('restart reconciles a durable batch after an audit failure, without a partial batch or duplicate audit', async () => {
  const dir = createTestDirectory('pt-castq-')
  const persisted: HostLog = new Map()
  const first = await node(dir, { persisted })
  let restarted: Awaited<ReturnType<typeof node>> | undefined
  try {
    const card1 = makeCard(dir, { name: 'one', content: 'one', scope: 'global' })
    const card2 = makeCard(dir, { name: 'two', content: 'two', scope: 'global' })
    const svc = (await first.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card1.id, reason: 'r' }).ok)
    assert.ok(svc.cast({ sessionId: 's1', templateId: card2.id, reason: 'r' }).ok)
    updateFixture(dir, `CREATE TRIGGER reject_second_cast BEFORE INSERT ON interventions
      WHEN (SELECT count(*) FROM interventions) = 1 BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`)
    const sent = await first.preStep('s1', 1)
    assert.equal(sent.messages.length, 2)
    assert.equal(persisted.get('s1')?.length, 1)
    assert.deepEqual(queueRows(dir).map(row => row.state), ['prepared', 'prepared'])
    assert.deepEqual(svc.interventions(), [], 'the audit and queue settle in one transaction')
    await first.stop()
    updateFixture(dir, 'DROP TRIGGER reject_second_cast')
    restarted = await node(dir, { persisted })
    assert.equal((await restarted.preStep('s1', 2)).messages.length, 1)
    const reader = (await restarted.callerCtx(A2A)).promptTemplates
    assert.deepEqual(queueRows(dir).map(row => [row.state, row.message_id, row.content]), [
      ['delivered', sent.messages[1]?.id, ''], ['delivered', sent.messages[1]?.id, ''],
    ])
    assert.deepEqual(reader.interventions().map(row => row.template_id).sort(), [card1.id, card2.id].sort())
    assert.equal((await restarted.preStep('s1', 3)).messages.length, 1)
    assert.equal(reader.interventions().length, 2)
  } finally { await restarted?.stop(); await first.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a failed durability checkpoint keeps the host append pending for reconciliation', async () => {
  const dir = createTestDirectory('pt-castq-')
  let failing = true
  const h = await node(dir, { flush: async () => { if (failing) throw new Error('injected flush failure') } })
  try {
    const card = makeCard(dir, { name: 'card', content: 'leave pending', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    const first = await h.preStep('s1', 1)
    assert.equal(first.messages.length, 2)
    assert.equal(queueRows(dir)[0]?.state, 'prepared')
    assert.deepEqual(svc.interventions(), [])
    failing = false
    assert.equal((await h.preStep('s1', 2)).messages.length, 1, 'retry flush without resending the card')
    assert.equal(queueRows(dir)[0]?.state, 'delivered')
    assert.equal(queueRows(dir)[0]?.message_id, first.messages[1]?.id)
    assert.equal(svc.interventions().length, 1)
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a later hook changing the prepared payload cannot confirm delivery of that cast', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'card', content: 'expected', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    const prepared = await h.preStep('s1', 1, 1, false)
    h.append('s1', { ...prepared.messages[1]!, content: [{ type: 'text', text: 'a different payload' }] })
    await setImmediate()
    assert.equal(queueRows(dir)[0]?.state, 'unknown')
    assert.equal(queueRows(dir)[0]?.event_seq, null)
    assert.deepEqual(svc.interventions(), [])
    assert.equal((await h.preStep('s1', 2)).messages.length, 1)
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a batch preparation failure publishes nothing and both waiting casts can be retried', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const svc = (await h.callerCtx(A2A)).promptTemplates
    for (const name of ['one', 'two']) {
      const card = makeCard(dir, { name, content: name, scope: 'global' })
      assert.ok(svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r' }).ok)
    }
    updateFixture(dir, `CREATE TRIGGER reject_second_prepare BEFORE UPDATE ON cast_queue
      WHEN NEW.state = 'prepared' AND EXISTS (SELECT 1 FROM cast_queue WHERE state = 'prepared')
      BEGIN SELECT RAISE(ABORT, 'injected preparation failure'); END`)
    assert.equal((await h.preStep('s1', 1)).messages.length, 1)
    assert.deepEqual(queueRows(dir).map(row => [row.state, row.message_id]), [['waiting', null], ['waiting', null]])
    assert.deepEqual(svc.interventions(), [])
    updateFixture(dir, 'DROP TRIGGER reject_second_prepare')
    assert.equal((await h.preStep('s1', 2)).messages.length, 2)
    assert.deepEqual(queueRows(dir).map(row => row.state), ['delivered', 'delivered'])
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('the old queue retains waiting cards and relabels unverified historical deliveries on upgrade', async () => {
  for (const hasMode of [false, true]) {
    const dir = createTestDirectory('pt-castq-')
    let h: Awaited<ReturnType<typeof node>> | undefined
    try {
      const card = makeCard(dir, { name: 'card', content: 'legacy body', scope: 'global' })
      const modeColumn = hasMode ? ", mode TEXT NOT NULL DEFAULT 'insert'" : ''
      const queuedMode = hasMode ? ", 'queue'" : ''
      updateFixture(dir, `PRAGMA user_version=11; DROP TABLE cast_queue;
        CREATE TABLE cast_queue (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, template_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT,
          content TEXT NOT NULL, caller TEXT NOT NULL, reason TEXT NOT NULL, basis TEXT, at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered', 'withdrawn', 'expired')), ended_at TEXT${modeColumn}
        );
        CREATE INDEX cast_queue_waiting ON cast_queue (state, session_id, at);
        INSERT INTO cast_queue VALUES
          ('legacy-waiting', 's1', '${card.id}', 'card', NULL, 'legacy body', '${A2A}', 'r', 'basis', '${new Date().toISOString()}', 'waiting', NULL${queuedMode}),
          ('legacy-delivered', 's1', '${card.id}', 'card', NULL, 'legacy body', '${A2A}', 'r', 'basis', '2020-01-01T00:00:00.000Z', 'delivered', '2020-01-01T00:00:01.000Z'${queuedMode})`)
      h = await node(dir)
      const svc = (await h.callerCtx(A2A)).promptTemplates
      const queue = svc.castQueue({ sessionId: 's1' })
      assert.ok(queue.ok)
      assert.deepEqual(queueRows(dir).map(row => [row.id, row.state, row.content, row.mode]), [
        ['legacy-delivered', 'unknown', '', hasMode ? 'queue' : 'insert'],
        ['legacy-waiting', 'waiting', 'legacy body', hasMode ? 'queue' : 'insert'],
      ])
      assert.ok(queue.items.every(row => row.message_id === null && row.event_seq === null && !('content' in row)))
      const reopened = new TemplateStore(join(dir, 'db.sqlite3'))
      reopened.close()
      assert.deepEqual(queueRows(dir).map(row => row.state), ['unknown', 'waiting'])
      assert.equal((await h.preStep('s1', 4, 1)).messages.length, 2)
      assert.deepEqual(queueRows(dir).map(row => row.state), ['unknown', 'delivered'])
      assert.equal(svc.interventions().length, 1)
    } finally { await h?.stop(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('withdraw and expiry erase queued bodies while retaining terminal metadata', async () => {
  const dir = createTestDirectory('pt-castq-')
  const h = await node(dir)
  try {
    const card = makeCard(dir, { name: 'card', content: 'private', scope: 'global' })
    const svc = (await h.callerCtx(A2A)).promptTemplates
    const withdrawn = svc.cast({ sessionId: 's1', templateId: card.id, reason: 'r', basis: 'basis' })
    assert.ok(withdrawn.ok)
    assert.deepEqual(svc.castWithdraw({ sessionId: 's1', id: withdrawn.id }), { ok: true, withdrawn: true })
    assert.ok(svc.cast({ sessionId: 's2', templateId: card.id, reason: 'r', basis: 'basis' }).ok)
    updateFixture(dir, "UPDATE cast_queue SET at = '2000-01-01T00:00:00.000Z' WHERE session_id = 's2'")
    assert.equal((await h.preStep('s2', 2)).messages.length, 1)
    assert.deepEqual(queueRows(dir).map(row => [row.session_id, row.state, row.content, row.basis]).sort(), [
      ['s1', 'withdrawn', '', 'basis'], ['s2', 'expired', '', 'basis'],
    ])
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})
