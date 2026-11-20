import { createTestDirectory } from './temp-dir.mjs'
/**
 * Observer phase 2 (PT-3): the service other plugins read, and the cast only a recognized caller may use. A real Cordis
 * context; the caller's identity is its fiber's loader entry, stamped here as the loader would.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { callerOf } from '../src/cast.ts'

const A2A = '@nelsonlongxiang/dsh-open-a2a-net'

async function harness(castEnabled: boolean) {
  const dir = createTestDirectory('pt-cast-')
  const ctx = new Context()
  const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3'), cast: { enabled: castEnabled } })
  // A caller plugin: its fiber carries the loader entry the profile gave it.
  const callerCtx = async (pkg: string | undefined): Promise<Context> => {
    let inner: Context | undefined
    await ctx.plugin({ name: 'caller', inject: ['promptTemplates'], apply: (c: Context) => { inner = c } } as never)
    if (pkg !== undefined) (inner as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { name: pkg } }
    return inner!
  }
  const preStep = async (sessionId: string, turn: number, step = 1) => await ctx.waterfall('agent/pre-step', {
    agent: { session: { header: { id: sessionId }, snapshotEvents: () => [] } }, messages: [{ role: 'user' }], turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] })) as { kind: string; messages: Array<{ source?: { scheduled?: string }; content?: Array<{ text?: string }> }> }
  const dispose = async () => { await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, callerCtx, preStep, dispose }
}

test('callerOf reads the nearest loader entry, never a passed string', () => {
  assert.equal(callerOf({ fiber: { entry: { options: { name: A2A } } } } as never), A2A)
  assert.equal(callerOf({ fiber: { parent: { fiber: { entry: { options: { name: A2A } } } } } } as never), A2A)
  assert.equal(callerOf({ fiber: {} } as never), undefined)
})

test('reads are open to any plugin; cast is the recognized caller\'s only, and only while switched on', async () => {
  const h = await harness(true)
  try {
    const service = h.ctx.promptTemplates
    // A global card to cast.
    const store = (service as unknown as { _store: () => import('../src/store.ts').TemplateStore })._store()
    const made = store.create({ name: '行动审视', content: 'look at {{session}}', scope: 'global' })
    // Reads: any plugin, even one without an entry.
    const stranger = await h.callerCtx('some-other-plugin')
    assert.equal(stranger.promptTemplates.library().length, 1)
    assert.deepEqual(stranger.promptTemplates.templates('sess-1'), [])
    assert.deepEqual(stranger.promptTemplates.interventions(), [])
    // Cast: a stranger is refused by identity, whatever it might claim.
    assert.deepEqual(stranger.promptTemplates.cast({ sessionId: 'sess-1', templateId: made.id, reason: 'r' }).ok, false)
    assert.equal((stranger.promptTemplates.cast({ sessionId: 'sess-1', templateId: made.id, reason: 'r' }) as { code: string }).code, 'caller')
    const noEntry = await h.callerCtx(undefined)
    assert.equal((noEntry.promptTemplates.cast({ sessionId: 'sess-1', templateId: made.id, reason: 'r' }) as { code: string }).code, 'caller')
    // The a2a plugin casts; the card goes in at the session's next step, and the log records it as a plugin's.
    const a2a = await h.callerCtx(A2A)
    assert.equal((a2a.promptTemplates.cast({ sessionId: 'sess-1', templateId: made.id, reason: '' }) as { code: string }).code, 'reason')
    assert.equal((a2a.promptTemplates.cast({ sessionId: 'sess-1', templateId: 'nope', reason: 'r' }) as { code: string }).code, 'template')
    assert.deepEqual(a2a.promptTemplates.cast({ sessionId: 'sess-1', templateId: made.id, reason: '卡在验收上' }), { ok: true, queued: 1 })
    const other = await h.preStep('sess-2', 3)
    assert.equal(other.messages.length, 1, 'another session gets nothing')
    const step = await h.preStep('sess-1', 3, 2)
    assert.equal(step.messages.length, 2)
    assert.equal(step.messages[1]?.source?.scheduled, 'prompt-template-cast')
    const text = step.messages[1]?.content?.[0]?.text ?? ''
    assert.ok(text.includes('look at sess-1'))
    assert.ok(text.includes(`投卡方：${A2A}`))
    assert.ok(text.includes('不授予任何权限'))
    assert.equal((await h.preStep('sess-1', 3, 3)).messages.length, 1, 'delivered once')
    const rows = a2a.promptTemplates.interventions({ sessionId: 'sess-1' })
    assert.deepEqual(rows.map(r => [r.source, r.caller, r.template_id, r.turn, r.step]), [['plugin', A2A, made.id, 3, 2]])
    assert.ok(!JSON.stringify(rows).includes('look at'), 'digest only')
  } finally { await h.dispose() }
})

test('cast is off by default', async () => {
  const h = await harness(false)
  try {
    const a2a = await h.callerCtx(A2A)
    assert.equal(a2a.promptTemplates.castEnabled(), false)
    assert.equal((a2a.promptTemplates.cast({ sessionId: 's', templateId: 'x', reason: 'r' }) as { code: string }).code, 'disabled')
  } finally { await h.dispose() }
})
