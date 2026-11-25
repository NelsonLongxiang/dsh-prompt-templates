/**
 * dsh-open-a2a-net PR #864 review (issuecomment-7100160736, two non-blocking notes): that host's role allowlist decides
 * only whether a router or a builder may call these seven tools. That they act on the calling session alone is kept here,
 * so it is pinned here: the list is exactly the seven names, each tool's parameters are a fixed set with nothing that
 * names a session, a path, a command or a file, and the session is taken only from exec.agent.session.header.id.
 * The two hosts' lists drifting apart (another branch had three names) or a parameter that reaches beyond the caller
 * turns this red.
 */
import { createTestDirectory } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as host from '../src/index.ts'
import { LESSON_SELF_TOOLS } from '../src/lessons.ts'

const SEVEN = ['lesson_write', 'lesson_none', 'lesson_keep', 'lesson_timeline', 'lesson_type_propose', 'selfcheck_write', 'selfcheck_conclude']
/**
 * Explicit exceptions, with each tool's purpose: this is a test inventory, not a runtime permission list.
 * Currently empty: lessons.ts registers five self tools and self-check.ts registers two; index.ts's panel HTTP routes
 * do not register model tools. Any new tool, regardless of its prefix, must be classified deliberately here or as self.
 */
const NON_SELF_TOOLS: Record<string, string> = {}
/** Every parameter each tool takes, as the model sees it: anything added here is a deliberate, reviewed change. */
const FIELDS: Record<string, string[]> = {
  lesson_write: ['text', 'type', 'evidence', 'outcome'],
  lesson_none: ['reason'],
  lesson_keep: ['type', 'evidence'],
  lesson_timeline: ['limit', 'type'],
  lesson_type_propose: ['name', 'description'],
  selfcheck_write: ['text'],
  selfcheck_conclude: ['conclusion', 'evidence', 'wake', 'deadline', 'ticket', 'card', 'no_card'],
}
/** Words that, as a part of a parameter name, would let a call reach beyond the calling session or into the host. */
const FORBIDDEN = new Set(['session', 'sid', 'agent', 'caller', 'path', 'paths', 'file', 'files', 'dir', 'directory', 'cwd', 'folder', 'command', 'cmd', 'shell', 'exec', 'script', 'url', 'uri', 'home'])
/** A parameter name's parts: session_id, sessionId and session-id all give session and id. */
const parts = (name: string): string[] => name.split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/).map(p => p.toLowerCase()).filter(p => p !== '')
/** Valid arguments for each tool, so a refusal below can only be about the missing session. */
const VALID: Record<string, Record<string, unknown>> = {
  lesson_write: { text: '当测试先失败时，先看第一条报错，因为后面的常是连锁。', type: '找' },
  lesson_none: { reason: '本轮无可记' },
  lesson_keep: { type: '找', evidence: '第二次先读首条报错后测试通过' },
  lesson_timeline: {},
  lesson_type_propose: { name: '测', description: '测试用的类型说明' },
  selfcheck_write: { text: '做完：测试实跑通过。' },
  selfcheck_conclude: { conclusion: 'continue' },
}
const sorted = (xs: readonly string[]): string[] => [...xs].sort()

test('the forbidden-word check itself sees a session, path, command or file in the usual spellings', () => {
  for (const name of ['session_id', 'sessionId', 'targetSession', 'path', 'filePath', 'cwd', 'command', 'shell_cmd', 'url'])
    assert.notDeepEqual(parts(name).filter(p => FORBIDDEN.has(p)), [], name)
  for (const name of ['description', 'deadline', 'evidence', 'reason', 'card', 'no_card']) assert.deepEqual(parts(name).filter(p => FORBIDDEN.has(p)), [], name)
})

test('LESSON_SELF_TOOLS is exactly the seven self tools', () => {
  assert.deepEqual(sorted(LESSON_SELF_TOOLS), sorted(SEVEN))
  assert.equal(new Set(LESSON_SELF_TOOLS).size, LESSON_SELF_TOOLS.length, 'no name twice')
})

class FakeSystemPrompt extends Service {
  static inject: string[] = []
  tools(_cb: (tool: unknown) => void) {}
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
}

