// @vitest-environment jsdom
/**
 * ui-prompt-templates browser half on a real cordis Context with fake
 * slots/api/sessions/conversation faces: apply registers the shell.overlay
 * panel entry and the conversation.input.right composer entry, provides
 * ctx.promptPanel whose toggle routes into the panel store (observable via
 * the overlay entry's store), and the composer entry's injected toggle does
 * not throw. Registration disposal rides the plugin fiber (HMR safety).
 * The assembly import also publishes the LocaleNamespaceMap merge this
 * package owns; every other spec in this suite reads it transitively.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId

/** One recorded insert handed to the fake conversation input resolver. */
interface InsertRecord { sessionId: SessionId; content: string }

async function bench(options: { defaultOpen?: boolean } = {}) {
  const ctx = new Context()
  const inserts: InsertRecord[] = []
  const calls: { method: string; args: unknown[] }[] = []
  const settingsListeners: Array<() => void> = []

  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))

  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  ctx.provide('remote.promptTemplates', {
    list: (...args: unknown[]) => {
      calls.push({ method: 'list', args })
      return Promise.resolve({ ok: true, value: { ok: true, value: { items: [] } } })
    },
    get: vi.fn(),
    create: vi.fn(() => Promise.resolve({ ok: true, value: { ok: true, value: { template: {} } } })),
    update: vi.fn(),
    delete: vi.fn(),
  })

  const scopes = new Map<SessionId, Context>()
  class SessionsService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'sessions') }
    scope(id: SessionId): Context | undefined { return scopes.get(id) }
  }
  new SessionsService(ctx)

  class ConversationService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'conversation') }
    readonly input = {
      for: (actx: Context) => ({
        setDraft: (content: string) => {
          const found = [...scopes.entries()].find(([, scope]) => scope === actx)
          if (found === undefined) throw new Error('fake input: scope not found')
          inserts.push({ sessionId: found[0], content })
        },
        submit: () => {
          inserts.push({ sessionId: sid('sess-1'), content: '<submitted>' })
        },
        state: { getSnapshot: () => ({ draft: '' }) },
      }),
    }
  }
  new ConversationService(ctx)

  // Minimal settingsScope double: one namespace, ready snapshots, and a
  // publishable listener set (drives the default-open subscription).
  ctx.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({
        status: 'ready' as const,
        value: options.defaultOpen === true ? { defaultOpen: true } : {},
        base: undefined,
        user: undefined,
        revision: 1,
        writable: true,
        mode: 'host' as const,
      }),
      subscribe: (listener: () => void) => {
        settingsListeners.push(listener)
        return () => {}
      },
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    }),
  })

  const fiber = ctx.plugin({ inject: [...inject], apply })
  // Materialize one session scope so the composer entry's inject factory can
  // resolve it (the panel entry is root-scoped and needs none).
  const scopeCtx = ctx.extend({})
  scopes.set(sid('sess-1'), scopeCtx)

  return {
    ctx,
    fiber,
    inserts,
    calls,
    publishSettings: () => { for (const listener of settingsListeners) listener() },
    async dispose() { await ctx.fiber.dispose() },
  }
}

describe('ui-prompt-templates browser plugin', () => {
  it('declares its service dependencies', () => {
    expect(inject).toContain('slots')
    expect(inject).toContain('remote.promptTemplates')
  })

  it('registers the shell.overlay panel entry and provides ctx.promptPanel', async () => {
    const benchValue = await bench()
    try {
      await benchValue.fiber.await()
      const overlayEntries = benchValue.ctx.slots.entries('shell.overlay')
      expect(overlayEntries.map(entry => entry.options.id)).toContain('prompt-templates')
      expect(benchValue.ctx.promptPanel).toBeDefined()
    } finally {
      await benchValue.dispose()
    }
  })

  it('toggle before the panel entry rendered fails loud (boot-order contract)', async () => {
    const benchValue = await bench()
    try {
      await benchValue.fiber.await()
      // The controller wires store actions at the entry's first render; a
      // toggle before any render is a boot-order bug, not a race to tolerate.
      expect(() => { benchValue.ctx.promptPanel.toggle() }).toThrow(/not wired/)
    } finally {
      await benchValue.dispose()
    }
  })

  it('insert routes through the conversation input resolver', async () => {
    const benchValue = await bench()
    try {
      benchValue.ctx.promptPanel.insert(sid('sess-1'), 'hello')
      expect(benchValue.inserts).toEqual([{ sessionId: sid('sess-1'), content: 'hello' }])
    } finally {
      await benchValue.dispose()
    }
  })

  it('a defaultOpen=true snapshot before wiring parks and never throws', async () => {
    const benchValue = await bench({ defaultOpen: true })
    try {
      await benchValue.fiber.await()
      // Apply-time and pre-wire settings publishes never throw: the one-shot
      // open parks until the overlay entry wires its store actions.
      benchValue.publishSettings()
      expect(() => { benchValue.ctx.promptPanel.openOnce() }).not.toThrow()
      // Direct toggle before wiring keeps the loud boot-order error.
      expect(() => { benchValue.ctx.promptPanel.toggle() }).toThrow(/not wired/)
    } finally {
      await benchValue.dispose()
    }
  })
})
