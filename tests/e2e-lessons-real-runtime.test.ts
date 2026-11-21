/**
 * End-to-end on the REAL ToolRuntime (owner 2026-11-21: machine-side full-chain check before the next release).
 * Every model tool is called through ToolRuntime.execute, the way a host dispatches it, not through a fake registry:
 * workshop card injected → card round line → lesson_write (typed) closes it → recall opens an RSI round →
 * rewrite closes it → lesson_none on the next card round → type proposal → owner approval over the route →
 * custom-type write → lesson_timeline sees all of it → the route reports the card yield.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createTestDirectory } from './temp-dir.mjs'

class FakeSystemPrompt extends Service {
  static inject: string[] = []
  tools(_cb: (tool: unknown) => void) {}
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
}
class FakeWebServer extends Service {
  static inject: string[] = []
  routes: Array<{ handler: (req: unknown, res: unknown) => void }> = []
  register(route: { handler: (req: unknown, res: unknown) => void }) { this.routes.push(route); return () => {} }
  constructor(ctx: Context) { super(ctx, 'webServer') }
}

const S = 'e2e-session'
const BASE = '/plugins/dsh-prompt-templates'
const agent = { session: { header: { id: S }, snapshotEvents: () => [] } }

test('real ToolRuntime: card round, typed lesson, RSI recall round, no-entry, owner-approved type, timeline, card yield', async () => {
  const ctx = new Context()
  await ctx.plugin(FakeSystemPrompt as never)
  await ctx.plugin(FakeWebServer as never)
  await ctx.plugin(ToolRuntime as never)
  const dir = createTestDirectory('pt-e2e-')
  const host = await import('../src/index.ts')
  const fiber = await ctx.plugin(host as never, { dbPath: join(dir, 'db.sqlite3'), lessons: { recallCooldownTurns: 1, digestCooldownTurns: 1 } } as never)
  try {
    await new Promise(resolve => setImmediate(resolve))
    const runtime = ctx.tools as unknown as { execute: (input: Record<string, unknown>) => Promise<{ isError?: boolean; value?: Record<string, unknown> }> }
    const web = (ctx as unknown as { webServer: FakeWebServer }).webServer
    let n = 0
    const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      n += 1
      const out = await runtime.execute({ callId: `c${String(n)}`, name, arguments: args, agent, signal: new AbortController().signal })
      assert.ok(!out.isError, `${name} ran: ${JSON.stringify(out)}`)
      return out.value as Record<string, unknown>
    }
    const request = async (url: string, method = 'GET', payload?: unknown): Promise<{ status: number; body: any }> => {
      const req = Object.assign(new EventEmitter(), { method, url })
      return await new Promise(resolve => {
        const res = { statusCode: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v }, writeHead(code: number) { this.statusCode = code },
          end(text?: string) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }) } }
        web.routes[0]!.handler(req, res)
        setImmediate(() => { if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
      })
    }
    const step = async (turn: number): Promise<string> => {
      const decision = await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<{ messages?: Array<{ content?: Array<{ text?: string }> }> }> }).waterfall('agent/pre-step', {
        agent, messages: [{ role: 'user' }], turn, step: 1, signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [] }))
      return (decision.messages ?? []).map(m => m.content?.[0]?.text ?? '').join('\n')
    }
    // The owner's workshop card, injected every 4 turns.
    assert.equal((await request(`${BASE}/categories`, 'POST', { name: '工坊', scope: 'global', session_id: null })).status, 200)
    const card = (await request(`${BASE}/templates`, 'POST', { name: '工坊-行动审视', content: '先审视实际调用。', scope: 'global', category: '工坊', inject_enabled: true, inject_every: 4, mode: 'inject' })).body.template
    // Turn 4: the card goes out with the card-round line; the model works and writes a typed lesson.
    assert.ok((await step(4)).includes('【工坊·卡片轮次】本轮注入了工坊卡（工坊-行动审视）'))
    const bash = async (command: string): Promise<void> => {
      n += 1
      const exec = { callId: `c${String(n)}`, rootCallId: `c${String(n)}`, name: 'bash', arguments: { command }, agent, signal: new AbortController().signal }
      await (ctx as unknown as { emit: (...args: unknown[]) => unknown }).emit('tools/result', exec, { isError: false, value: null, content: [] })
    }
    await bash('TOKEN_X=1 /opt/py/bin/python build.py')
    const written = await call('lesson_write', { text: '先查已有入口，再写脚本。', type: '找' })
    assert.deepEqual([written['ok'], written['type'], written['round']], [true, '找', 'written'])
    // Turn 6: the same situation recalls the lesson as an RSI round; rewriting the type closes it (soft overwrite).
    await bash('TOKEN_X=1 /opt/py/bin/python lint.py')
    assert.ok((await step(6)).includes('【工坊·体会·找｜RSI 一轮】先查已有入口，再写脚本。'))
    const rewrite = await call('lesson_write', { text: '先查已有入口与 make 目标，再写脚本。', type: '找' })
    assert.deepEqual([rewrite['superseded'], rewrite['round']], [true, 'updated'])
    // Turn 8: the card again; this time nothing transferable — a stated no-entry closes the round.
    assert.ok((await step(8)).includes('卡片轮次'))
    assert.deepEqual(await call('lesson_none', { reason: '照卡审视过，没有新问题' }), { ok: true, round: 'none', card_round: 'card:8' })
    // A type of its own: proposed, refused until the owner approves on the route, then usable.
    assert.deepEqual(await call('lesson_type_propose', { name: '协作', description: '跨会话交接的经验，七类都不贴切' }), { ok: true, name: '协作', status: 'pending' })
    assert.equal((await call('lesson_write', { text: '交接先写清缺口。', type: '协作' }))['code'], 'type')
    assert.equal((await request(`${BASE}/lesson-types/${encodeURIComponent('协作')}?session_id=${S}`, 'PATCH', { approved: true })).status, 200)
    assert.equal((await call('lesson_write', { text: '交接先写清缺口。', type: '协作' }))['ok'], true)
    const timeline = await call('lesson_timeline', { limit: 50 }) as { entries: Array<{ kind: string; type: string | null; text?: string; outcome?: string; card?: string }> }
    const kinds = timeline.entries.map(e => e.kind)
    for (const kind of ['card-injected', 'written', 'recalled', 'superseded', 'round-closed', 'type-proposed', 'type-decided']) assert.ok(kinds.includes(kind), kind)
    assert.ok(timeline.entries.some(e => e.kind === 'superseded' && e.text === '先查已有入口，再写脚本。'))
    assert.ok(timeline.entries.some(e => e.kind === 'round-closed' && e.outcome === 'none'))
    assert.ok(timeline.entries.some(e => e.kind === 'round-closed' && e.outcome === 'updated'))
    // B4a: one more call in the recalled lesson's situation, through the real tools/result event, counts as after recall.
    await bash('TOKEN_X=1 /opt/py/bin/python deploy.py')
    // The route: lessons by type, the approved type, and the card yield (2 injections: 1 lesson, 1 no-entry).
    const read = await request(`${BASE}/lessons?session_id=${S}`)
    const found = read.body.items.find((i: { key: string }) => i.key === '找')
    assert.deepEqual(found.recurrence.after, { hits: 1, fails: 0 })
    assert.deepEqual(read.body.items.map((i: { key: string }) => i.key), ['找', '协作'])
    assert.ok(read.body.types.some((t: { name: string; status: string }) => t.name === '协作' && t.status === 'approved'))
    assert.deepEqual(read.body.cards, [{ template_id: card.id, name: '工坊-行动审视', injected: 2, lessons: 1, none: 1, missed: 0, recurrence: { hits: 1, fails: 0 } }])
  } finally {
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
    await (ctx as unknown as { destroy?: () => Promise<void> }).destroy?.()
  }
})
