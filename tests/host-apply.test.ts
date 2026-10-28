/**
 * Host wiring without a live DeepSeek Harness process: mount `apply()` on a
 * real Cordis context, stand in for the web server, and drive the HTTP
 * routes plus the `agent/pre-step` listener. The session object is a
 * structural fake (`header.id`, `snapshotEvents` / legacy `events`). This
 * does not boot `dsh web` or a real agent loop.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'
import { TemplateStore } from '../src/store.ts'

const TEMPLATES = '/plugins/dsh-prompt-templates/templates'
const CATEGORIES = '/plugins/dsh-prompt-templates/categories'
const INJECT_STATUS = '/plugins/dsh-prompt-templates/inject-status'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: EventEmitter, res: MockResponse) => void
}

interface MockResponse {
  writeHead(code: number, headers: Record<string, string>): MockResponse
  end(payload?: string): void
}

interface JsonResponse {
  status: number
  headers: Record<string, string>
  body: any
}

interface StepMessage {
  id?: string
  source?: { kind?: string, scheduled?: string, turn?: number, templates?: Array<{ name: string }> }
  content?: Array<{ type?: string, text?: string }>
}

interface StepDecision {
  kind: string
  messages?: StepMessage[]
}

interface HostHandle {
  ctx: Context
  dbPath: string
  route: () => RegisteredRoute | undefined
  handler: () => RegisteredRoute['handler']
  registerCount: () => number
  provide: (name: string) => void
  dispose: () => Promise<void>
}

function textOf(message: StepMessage | undefined): string {
  const block = message?.content?.[0]
  return block?.type === 'text' ? block.text ?? '' : ''
}

async function request(handler: RegisteredRoute['handler'], method: string, url: string, body?: unknown): Promise<JsonResponse> {
  const req = new EventEmitter() as EventEmitter & { method: string, url: string }
  req.method = method
  req.url = url
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${method} ${url}`)), 2000)
    const res: MockResponse & { status: number, headers: Record<string, string> } = {
      status: 0,
      headers: {},
      writeHead(code, headers) {
        this.status = code
        this.headers = headers
        return this
      },
      end(payload) {
        clearTimeout(timer)
        try {
          resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    handler(req, res)
    if (body !== undefined) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body)
      req.emit('data', Buffer.from(raw))
    }
    req.emit('end')
  })
}

async function preStep(ctx: Context, options: {
  sessionId: string
  turn: number
  step?: number
  messages?: unknown[]
  signal?: AbortSignal
  readEvents?: () => unknown[]
  legacyEvents?: unknown[]
  next?: () => Promise<StepDecision>
}): Promise<StepDecision> {
  const session: Record<string, unknown> = { header: { id: options.sessionId } }
  if (options.readEvents !== undefined) session['snapshotEvents'] = options.readEvents
  if (options.legacyEvents !== undefined) session['events'] = options.legacyEvents
  if (options.readEvents === undefined && options.legacyEvents === undefined) session['snapshotEvents'] = () => []
  return await ctx.waterfall('agent/pre-step', {
    agent: { session },
    messages: options.messages ?? [{ role: 'user' }],
    turn: options.turn,
    step: options.step ?? 1,
    signal: options.signal ?? new AbortController().signal,
  }, options.next ?? (async () => ({ kind: 'enter', messages: [{ id: 'downstream' }] }))) as Promise<StepDecision>
}

async function withHost(
  config: Record<string, unknown>,
  options: { server?: 'webServer' | 'httpServer' | 'none', when?: 'before' | 'after' },
  fn: (handle: HostHandle) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pt-host-'))
  const dbPath = join(dir, 'db.sqlite3')
  const ctx = new Context()
  const routes: RegisteredRoute[] = []
  let registers = 0
  const server = {
    register(route: RegisteredRoute) {
      registers += 1
      routes.push(route)
      return () => {}
    },
  }
  const key = options.server ?? 'webServer'
  const when = options.when ?? 'after'
  if (key !== 'none' && when === 'before') ctx.provide(key, server)
  const fiber = await ctx.plugin(host, { ...config, dbPath })
  if (key !== 'none' && when === 'after') ctx.provide(key, server)
  let disposed = false
  const handle: HostHandle = {
    ctx,
    dbPath,
    route: () => routes[0],
    handler: () => {
      const route = routes[0]
      assert.ok(route, 'expected the plugin to register its HTTP route')
      return route.handler
    },
    registerCount: () => registers,
    provide: (name: string) => { ctx.provide(name, server) },
    dispose: async () => {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
  }
  try {
    await fn(handle)
  } finally {
    await handle.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Config schema fills the inject defaults deployments may omit', () => {
  const decoded = host.Config({ dbPath: '/tmp/prompt-templates.sqlite3' }) as {
    dbPath?: string
    injectEnabled?: boolean
    injectMaxEvery?: number
  }
  assert.equal(decoded.dbPath, '/tmp/prompt-templates.sqlite3')
  assert.equal(decoded.injectEnabled, true)
  assert.equal(decoded.injectMaxEvery, 1000)
})

test('apply mounts routes when the web server appears and serves template CRUD', async () => {
  await withHost({}, { server: 'webServer', when: 'after' }, async (handle) => {
    assert.equal(existsSync(handle.dbPath), false)
    assert.equal(handle.registerCount(), 1)
    assert.equal(handle.route()?.kind, 'prefix')
    assert.equal(handle.route()?.path, '/plugins/dsh-prompt-templates')
    // A second web-server-shaped service must not register the prefix again.
    handle.provide('httpServer')
    assert.equal(handle.registerCount(), 1)

    const handler = handle.handler()
    const empty = await request(handler, 'GET', TEMPLATES)
    assert.equal(existsSync(handle.dbPath), true)
    assert.equal(empty.status, 200)
    assert.equal(empty.headers['cache-control'], 'no-store')
    assert.match(empty.headers['content-type'], /^application\/json/)
    assert.deepEqual(empty.body, { items: [] })

    const category = await request(handler, 'POST', CATEGORIES, { name: 'work' })
    assert.equal(category.status, 200, JSON.stringify(category.body))
    assert.deepEqual(category.body.category, { name: 'work', scope: 'global', session_id: null })
    const categories = await request(handler, 'GET', CATEGORIES)
    assert.deepEqual(categories.body.items, [{ name: 'work', scope: 'global', session_id: null }])
    // A session tab is its own partition: create and delete it by query, separately from globals.
    const sessionCategory = await request(handler, 'POST', CATEGORIES, {
      name: 'local', scope: 'session', session_id: 'sess-a',
    })
    assert.equal(sessionCategory.status, 200, JSON.stringify(sessionCategory.body))
    const removedSessionCategory = await request(handler, 'DELETE', `${CATEGORIES}/local?scope=session&session_id=sess-a`)
    assert.deepEqual(removedSessionCategory.body, { deleted: true })

    const created = await request(handler, 'POST', TEMPLATES, {
      name: 'shared', content: 'global body', category: 'work', inject_enabled: true, inject_every: 4,
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const id = created.body.template.id as string
    assert.equal(created.body.template.inject_every, 4)
    assert.equal(created.body.template.category, 'work')

    const fetched = await request(handler, 'GET', `${TEMPLATES}/${id}`)
    assert.equal(fetched.status, 200)
    assert.equal(fetched.body.template.name, 'shared')

    const patched = await request(handler, 'PATCH', `${TEMPLATES}/${id}`, { content: 'edited' })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.template.content, 'edited')
    assert.equal(patched.body.template.inject_every, 4)

    const removedCategory = await request(handler, 'DELETE', `${CATEGORIES}/work?scope=global`)
    assert.deepEqual(removedCategory.body, { deleted: true })
    const afterCategory = await request(handler, 'GET', `${TEMPLATES}/${id}`)
    assert.equal(afterCategory.body.template.category, null)

    const sessionTemplate = await request(handler, 'POST', TEMPLATES, {
      name: 'priv', content: 'private body', scope: 'session', session_id: 'sess-a',
      inject_enabled: true, inject_every: 4,
    })
    assert.equal(sessionTemplate.status, 200, JSON.stringify(sessionTemplate.body))
    const sessionId = sessionTemplate.body.template.id as string
    const promoted = await request(handler, 'POST', `${TEMPLATES}/${sessionId}/make-global`)
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
    assert.equal(promoted.body.template.scope, 'global')
    assert.equal(promoted.body.template.session_id, null)
    assert.equal(promoted.body.template.inject_enabled, true)
    assert.equal(promoted.body.template.inject_every, 4)

    const deleted = await request(handler, 'DELETE', `${TEMPLATES}/${id}`)
    assert.deepEqual(deleted.body, { deleted: true })
    const gone = await request(handler, 'GET', `${TEMPLATES}/${id}`)
    assert.equal(gone.status, 404)
    assert.equal(gone.body.error.code, 'not-found')
  })
})

test('routes surface rule, method, and inject-status errors and honor injectMaxEvery', async () => {
  await withHost({ injectMaxEvery: 10 }, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    const over = await request(handler, 'POST', TEMPLATES, {
      name: 'over', content: 'c', inject_enabled: true, inject_every: 11,
    })
    assert.equal(over.status, 400)
    assert.equal(over.body.error.code, 'rule-violation')
    assert.match(over.body.error.message, /1 and 10/)

    const missingInterval = await request(handler, 'POST', TEMPLATES, {
      name: 'bare', content: 'c', inject_enabled: true,
    })
    assert.equal(missingInterval.status, 400)
    assert.equal(missingInterval.body.error.code, 'rule-violation')

    const edge = await request(handler, 'POST', TEMPLATES, {
      name: 'edge', content: 'c', inject_enabled: true, inject_every: 10,
    })
    assert.equal(edge.status, 200)
    assert.equal(edge.body.template.inject_every, 10)

    const unknown = await request(handler, 'GET', '/plugins/dsh-prompt-templates/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'not-found')

    const method = await request(handler, 'PUT', CATEGORIES)
    assert.equal(method.status, 405, JSON.stringify(method.body))
    assert.equal(method.body.error.code, 'method-not-allowed')
    const templateMethod = await request(handler, 'PUT', `${TEMPLATES}/${edge.body.template.id}`)
    assert.equal(templateMethod.status, 405, JSON.stringify(templateMethod.body))

    const missingSession = await request(handler, 'GET', INJECT_STATUS)
    assert.equal(missingSession.status, 400)
    assert.equal(missingSession.body.error.code, 'bad-request')
    const blankSession = await request(handler, 'GET', `${INJECT_STATUS}?session_id=`)
    assert.equal(blankSession.status, 400)
    const posted = await request(handler, 'POST', `${INJECT_STATUS}?session_id=sess-a`)
    assert.equal(posted.status, 405)
    const quiet = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.deepEqual(quiet.body, { status: null })

    const malformed = await request(handler, 'POST', TEMPLATES, '{')
    assert.equal(malformed.status, 500)
    assert.equal(malformed.body.error.code, 'store-error')

    const absent = await request(handler, 'DELETE', `${TEMPLATES}/missing`)
    assert.deepEqual(absent.body, { deleted: false })
    const missingPatch = await request(handler, 'PATCH', `${TEMPLATES}/missing`, { content: 'x' })
    assert.equal(missingPatch.status, 404)
  })
})

test('pre-step injects due templates, records inject-status, and stays idempotent per session', async () => {
  await withHost({}, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    const global = await request(handler, 'POST', TEMPLATES, {
      name: 'global-one', content: 'global body', inject_enabled: true, inject_every: 5, position: 1,
    })
    const session = await request(handler, 'POST', TEMPLATES, {
      name: 'session-one', content: 'session body', scope: 'session', session_id: 'sess-a',
      inject_enabled: true, inject_every: 5, position: 2,
    })
    assert.equal(global.status, 200)
    assert.equal(session.status, 200)

    const early = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 4 })
    assert.equal(early.messages?.length, 1)
    const earlyStatus = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.deepEqual(earlyStatus.body, { status: null })

    const injected = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 5 })
    assert.equal(injected.kind, 'enter')
    assert.equal(injected.messages?.length, 2)
    const message = injected.messages?.[1]
    assert.equal(message?.source?.kind, 'prompt-template-schedule')
    assert.equal(message?.source?.turn, 5)
    assert.deepEqual(message?.source?.templates?.map(item => item.name), ['global-one', 'session-one'])
    const text = textOf(message)
    assert.match(text, /^<system-reminder>/)
    assert.ok(text.includes('global body'))
    assert.ok(text.includes('session body'))

    const status = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.equal(status.body.status.turn, 5)
    assert.deepEqual(status.body.status.templates, ['global-one', 'session-one'])
    assert.equal(typeof status.body.status.at, 'number')

    const again = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 5, step: 2 })
    assert.equal(again.messages?.length, 1)
    const statusAgain = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.equal(statusAgain.body.status.at, status.body.status.at)

    const other = await preStep(handle.ctx, { sessionId: 'sess-b', turn: 5 })
    assert.equal(other.messages?.length, 2)
    assert.deepEqual(other.messages?.[1]?.source?.templates?.map(item => item.name), ['global-one'])
    const otherStatus = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-b`)
    assert.deepEqual(otherStatus.body.status.templates, ['global-one'])
    const originalStatus = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.deepEqual(originalStatus.body.status.templates, ['global-one', 'session-one'])
  })
})

test('pre-step splits visible and silent delivery into two messages', async () => {
  await withHost({}, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    assert.equal((await request(handler, 'POST', TEMPLATES, {
      name: 'quiet', content: 'silent body', inject_enabled: true, inject_every: 1, position: 1, mode: 'inject',
    })).status, 200)
    assert.equal((await request(handler, 'POST', TEMPLATES, {
      name: 'shown', content: 'visible body', inject_enabled: true, inject_every: 1, position: 2, mode: 'visible',
    })).status, 200)

    const decision = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1 })
    assert.equal(decision.messages?.length, 3)
    const silent = decision.messages?.[1]
    const visible = decision.messages?.[2]
    assert.equal(silent?.source?.kind, 'prompt-template-schedule')
    assert.deepEqual(silent?.source?.templates?.map(item => item.name), ['quiet'])
    assert.match(textOf(silent), /^<system-reminder>/)
    assert.ok(textOf(silent).includes('silent body'))
    assert.equal(visible?.source?.kind, 'user')
    assert.equal(visible?.source?.scheduled, 'prompt-template')
    assert.equal(visible?.source?.turn, 1)
    assert.deepEqual(visible?.source?.templates?.map(item => item.name), ['shown'])
    assert.match(textOf(visible), /定时注入 · 第 1 轮/)
    assert.ok(textOf(visible).includes('visible body'))
    assert.doesNotMatch(textOf(visible), /<system-reminder>/)
  })
})

test('pre-step dedups from snapshotEvents, falls back to legacy events, and rescans after the log shrinks', async () => {
  await withHost({}, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    assert.equal((await request(handler, 'POST', TEMPLATES, {
      name: 'cadence', content: 'every two', inject_enabled: true, inject_every: 2,
    })).status, 200)
    const prior = [{ type: 'user/message', data: { source: { kind: 'prompt-template-schedule', turn: 2 } } }]

    const fromSnapshot = await preStep(handle.ctx, {
      sessionId: 'snap', turn: 2, readEvents: () => prior, legacyEvents: [],
    })
    assert.equal(fromSnapshot.messages?.length, 1)

    const fromLegacy = await preStep(handle.ctx, {
      sessionId: 'legacy', turn: 2, legacyEvents: prior,
    })
    assert.equal(fromLegacy.messages?.length, 1)

    const log = {
      events: [
        { type: 'turn/close', data: {} },
        { type: 'turn/close', data: {} },
        { type: 'turn/close', data: {} },
      ] as unknown[],
    }
    const first = await preStep(handle.ctx, {
      sessionId: 'compact', turn: 2, readEvents: () => log.events,
    })
    assert.equal(first.messages?.length, 2)
    const noted = await request(handler, 'GET', `${INJECT_STATUS}?session_id=compact`)
    assert.equal(noted.body.status.turn, 2)

    // Compaction rewrites the log shorter than the memo's scanned index, but
    // the replacement still records turn 4. A rescan must see it.
    log.events = [{ type: 'user/message', data: { source: { kind: 'user', scheduled: 'prompt-template', turn: 4 } } }]
    const shrunk = await preStep(handle.ctx, {
      sessionId: 'compact', turn: 4, readEvents: () => log.events,
    })
    assert.equal(shrunk.messages?.length, 1)
    const still = await request(handler, 'GET', `${INJECT_STATUS}?session_id=compact`)
    assert.equal(still.body.status.turn, 2)
    assert.equal(still.body.status.at, noted.body.status.at)
  })
})

test('pre-step passes through when injection is disabled, rejected, empty, or already logged', async () => {
  await withHost({ injectEnabled: false }, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    assert.equal((await request(handler, 'POST', TEMPLATES, {
      name: 'on', content: 'body', inject_enabled: true, inject_every: 1,
    })).status, 200)
    const skipped = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1 })
    assert.equal(skipped.messages?.length, 1)
    assert.equal(skipped.messages?.[0]?.id, 'downstream')
    const status = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.deepEqual(status.body, { status: null })
  })

  await withHost({}, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    assert.equal((await request(handler, 'POST', TEMPLATES, {
      name: 'on', content: 'body', inject_enabled: true, inject_every: 1,
    })).status, 200)

    const rejected = await preStep(handle.ctx, {
      sessionId: 'sess-a', turn: 1,
      next: async () => ({ kind: 'reject' }),
    })
    assert.deepEqual(rejected, { kind: 'reject' })

    const empty = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1, messages: [] })
    assert.equal(empty.messages?.length, 1)
    assert.equal(empty.messages?.[0]?.id, 'downstream')

    const logged = await preStep(handle.ctx, {
      sessionId: 'sess-a', turn: 1,
      readEvents: () => [{ type: 'user/message', data: { source: { kind: 'prompt-template-schedule', turn: 1 } } }],
    })
    assert.equal(logged.messages?.length, 1)
    const status = await request(handler, 'GET', `${INJECT_STATUS}?session_id=sess-a`)
    assert.deepEqual(status.body, { status: null })
  })
})

test('httpServer is accepted at boot and a headless profile still injects', async () => {
  await withHost({}, { server: 'httpServer', when: 'before' }, async (handle) => {
    assert.equal(handle.registerCount(), 1)
    const listed = await request(handle.handler(), 'GET', TEMPLATES)
    assert.deepEqual(listed.body, { items: [] })
  })

  await withHost({}, { server: 'none' }, async (handle) => {
    assert.equal(handle.registerCount(), 0)
    const seed = new TemplateStore(handle.dbPath)
    seed.create({ name: 'n', content: 'seeded body', inject_enabled: true, inject_every: 1 })
    seed.close()
    const decision = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1 })
    assert.equal(decision.messages?.length, 2)
    assert.equal(decision.messages?.[1]?.source?.kind, 'prompt-template-schedule')
    assert.ok(textOf(decision.messages?.[1]).includes('seeded body'))
  })
})

test('listener faults stay inside the step, and dispose closes the store', async () => {
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('[dsh-prompt-templates]')) logged.push(args)
    else original.apply(console, args)
  }
  try {
    await withHost({}, { when: 'before' }, async (handle) => {
      const handler = handle.handler()
      assert.equal((await request(handler, 'POST', TEMPLATES, {
        name: 'on', content: 'body', inject_enabled: true, inject_every: 1,
      })).status, 200)
      const aborted = new AbortController()
      aborted.abort()
      const skipped = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1, signal: aborted.signal })
      assert.equal(skipped.messages?.length, 1)
      assert.equal(logged.length, 1)
      const skippedAgain = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1, step: 2, signal: aborted.signal })
      assert.equal(skippedAgain.messages?.length, 1)
      assert.equal(logged.length, 1)
      // The aborted attempt did not consume the boundary, so a later step still injects.
      const recovered = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1, step: 3 })
      assert.equal(recovered.messages?.length, 2)
      assert.equal(logged.length, 1)
    })

    await withHost({}, { when: 'before' }, async (handle) => {
      const db = new DatabaseSync(handle.dbPath)
      db.exec('PRAGMA user_version=9')
      db.close()
      const before = logged.length
      const decision = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 1 })
      assert.equal(decision.messages?.length, 1)
      assert.equal(decision.messages?.[0]?.id, 'downstream')
      const again = await preStep(handle.ctx, { sessionId: 'sess-a', turn: 2, step: 2 })
      assert.equal(again.messages?.length, 1)
      assert.equal(logged.length, before + 1)
      const response = await request(handle.handler(), 'GET', TEMPLATES)
      assert.equal(response.status, 500)
      assert.equal(response.body.error.code, 'store-error')
      assert.match(response.body.error.message, /schema version 9/)
    })
  } finally {
    console.error = original
  }

  await withHost({}, { when: 'before' }, async (handle) => {
    const handler = handle.handler()
    const created = await request(handler, 'POST', TEMPLATES, { name: 'kept', content: 'body' })
    assert.equal(created.status, 200)
    await handle.dispose()
    const closed = await request(handler, 'GET', TEMPLATES)
    assert.equal(closed.status, 500)
    assert.match(closed.body.error.message, /not open/)
    const reopened = new TemplateStore(handle.dbPath)
    try {
      assert.equal(reopened.list().length, 1)
      assert.equal(reopened.list()[0]?.name, 'kept')
    } finally {
      reopened.close()
    }
  })
})
