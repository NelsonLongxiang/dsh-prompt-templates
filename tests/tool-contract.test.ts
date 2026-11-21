/**
 * Contract test against the REAL ToolRuntime (@deepseek-ai/dsh-tools, a devDependency):
 * a definition without `output: { schema, render }` must be rejected, and the plugin's three
 * tool definitions (wrapped with withOutput) must register. The fake registries in the unit
 * tests accept any shape and cannot catch this (found on a real host 2026-11-21; #43 follow-up).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { withOutput } from '../src/tool-registry.ts'

class FakeSystemPrompt extends Service {
  static inject: string[] = []
  sections: unknown[] = []
  toolsCb: ((tool: unknown) => void) | undefined
  tools(cb: (tool: unknown) => void) { this.toolsCb = cb }
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
}

async function harness(): Promise<{ ctx: Context, cleanup: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(FakeSystemPrompt as never)
  await ctx.plugin(ToolRuntime as never)
  assert.equal(typeof ctx.tools?.register, 'function', 'the real tools service is up')
  return { ctx, cleanup: async () => { await (ctx as unknown as { destroy?: () => Promise<void> }).destroy?.() } }
}

test('the real ToolRuntime rejects a definition without output', async () => {
  const { ctx, cleanup } = await harness()
  try {
    const bare = { name: 'contract_probe_bare', description: 'probe', parameters: { text: { type: 'string', required: true } }, execute: async () => ({ ok: true }) }
    const tools = ctx.tools as unknown as { register: (t: unknown) => unknown }
    assert.throws(() => { tools.register(bare) }, /output/, 'registration must demand the output contract')
  } finally { await cleanup() }
})

test('withOutput satisfies the real ToolRuntime for the plugin\'s tool shapes', async () => {
  const { ctx, cleanup } = await harness()
  try {
    const lessonWrite = withOutput({
      name: 'lesson_write',
      description: 'probe copy of the plugin definition',
      parameters: {
        text: { type: 'string', required: true, description: 'The lesson, 1..160 characters.' },
        replace: { type: 'number', description: 'Optional: the number N of lesson 体会·N to rewrite.' },
      },
      execute: async () => ({ ok: true, id: 'probe', index: 1, version: 'lesson-r1' }),
    })
    const selfcheckWrite = withOutput({ name: 'selfcheck_write', description: 'probe', parameters: { text: { type: 'string', required: true } }, execute: async () => ({ ok: true }) })
    const selfcheckConclude = withOutput({ name: 'selfcheck_conclude', description: 'probe', parameters: { conclusion: { type: 'string', required: true } }, execute: async () => ({ ok: true }) })
    const tools = ctx.tools as unknown as { register: (t: unknown) => unknown, schemas: () => Array<{ name: string }> }
    tools.register(lessonWrite)
    tools.register(selfcheckWrite)
    tools.register(selfcheckConclude)
    const names = tools.schemas().map((s) => s.name)
    for (const name of ['lesson_write', 'selfcheck_write', 'selfcheck_conclude']) {
      assert.ok(names.includes(name), `${name} registered on the real runtime`)
    }
  } finally { await cleanup() }
})

test('the plugin\'s own tools reach the model with an object parameter schema naming their fields (#50)', async () => {
  const { ctx, cleanup } = await harness()
  const { createTestDirectory } = await import('./temp-dir.mjs')
  const { join } = await import('node:path')
  const { rmSync } = await import('node:fs')
  const host = await import('../src/index.ts')
  const dir = createTestDirectory('pt-tool-schema-')
  const fiber = await ctx.plugin(host as never, { dbPath: join(dir, 'db.sqlite3') } as never)
  try {
    await new Promise(resolve => setImmediate(resolve))
    const tools = ctx.tools as unknown as { schemas: () => Array<{ name: string, parameters: { type?: string, properties?: Record<string, unknown>, required?: string[] } }> }
    const byName = new Map(tools.schemas().map(s => [s.name, s.parameters]))
    const expected: Record<string, string[]> = { lesson_write: ['text', 'type'], lesson_none: ['reason'], lesson_keep: ['type', 'evidence'], lesson_pin: ['type', 'pinned', 'reason'], lesson_timeline: [], lesson_type_propose: ['name', 'description'], selfcheck_write: ['text'], selfcheck_conclude: ['conclusion'] }
    for (const [name, required] of Object.entries(expected)) {
      const parameters = byName.get(name)
      assert.ok(parameters !== undefined, `${name} reaches the model`)
      assert.equal(parameters.type, 'object', `${name} parameters are an object schema, not a property map`)
      for (const field of required) {
        assert.ok(parameters.properties !== undefined && field in parameters.properties, `${name} declares ${field} as a property`)
        assert.ok(parameters.required?.includes(field), `${name} requires ${field}`)
      }
    }
    // B2b: evidence is a declared, optional property of lesson_write as the model sees it.
    const write = byName.get('lesson_write')!
    assert.ok(write.properties !== undefined && 'evidence' in write.properties, 'lesson_write declares evidence')
    assert.ok(!write.required?.includes('evidence'), 'evidence is optional')
  } finally {
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
    await cleanup()
  }
})

test('lesson_write tells the model what a good lesson is, as the model sees it (owner 2026-11-21, agent-atelier references/lessons.md)', async () => {
  const { ctx, cleanup } = await harness()
  const { createTestDirectory } = await import('./temp-dir.mjs')
  const { join } = await import('node:path')
  const { rmSync } = await import('node:fs')
  const host = await import('../src/index.ts')
  const dir = createTestDirectory('pt-tool-desc-')
  const fiber = await ctx.plugin(host as never, { dbPath: join(dir, 'db.sqlite3') } as never)
  try {
    await new Promise(resolve => setImmediate(resolve))
    const tools = ctx.tools as unknown as { schemas: () => Array<{ name: string, description?: string }> }
    const description = tools.schemas().find(s => s.name === 'lesson_write')?.description ?? ''
    for (const phrase of ['read references/lessons.md', 'really happened', 'says why it hurt', 'what to do first next time',
      'is transferable', 'is short', 'can be checked', 'judgement, not authority', 'not a slogan', 'not filler',
      'by the link where the problem arose, not where it was noticed', 'add it as evidence; it is optional']) {
      assert.ok(description.includes(phrase), `lesson_write description includes "${phrase}"`)
    }
  } finally {
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
    rmSync(dir, { recursive: true, force: true })
    await cleanup()
  }
})
