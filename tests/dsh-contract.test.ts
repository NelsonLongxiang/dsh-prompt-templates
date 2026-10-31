/**
 * Contract and smoke checks against the pinned DSH 0.2.x peers.
 *
 * These run inside `pnpm test:cli` (and therefore `pnpm verify`). They do
 * not boot a browser or a harness process. Host HTTP coverage stays in
 * host-apply.test.ts; schema user_version stays in store-inject / visible-mode.
 *
 * A peer upgrade should fail here when a surface this plugin actually calls
 * changes: slot cardinality, the store engine, user-message construction,
 * the invariant registry, the bundle patch, or the 0.2 version line.
 *
 * `defineStore` is executed for real. The published store build imports
 * zustand and immer without declaring them, so package.json
 * `pnpm.packageExtensions` supplies those two for this package only.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context, resolveConfig, ValidationError } from '@deepseek-ai/cordis'
import { BUSY_ENTER_BEHAVIORS } from '@deepseek-ai/dsh-client-ui-conversation'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import * as host from '../src/index.ts'
import { PromptPanelController } from '../src/client/service.ts'
import { createPromptPanelPrefsStore, createPromptPanelStore } from '../src/client/store.ts'
import { renderInjectionMessage, renderVisibleInjectionMessage } from '../src/inject.ts'
import * as invariant from '../src/invariant.ts'
import { DEFAULT_INJECT_MAX_EVERY } from '../src/store.ts'
import type { InjectCandidate } from '../src/inject.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface PackageJson {
  name: string
  dsh: { bundle: { patch: string }, client: { platform: string, inject: string[] } }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson

function installedVersion(name: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
  return manifest.version
}

/** Kind and scope of one slot, read from the published 0.2.x declaration. */
function peerSlotSpec(file: string, slot: string): { kind: string, scope: string } {
  const text = readFileSync(join(root, file), 'utf8')
  const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`['"]${escaped}['"]\\s*:\\s*\\{([^}]*)\\}`))
  assert.ok(match, `DSH 0.2.x no longer declares slot "${slot}" in ${file}`)
  const body = match[1] ?? ''
  const kind = body.match(/kind:\s*['"](\w+)['"]/)?.[1]
  const scope = body.match(/scope:\s*['"]([\w-]+)['"]/)?.[1]
  assert.ok(kind, `slot "${slot}" has no kind`)
  assert.ok(scope, `slot "${slot}" has no scope`)
  assert.match(kind, /^(single|list|keyed|chain)$/)
  assert.match(scope, /^(root|session-maybe|session)$/)
  return { kind, scope }
}

const PEER_SLOTS = {
  'shell.overlay': 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts',
  'conversation.input.right': 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts',
  'sidebar.right.pane.tab': 'node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts',
} as const

interface PatchRow {
  id: string
  packageName: string
  dbPathExpr: string
}

/** The bundle patch is a small fixed document; pull the row the host installs. */
function readBundlePatch(): PatchRow {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const id = text.match(/^\s*- id:\s*(\S+)\s*$/m)?.[1]
  const packageName = text.match(/^\s*name:\s*['"]([^'"]+)['"]\s*$/m)?.[1]
  const marker = text.indexOf('!!js >')
  assert.ok(id, 'cordis.patch.yml is missing its plugin id')
  assert.ok(packageName, 'cordis.patch.yml is missing its package name')
  assert.ok(marker !== -1, 'cordis.patch.yml dbPath must stay a !!js sandbox expression')
  const lines = text.slice(marker + '!!js >'.length).split('\n')
  const body: string[] = []
  let blockIndent = -1
  for (const line of lines) {
    if (line.trim() === '') {
      if (body.length > 0) break
      continue
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (blockIndent === -1) blockIndent = indent
    // The folded scalar ends when indentation returns to the key, which is
    // also where the following YAML comments sit.
    if (indent < blockIndent || line.trimStart().startsWith('#')) break
    body.push(line.trim())
  }
  assert.ok(body.length > 0, 'cordis.patch.yml !!js block is empty')
  return { id, packageName, dbPathExpr: body.join(' ') }
}

/** Evaluate the patch sandbox expression the way the host's `!!js` tag does. */
function evalPatchPath(expr: string, env: Record<string, string | undefined>): string {
  const sandbox = {
    env,
    getBuiltinModule: process.getBuiltinModule.bind(process),
  }
  const value: unknown = new Function('process', `return (${expr});`)(sandbox)
  assert.equal(typeof value, 'string')
  return value as string
}

const due: InjectCandidate[] = [{
  id: 'a',
  name: '推动',
  content: 'keep moving',
  every: 5,
  mode: 'inject',
}]

test('installed @deepseek-ai/dsh-* peers stay on the 0.2 line this plugin declares', () => {
  const names = new Set<string>([
    ...Object.keys(pkg.devDependencies).filter(name => name.startsWith('@deepseek-ai/')),
    ...Object.keys(pkg.peerDependencies).filter(name => name.startsWith('@deepseek-ai/')),
  ])
  assert.ok(names.size > 0)
  for (const name of names) {
    const installed = installedVersion(name)
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assert.match(installed, /^0\.2\./, `${name}@${installed} left the 0.2 line`)
    }
    const pinned = pkg.devDependencies[name]
    if (pinned !== undefined) assert.equal(installed, pinned, name)
    const peer = pkg.peerDependencies[name]
    if (peer !== undefined && name.startsWith('@deepseek-ai/dsh-')) {
      assert.match(peer, /0\.2/, `${name} peer range no longer admits 0.2.x`)
    }
  }
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  for (const name of pkg.dsh.client.inject) {
    assert.match(installedVersion(name), /^0\.2\./, name)
  }
})

test('cordis patch names this package and its dbPath survives the schema cordis applies', () => {
  const patch = readBundlePatch()
  assert.equal(patch.id, host.name)
  assert.equal(patch.packageName, pkg.name)
  const fromHome = evalPatchPath(patch.dbPathExpr, { DSH_HOME: 'C:\\Users\\dsh' })
  assert.equal(fromHome, 'C:/Users/dsh/ext/prompt-templates/db.sqlite3')
  const fromDefault = evalPatchPath(patch.dbPathExpr, {})
  assert.match(fromDefault, /\/ext\/prompt-templates\/db\.sqlite3$/)
  assert.doesNotMatch(fromDefault, /^C:/)

  const decoded = resolveConfig(host, { dbPath: fromHome }) as {
    dbPath?: string
    injectEnabled?: boolean
    injectMaxEvery?: number
  }
  assert.equal(decoded.dbPath, fromHome)
  assert.equal(decoded.injectEnabled, true)
  assert.equal(decoded.injectMaxEvery, DEFAULT_INJECT_MAX_EVERY)
  assert.throws(() => resolveConfig(host, { dbPath: 1 }), ValidationError)
})

test('scheduled injection messages stay user-role messages the pre-step decision can carry', () => {
  const silent = renderInjectionMessage(10, due)
  assert.equal(silent.role, 'user')
  assert.equal(typeof silent.id, 'string')
  assert.ok(silent.id.length > 0)
  assert.equal(Object.isFrozen(silent), true)
  assert.equal(silent.source.kind, 'prompt-template-schedule')
  assert.equal(silent.source.turn, 10)
  assert.equal(silent.content[0]?.type, 'text')
  const decision = { kind: 'enter' as const, messages: [silent] }
  assert.equal(decision.messages[0]?.role, 'user')

  const visible = renderVisibleInjectionMessage(10, [{ ...due[0]!, mode: 'visible' }])
  assert.equal(visible.role, 'user')
  assert.equal(Object.isFrozen(visible), true)
  assert.equal(visible.source.kind, 'user')
  assert.equal((visible.source as { scheduled?: string }).scheduled, 'prompt-template')
  assert.equal(visible.content[0]?.type, 'text')
})

test('defineStore bakes panel actions and keeps prefs instances isolated', () => {
  const panel = createPromptPanelStore().create()
  assert.deepEqual(panel.getSnapshot(), { open: false, everOpened: false })
  panel.actions.toggle()
  assert.deepEqual(panel.getSnapshot(), { open: true, everOpened: true })
  panel.actions.close()
  assert.equal(panel.getSnapshot().open, false)
  assert.equal(panel.getSnapshot().everOpened, true)
  panel.actions.openOnce()
  assert.equal(panel.getSnapshot().open, false, 'openOnce is a no-op after the user has touched the panel')

  const fresh = createPromptPanelStore().create()
  fresh.actions.openOnce()
  assert.equal(fresh.getSnapshot().open, true)
  assert.equal(panel.getSnapshot().open, false, 'each create() is its own instance')

  const prefs = createPromptPanelPrefsStore()
  assert.equal(prefs.spec.persist, 'prompt-templates.panel')
  const left = prefs.create('left')
  const right = prefs.create('right')
  left.actions.setPosition(10.2, 20.8)
  assert.deepEqual(left.getSnapshot().panel, { x: 10, y: 21 })
  assert.equal(right.getSnapshot().panel, null)
  left.actions.resetPosition()
  assert.equal(left.getSnapshot().panel, null)
})

test('composer delivery uses SessionId identity and the 0.2 busy-enter modes', () => {
  assert.deepEqual([...BUSY_ENTER_BEHAVIORS], ['queue', 'steer'])
  const sessionId = SessionId('sess-contract')
  assert.equal(sessionId, 'sess-contract')

  const calls: { method: string, args: unknown[] }[] = []
  let draft = 'hello'
  const input = {
    setDraft(text: string) {
      draft = text
      calls.push({ method: 'setDraft', args: [text] })
    },
    submit(mode?: string) {
      calls.push({ method: 'submit', args: [mode] })
    },
    state: {
      getSnapshot: () => ({ draft, phase: 'plain' }),
      subscribe: () => () => {},
    },
    actions: {
      captureInsertion: () => ({ start: 1, end: 1, draftRev: 3 }),
      insertText: (text: string, span: { draftRev: number }) => {
        calls.push({ method: 'insertText', args: [text, span] })
        return true
      },
    },
  }
  const scope = { id: sessionId }
  const controller = new PromptPanelController()
  controller.bind({
    sessions: { scope: (id: string) => (id === sessionId ? scope : undefined) },
    conversation: { input: { for: (actx: unknown) => (actx === scope ? input : undefined) } },
  } as never)

  controller.insert(sessionId, 'TEMPLATE')
  assert.equal(calls.at(-1)?.method, 'insertText')
  assert.equal((calls.at(-1)?.args[1] as { draftRev: number }).draftRev, 3)

  controller.send(sessionId, 'SEND')
  assert.deepEqual(calls.at(-2), { method: 'setDraft', args: ['SEND'] })
  assert.deepEqual(calls.at(-1), { method: 'submit', args: [undefined] })

  controller.interject(sessionId, 'STEER')
  const mode = calls.at(-1)?.args[0]
  assert.equal(calls.at(-1)?.method, 'submit')
  assert.equal(mode, 'steer')
  assert.ok(BUSY_ENTER_BEHAVIORS.includes(mode as typeof BUSY_ENTER_BEHAVIORS[number]))
})

test('SlotCore 0.2 rejects a list seat without id and a keyed seat without key', () => {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    },
  }, () => null)
  assert.throws(() => core.register({ name: 'shell.overlay' }, () => null), /requires options\.id/)
  assert.throws(() => core.register({ name: 'sidebar.right.pane.tab' }, () => null), /requires options\.key/)
})

