import { createTestDirectory } from './temp-dir.mjs'
/**
 * #43: on a real DSH host the plugin can apply before the host's `tools` service is active. The model tools
 * (lesson_write, selfcheck_write, selfcheck_conclude) must still register once it is, and a host that never
 * provides tools must keep the rest of the plugin working.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../src/index.ts'

const TOOLS = ['lesson_keep', 'lesson_none', 'lesson_pin', 'lesson_timeline', 'lesson_type_propose', 'lesson_write', 'selfcheck_conclude', 'selfcheck_write']
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

function registry() {
  const names = new Set<string>()
  return { names, service: { register: (tool: { name: string }) => { names.add(tool.name); return () => names.delete(tool.name) } } }
}

test('tools provided after the plugin applied still register all eight model tools', async () => {
  const dir = createTestDirectory('pt-tools-late-')
  const ctx = new Context()
  const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3') })
  try {
    const r = registry()
    await settle()
    assert.deepEqual([...r.names], [], 'nothing can register before the service exists')
    ctx.provide('tools' as never, r.service as never)
    await settle()
    assert.deepEqual([...r.names].sort(), TOOLS)
  } finally { await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('tools provided by a plugin that starts later register too', async () => {
  const dir = createTestDirectory('pt-tools-plugin-')
  const ctx = new Context()
  const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3') })
  const r = registry()
  const toolsFiber = await ctx.plugin({ name: 'fake-tools', apply: (c: Context) => { c.provide('tools' as never, r.service as never) } })
  try {
    await settle()
    assert.deepEqual([...r.names].sort(), TOOLS)
  } finally { await toolsFiber.dispose(); await fiber.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('a host without a tools service keeps the plugin loaded and says so once', async () => {
  const dir = createTestDirectory('pt-tools-none-')
  const ctx = new Context()
  const lines: string[] = []
  const info = console.info
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    const fiber = await ctx.plugin(host, { dbPath: join(dir, 'db.sqlite3') })
    await settle()
    assert.ok(lines.some(l => l.includes('[dsh-prompt-templates] lessons: tools service not provided yet')))
    assert.ok(lines.some(l => l.includes('[dsh-prompt-templates] self-check: tools service not provided yet')))
    await fiber.dispose()
  } finally { console.info = info; rmSync(dir, { recursive: true, force: true }) }
})
