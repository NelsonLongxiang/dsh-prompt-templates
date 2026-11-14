/**
 * Event reminders, host wiring: the plugin mounted on a real cordis Context,
 * `tools/result` emitted, `agent/pre-step` driven through the waterfall, and
 * the audit routes. Covers spec M01–M03 and M08 at the host boundary.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'

interface Route { handler: (req: unknown, res: unknown) => void }
interface Message { source?: Record<string, unknown>, content?: Array<{ text?: string }> }
interface Decision { kind: string, messages?: Message[] }

const BASE = '/plugins/dsh-prompt-templates'

async function request(route: Route, method: string, url: string, body?: unknown): Promise<{ status: number, body: any }> {
  const req = new EventEmitter() as EventEmitter & { method: string, url: string }
  req.method = method
  req.url = url
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${method} ${url}`)), 2000)
    const res = {
      status: 0,
      writeHead(code: number) { this.status = code; return this },
      end(payload: string) { clearTimeout(timer); resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }) },
    }
    route.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
}

async function withHost(config: Record<string, unknown>, fn: (ctx: Context, route: Route, dir: string) => Promise<void>, dbPath?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pt-evhost-'))
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('webServer', { register(route: Route) { routes.push(route); return () => {} } })
  const fiber = await ctx.plugin(host, { ...config, dbPath: dbPath ?? join(dir, 'db.sqlite3') })
  try {
    const route = routes[0]
    assert.ok(route)
    await fn(ctx, route, dir)
  } finally {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

function agent(sessionId: string, log: unknown[] = []): unknown {
  return { session: { header: { id: sessionId }, snapshotEvents: () => log } }
}

async function emitResult(ctx: Context, sessionId: string, callId: string, command: string, isError = false): Promise<void> {
  const exec = { callId, rootCallId: callId, name: 'bash', arguments: { command }, agent: agent(sessionId), signal: new AbortController().signal }
  const result = isError ? { isError: true, error: { message: 'x', info: { name: 'E', code: 'EXIT_1' } }, content: [] } : { isError: false, value: null, content: [] }
  await (ctx as unknown as { emit: (...args: unknown[]) => unknown }).emit('tools/result', exec, result)
}

async function preStep(ctx: Context, sessionId: string, turn: number, step: number, messages: unknown[], log: unknown[] = []): Promise<Decision> {
  return await (ctx as unknown as { waterfall: (...args: unknown[]) => Promise<Decision> }).waterfall('agent/pre-step', {
    agent: agent(sessionId, log), messages, turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [...messages] }))
}

test('Config schema keeps event reminders off by default', () => {
  const decoded = host.Config({ dbPath: '/tmp/x.sqlite3' }) as { eventInject: Record<string, unknown> }
  assert.deepEqual(decoded.eventInject, { enabled: false, maxPerTurn: 1, maxChars: 600, maxAttempts: 3, observationWindow: 200, ignoreTools: [] })
  assert.throws(() => host.Config({ dbPath: '/tmp/x.sqlite3', eventInject: { maxPerTurn: 0 } }))
})

test('switched off (default): tool results write nothing and steps pass through untouched', async () => {
  await withHost({}, async (ctx, route) => {
    await request(route, 'PATCH', `${BASE}/event-policies/repeated-failure`, { enabled: true })
    for (let n = 0; n < 4; n += 1) await emitResult(ctx, 's', `c${n}`, 'make', true)
    const decision = await preStep(ctx, 's', 1, 2, [])
    assert.deepEqual(decision.messages, [])
    const episodes = await request(route, 'GET', `${BASE}/event-episodes?session_id=s`)
    assert.deepEqual(episodes.body, { items: [], outbox: [] })
  })
})

test('M02: an empty-message tool step receives the event reminder; scheduled injection still skips it', async () => {
  await withHost({ eventInject: { enabled: true } }, async (ctx, route) => {
    await request(route, 'POST', `${BASE}/templates`, { name: 'every', content: 'scheduled body', inject_enabled: true, inject_every: 1 })
    await request(route, 'PATCH', `${BASE}/event-policies/repeated-failure`, { enabled: true })
    await emitResult(ctx, 's', 'c1', 'make test', true)
    await emitResult(ctx, 's', 'c2', 'make test', true)
    const decision = await preStep(ctx, 's', 3, 2, [])
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages?.length, 1, 'only the event reminder; scheduled injection keeps its empty-step skip')
    assert.equal(decision.messages?.[0]?.source?.['scheduled'], 'prompt-template-event')
    assert.match(decision.messages?.[0]?.content?.[0]?.text ?? '', /repeated-failure@1/)
    const episodes = await request(route, 'GET', `${BASE}/event-episodes?session_id=s`)
    assert.equal(episodes.body.items[0].state, 'notified')
    assert.equal(episodes.body.outbox[0].state, 'prepared')
  })
})

test('M03: scheduled and event reminders landing on the same step are both delivered', async () => {
  await withHost({ eventInject: { enabled: true } }, async (ctx, route) => {
    await request(route, 'POST', `${BASE}/templates`, { name: 'five', content: 'scheduled body', inject_enabled: true, inject_every: 5 })
    await request(route, 'PATCH', `${BASE}/event-policies/repeated-failure`, { enabled: true, mode: 'inject' })
    await emitResult(ctx, 's', 'c1', 'make', true)
    await emitResult(ctx, 's', 'c2', 'make', true)
    const decision = await preStep(ctx, 's', 5, 1, [{ role: 'user' }])
    const kinds = decision.messages?.slice(1).map(message => message.source?.['kind'])
    assert.deepEqual(kinds?.sort(), ['prompt-template-event', 'prompt-template-schedule'])
  })
})

test('audit routes: policies, episodes, and evidence-gated resolutions', async () => {
  await withHost({ eventInject: { enabled: true } }, async (ctx, route) => {
    const policies = await request(route, 'GET', `${BASE}/event-policies`)
    assert.equal(policies.status, 200)
    assert.equal(policies.body.items.length, 2)
    assert.equal((await request(route, 'PATCH', `${BASE}/event-policies/unknown`, { enabled: true })).status, 404)
    assert.equal((await request(route, 'PATCH', `${BASE}/event-policies/repeated-failure`, { threshold: -1 })).status, 400)
    assert.equal((await request(route, 'DELETE', `${BASE}/event-policies`)).status, 405)
    assert.equal((await request(route, 'GET', `${BASE}/event-episodes`)).status, 400)
    await request(route, 'PATCH', `${BASE}/event-policies/repeated-failure`, { enabled: true })
    await emitResult(ctx, 's', 'c1', 'make', true)
    await emitResult(ctx, 's', 'c2', 'make', true)
    const listed = await request(route, 'GET', `${BASE}/event-episodes?session_id=s`)
    const id = listed.body.items[0].episode_id as string
    assert.deepEqual(listed.body.items[0].evidence_refs, ['c1', 'c2'])
    const noEvidence = await request(route, 'PATCH', `${BASE}/event-episodes/${id}`, { state: 'verified' })
    assert.equal(noEvidence.status, 400)
    assert.equal(noEvidence.body.error.code, 'rule-violation')
    const resolved = await request(route, 'PATCH', `${BASE}/event-episodes/${id}`, { state: 'verified', evidence_refs: ['c3'], note: 'build passes' })
    assert.equal(resolved.status, 200)
    assert.equal(resolved.body.episode.state, 'verified')
    assert.equal((await request(route, 'PATCH', `${BASE}/event-episodes/missing`, { state: 'verified', evidence_refs: ['x'] })).status, 404)
  })
})

test('M08: a broken store never fails the tool result or the step; the fault is reported once', async () => {
  const errors: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pt-evbad-'))
    const notAFile = join(dir, 'db.sqlite3')
    mkdirSync(notAFile)
    try {
      await withHost({ eventInject: { enabled: true }, injectEnabled: false }, async (ctx) => {
        await emitResult(ctx, 's', 'c1', 'make', true)
        await emitResult(ctx, 's', 'c2', 'make', true)
        const decision = await preStep(ctx, 's', 1, 1, [{ role: 'user' }])
        assert.equal(decision.kind, 'enter')
        assert.equal(decision.messages?.length, 1)
        await preStep(ctx, 's', 1, 2, [])
      }, notAFile)
    } finally { rmSync(dir, { recursive: true, force: true }) }
    const ours = errors.filter(args => String((args as unknown[])[0]).includes('[dsh-prompt-templates] event'))
    assert.equal(ours.length, 2, 'one report for the observer, one for the pre-step consumer')
  } finally {
    console.error = original
  }
})