test('invariant companion reserves its package name on the real registry', async () => {
  const ctx = new Context()
  const registry = await ctx.plugin(InvariantRegistry)
  const first = await ctx.plugin(invariant)
  await assert.rejects(async () => { await ctx.plugin(invariant) }, /already registered/)
  await first.dispose()
  await registry.dispose()
})

test('published primitive icons the library imports are still runtime exports', () => {
  const library = readFileSync(join(root, 'src/client/Library.tsx'), 'utf8')
  const match = library.match(/import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/)
  assert.ok(match, 'Library.tsx no longer imports dsh-client-ui-primitives')
  const names = (match[1] ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
  assert.ok(names.length > 0)
  const bundle = readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const exported = bundle.match(/\nexport \{([\s\S]*?)\};/)
  assert.ok(exported, 'primitives bundle has no runtime export list')
  const exports = new Set((exported[1] ?? '').split(',').map(name => name.trim()))
  for (const name of names) {
    assert.ok(exports.has(name), `${name} is not a runtime export of @deepseek-ai/dsh-client-ui-primitives`)
  }
})

let loaderInstalled = false

async function ensureClientLoader(): Promise<void> {
  if (loaderInstalled) return
  loaderInstalled = true
  // Off-thread customization hooks. Current Node returns void and the chain is
  // ready before register() returns; a future Node that returns a promise must
  // be awaited or the client import races the hook.
  const pending = register(new URL('./dsh-contract-loader.mjs', import.meta.url).href, import.meta.url) as unknown
  if (pending instanceof Promise) await pending
}

test('client plugin loads against declared 0.2 slots, locale, and the sidebar tab registry', async () => {
  await ensureClientLoader()
  const client = await import('../src/client/index.ts')
  const specs = Object.fromEntries(
    Object.entries(PEER_SLOTS).map(([slot, file]) => [slot, peerSlotSpec(file, slot)]),
  ) as Record<string, { kind: string, scope: string }>

  const core = new SlotCore()
  core.register({ name: 'root', children: specs }, () => null)
  const slots = {
    inject(key: string, callback: () => unknown) {
      if (core.specDynamic(key) === undefined) {
        throw new Error(`slot "${key}" is not declared by the pinned DSH 0.2.x peers`)
      }
      return callback()
    },
    register(options: { name: string }, component: unknown) {
      return core.register(options, component)
    },
  }

  const dictionaries = new Map<string, { zh: Record<string, string>, en: Record<string, string> }>()
  const locale = {
    register(ns: string, dicts: { zh?: Record<string, string>, en?: Record<string, string> }) {
      if (dicts.zh === undefined || dicts.en === undefined) {
        throw new Error(`locale.register(${ns}): built-in zh and en dictionaries are required`)
      }
      assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
      dictionaries.set(ns, { zh: dicts.zh, en: dicts.en })
      return () => { dictionaries.delete(ns) }
    },
    bind(ns: string) {
      return (key: string) => dictionaries.get(ns)?.en[key] ?? key
    },
  }

  const tabDefinitions: { id: string, kind: string, title: (address: string) => string, guide?: { id: string, order: number }[] }[] = []
  const sidebarRightTabs = {
    register(definition: (typeof tabDefinitions)[number]) {
      if (tabDefinitions.some(existing => existing.id === definition.id)) {
        throw new Error(`sidebar tab id "${definition.id}" is already registered`)
      }
      tabDefinitions.push(definition)
      return () => {
        const index = tabDefinitions.indexOf(definition)
        if (index !== -1) tabDefinitions.splice(index, 1)
      }
    },
  }

  const ctx = new Context()
  ctx.provide('slots', slots)
  ctx.provide('sessions', { scope: () => undefined })
  ctx.provide('locale', locale)
  ctx.provide('conversation', { input: { for: () => undefined } })
  ctx.provide('sidebarRightTabs', sidebarRightTabs)

  const started = ctx.plugin(client)
  let timer: ReturnType<typeof setTimeout> | undefined
  const fiber = await Promise.race([
    started,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('client plugin did not become active (a required DSH service was missing)')), 3000)
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })

  try {
    assert.deepEqual([...client.inject], ['slots', 'sessions', 'locale', 'conversation'])
    const promptTemplates = dictionaries.get('promptTemplates')
    assert.ok(promptTemplates, 'locale.register("promptTemplates") did not run')
    assert.equal(promptTemplates.en['panel.open'], 'Open prompt panel')
    assert.equal(promptTemplates.zh['tab.title'], '提示词')

    const overlay = core.entries('shell.overlay')
    assert.equal(overlay.length, 1)
    assert.equal(overlay[0]?.options.id, 'prompt-templates')
    assert.equal(overlay[0]?.locale, 'promptTemplates')
    assert.equal(typeof overlay[0]?.store, 'function', 'shell.overlay must register the store factory, not a shared handle')
    const handle = (overlay[0]?.store as () => ReturnType<typeof createPromptPanelStore>)()
    const live = handle.create()
    const face = overlay[0]?.inject?.(live.actions, live) as { toggle?: unknown, refresh?: unknown } | undefined
    assert.equal(typeof face?.refresh, 'function')
    const panel = fiber.ctx.promptPanel as { toggle: () => void, targetSession: () => string | undefined }
    panel.toggle()
    assert.equal(live.getSnapshot().open, true)
    assert.equal(live.getSnapshot().everOpened, true)

    const composer = core.entries('conversation.input.right')
    assert.equal(composer.length, 1)
    assert.equal(composer[0]?.options.id, 'prompt-templates')
    const toggle = composer[0]?.inject?.() as { toggle: () => void, attachSession: (id: string) => void }
    toggle.attachSession('sess-contract')
    assert.equal(panel.targetSession(), 'sess-contract')
    toggle.toggle()
    assert.equal(live.getSnapshot().open, false)

    const tab = core.entries('sidebar.right.pane.tab')
    assert.equal(tab.length, 1)
    assert.equal(tab[0]?.options.key, '@nelsonlongxiang/dsh-prompt-templates')
    assert.equal(tab[0]?.locale, 'promptTemplates')
    assert.equal(tabDefinitions.length, 1)
    assert.equal(tabDefinitions[0]?.id, '@nelsonlongxiang/dsh-prompt-templates')
    assert.equal(tabDefinitions[0]?.kind, 'promptTemplates')
    assert.equal(tabDefinitions[0]?.title(''), 'Prompts')
    assert.equal(tabDefinitions[0]?.guide?.[0]?.order, 20)

    assert.equal(specs['shell.overlay']?.kind, core.specDynamic('shell.overlay')?.kind)
    assert.equal(specs['conversation.input.right']?.scope, core.specDynamic('conversation.input.right')?.scope)
    assert.equal(specs['sidebar.right.pane.tab']?.kind, 'keyed')
  } finally {
    await fiber.dispose()
  }
})
