import { createTestDirectory } from './temp-dir.mjs'
/**
 * open-a2a-net #902 S2: the a2a plugin writes the team observer's own cards (session templates of the observer's
 * session) and casts one into another session, naming the author session; nobody else can do either.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { TemplateStore } from '../src/store.ts'

const A2A = '@nelsonlongxiang/dsh-open-a2a-net'

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
  }, async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] })) as { kind: string; messages: Array<{ content?: Array<{ text?: string }> }> }
  return { callerCtx, preStep, stop: async () => { await fiber.dispose() } }
}

test('the a2a plugin writes, edits and deletes the observer\'s own cards; a stranger cannot', async () => {
  const dir = createTestDirectory('pt-drafts-')
  const h = await node(dir)
  try {
    const stranger = await h.callerCtx('some-other-plugin')
    const a2a = await h.callerCtx(A2A)
    assert.equal((stranger.promptTemplates.draftCard({ authorSession: 'obs', name: 'n', content: 'c' }) as { code: string }).code, 'caller')
    assert.equal((a2a.promptTemplates.draftCard({ authorSession: 'obs', name: '', content: 'c' }) as { code: string }).code, 'name')
    assert.equal((a2a.promptTemplates.draftCard({ authorSession: 'obs', name: 'n', content: ' ' }) as { code: string }).code, 'input')
    const made = a2a.promptTemplates.draftCard({ authorSession: 'obs', name: '对账卡点', content: '先核 {{session}} 的原证', description: 'for: m1 · scene: 月结' }) as { ok: true; id: string; created: boolean }
    assert.equal(made.ok, true)
    assert.equal(made.created, true)
    // An ordinary session template of the observer's session: visible in that session's own list.
    assert.deepEqual(a2a.promptTemplates.templates('obs').map(c => c.id), [made.id])
    // The same name twice in one session is refused by the store's rule.
    assert.equal((a2a.promptTemplates.draftCard({ authorSession: 'obs', name: '对账卡点', content: 'x' }) as { code: string }).code, 'name')
    const edited = a2a.promptTemplates.draftCard({ authorSession: 'obs', id: made.id, name: '对账卡点', content: '先核原证再改' }) as { ok: true; created: boolean }
    assert.equal(edited.created, false)
    // Another session's id cannot be edited or deleted through it.
    assert.equal((a2a.promptTemplates.draftCard({ authorSession: 'other', id: made.id, name: 'x', content: 'y' }) as { code: string }).code, 'card')
    assert.deepEqual(a2a.promptTemplates.draftDelete({ authorSession: 'other', id: made.id }), { ok: true, deleted: false })
    assert.equal((stranger.promptTemplates.draftDelete({ authorSession: 'obs', id: made.id }) as { code: string }).code, 'caller')
    assert.deepEqual(a2a.promptTemplates.draftDelete({ authorSession: 'obs', id: made.id }), { ok: true, deleted: true })
    assert.deepEqual(a2a.promptTemplates.templates('obs'), [])
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a card of the author session goes into another session only when the cast names that author', async () => {
  const dir = createTestDirectory('pt-drafts-')
  const h = await node(dir)
  try {
    const a2a = await h.callerCtx(A2A)
    const card = a2a.promptTemplates.draftCard({ authorSession: 'obs', name: '验收前自查', content: '交付前核 {{session}} 的证据' }) as { ok: true; id: string }
    // Without the author it is another session's card: refused, as before.
    assert.equal((a2a.promptTemplates.cast({ sessionId: 'm1', templateId: card.id, reason: 'r', basis: 'none: x' }) as { code: string }).code, 'template')
    // Naming a different author does not help either.
    assert.equal((a2a.promptTemplates.cast({ sessionId: 'm1', templateId: card.id, reason: 'r', authorSession: 'someone' }) as { code: string }).code, 'template')
    const out = a2a.promptTemplates.cast({ sessionId: 'm1', templateId: card.id, reason: '交付前', basis: 'ticket:t1', authorSession: 'obs' })
    assert.equal(out.ok, true)
    const step = await h.preStep('m1', 5, 1)
    const text = step.messages[1]?.content?.[0]?.text ?? ''
    assert.ok(text.includes('定制·验收前自查') && text.includes('交付前核 m1 的证据') && text.includes('依据：ticket:t1'), text)
    // The author session's own cast of its own card stays as before (no 定制 mark).
    const self = a2a.promptTemplates.cast({ sessionId: 'obs', templateId: card.id, reason: 'r', authorSession: 'obs' })
    assert.equal(self.ok, true)
    const own = await h.preStep('obs', 1, 1)
    assert.ok(!(own.messages[1]?.content?.[0]?.text ?? '').includes('定制·'))
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a stranger plugin cannot use authorSession to reach another session\'s card', async () => {
  const dir = createTestDirectory('pt-drafts-')
  const h = await node(dir)
  try {
    const store = new TemplateStore(join(dir, 'db.sqlite3'))
    const card = store.create({ name: 'x', content: 'y', scope: 'session', session_id: 'obs' })
    store.close()
    const stranger = await h.callerCtx('some-other-plugin')
    assert.equal((stranger.promptTemplates.cast({ sessionId: 'm1', templateId: card.id, reason: 'r', authorSession: 'obs' }) as { code: string }).code, 'caller')
  } finally { await h.stop(); rmSync(dir, { recursive: true, force: true }) }
})
