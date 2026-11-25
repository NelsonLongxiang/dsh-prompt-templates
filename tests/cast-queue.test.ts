import { createTestDirectory } from './temp-dir.mjs'
/**
 * open-a2a-net #902 S1: the cast queue is durable (a restart keeps what waits), a cast carries a basis, the recognized
 * caller can list and withdraw queued casts, and library cards say whether they are workshop cards.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { TemplateStore } from '../src/store.ts'

const A2A = '@nelsonlongxiang/dsh-open-a2a-net'

/** A host over one database file that can be stopped and started again. */
async function node(dir: string) {
  const ctx = new Context()
  const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3'), cast: { enabled: true } })
  const callerCtx = async (pkg: string | undefined): Promise<Context> => {
    let inner: Context | undefined
    await ctx.plugin({ name: 'caller', inject: ['promptTemplates'], apply: (c: Context) => { inner = c } } as never)
    if (pkg !== undefined) (inner as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: pkg } }
    return inner!
  }
  const preStep = async (sessionId: string, turn: number, step = 1) => await ctx.waterfall('agent/pre-step', {
    agent: { session: { header: { id: sessionId }, snapshotEvents: () => [] } }, messages: [{ role: 'user' }], turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] })) as { kind: string; messages: Array<{ source?: { scheduled?: string }; content?: Array<{ text?: string }> }> }
  return { callerCtx, preStep, stop: async () => { await fiber.dispose() } }
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