test('the self tools the model sees are exactly the list, with a fixed set of parameters naming no session, path, command or file', async () => {
  const ctx = new Context()
  await ctx.plugin(FakeSystemPrompt as never)
  await ctx.plugin(ToolRuntime as never)
  const runtime = ctx.tools as unknown as { schemas: () => Array<{ name: string, parameters: { properties?: Record<string, unknown> } }> }
  const before = new Set(runtime.schemas().map(s => s.name))
  const dir = createTestDirectory('pt-self-tools-')
  const fiber = await ctx.plugin(host as never, { dbPath: join(dir, 'db.sqlite3') } as never)
  try {
    await new Promise(resolve => setImmediate(resolve))
    const added = runtime.schemas().filter(s => !before.has(s.name))
    const self = added.filter(s => LESSON_SELF_TOOLS.includes(s.name))
    const nonSelf = added.filter(s => !LESSON_SELF_TOOLS.includes(s.name))
    assert.deepEqual(sorted(nonSelf.map(s => s.name)), sorted(Object.keys(NON_SELF_TOOLS)), 'every other tool this plugin registers, regardless of prefix, needs an explicit non-self classification')
    for (const [name, purpose] of Object.entries(NON_SELF_TOOLS)) {
      assert.ok(!LESSON_SELF_TOOLS.includes(name), name + ' cannot be both self and non-self')
      assert.ok(purpose.trim() !== '', name + ' needs its actual purpose recorded')
    }
    assert.deepEqual(sorted(self.map(s => s.name)), sorted(LESSON_SELF_TOOLS), 'every self tool this plugin registers is on the list, and every listed one is registered')
    for (const s of self) {
      const fields = Object.keys(s.parameters.properties ?? {})
      assert.deepEqual(sorted(fields), sorted(FIELDS[s.name] ?? []), s.name + ' parameters')
      for (const field of fields) assert.deepEqual(parts(field).filter(p => FORBIDDEN.has(p)), [], s.name + '.' + field)
    }
  } finally {
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
    await (ctx as unknown as { destroy?: () => Promise<void> }).destroy?.()
  }
})

type Tool = { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }
const agentOf = (sessionId: string): unknown => ({ session: { header: { id: sessionId }, snapshotEvents: () => [] } })

test('each self tool takes the session only from exec.agent.session.header.id, never from its arguments or elsewhere on exec', async t => {
  const dir = createTestDirectory('pt-self-session-')
  const ctx = new Context()
  const registered = new Map<string, Tool>()
  ctx.provide('webServer', { register() { return () => {} } })
  ctx.provide('tools' as never, { register: (tool: { name: string }) => { registered.set(tool.name, tool as never) } } as never)
  const fiber = await ctx.plugin(host as never, { dbPath: join(dir, 'db.sqlite3') } as never)
  try {
    const elsewhere = { session_id: 'session-other', sessionId: 'session-other', session: 'session-other', path: '/elsewhere', file: '/elsewhere', command: 'true' }
    for (const name of SEVEN) {
      await t.test(name + ' refuses without a calling session', async () => {
        const tool = registered.get(name)
        assert.ok(tool !== undefined, name + ' is registered')
        // No calling agent: whatever else names a session, the tool refuses.
        const out = await tool.execute({ ...VALID[name], ...elsewhere }, { sessionId: 'session-other', session: { header: { id: 'session-other' } }, callerSession: 'session-other' })
        assert.equal(out['code'], 'session', name + ' refuses without a calling agent')
      })
    }
    // With an agent, a session named in the arguments is ignored: the lesson is the caller's alone.
    const write = await registered.get('lesson_write')!.execute({ ...VALID['lesson_write'], ...elsewhere }, { agent: agentOf('session-caller') })
    assert.equal(write['ok'], true, JSON.stringify(write))
    const timeline = async (id: string): Promise<string> => JSON.stringify(await registered.get('lesson_timeline')!.execute({ session_id: 'session-other' }, { agent: agentOf(id) }))
    assert.match(await timeline('session-caller'), /先看第一条报错/)
    assert.doesNotMatch(await timeline('session-other'), /先看第一条报错/)
  } finally {
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
