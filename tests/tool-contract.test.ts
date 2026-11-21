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
