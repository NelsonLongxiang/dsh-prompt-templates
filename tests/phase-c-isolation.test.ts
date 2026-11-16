/** Phase C isolation: real SQLite files + synthetic tool/log fixtures, not a live DSH/model verdict. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createTestDirectory } from './temp-dir.mjs'
import { databaseSha256, exportDatabase, importDatabase } from '../src/cli/database.ts'
import { DEFAULT_EVENT_INJECT_CONFIG, observeToolResult, prepareEventReminders } from '../src/event-inject.ts'
import type { InjectionEventProbe } from '../src/inject.ts'
import { TemplateStore } from '../src/store.ts'

const SESSION = 'same-session-id'
const ON = { ...DEFAULT_EVENT_INJECT_CONFIG, enabled: true }
const memo = () => ({ scanned: 0, keys: new Set<string>() })

function call(store: TemplateStore, id: string): void {
  observeToolResult(store.events, ON, {
    callId: id, name: 'bash', arguments: { command: 'synthetic failing task' },
    agent: { session: { header: { id: SESSION } } },
  }, { isError: true, error: { info: { code: 'FIXTURE' } } })
}

function step(store: TemplateStore, turn: number, log: InjectionEventProbe[] = [], number = 1) {
  return prepareEventReminders(store.events, ON, SESSION, turn, number, () => log, memo())
}

function state(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Object.fromEntries(['event_policies', 'event_observations', 'event_episodes', 'event_outbox'].map(table =>
      [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
  } finally { db.close() }
}

async function applySnapshot(path: string, snapshot: ReturnType<typeof exportDatabase>): Promise<void> {
  const dry = await importDatabase(path, snapshot, { apply: false, maxChanges: 100 })
  await importDatabase(path, snapshot, {
    apply: true, maxChanges: 100, expectedDbSha256: databaseSha256(path),
    confirmedSummarySha256: dry.plan.summary_sha256,
  })
}

test('template import changes templates only: it neither prunes extras nor restores any event table', async t => {
  const dir = createTestDirectory('phase-c-import-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite3')
  let store = new TemplateStore(path)
  try {
    const template = store.create({ name: 'baseline', content: 'before' })
    store.close()
    const snapshot = exportDatabase(path)
    const original = state(path)
    store = new TemplateStore(path)
    store.update(template.id, { content: 'after' })
    store.create({ name: 'extra', content: 'must not be pruned' })
    store.events.updatePolicy('repeated-failure', { enabled: true, cooldown_turns: 9 })
    call(store, 'one'); call(store, 'two')
    assert.equal(step(store, 1).length, 1)
    store.close()
    const mutated = state(path)
    for (const table of Object.keys(original)) assert.notDeepEqual(mutated[table], original[table], table)
    await applySnapshot(path, snapshot)
    assert.deepEqual(state(path), mutated, 'all four event tables survive template import unchanged')
    store = new TemplateStore(path)
    assert.equal(store.get(template.id)?.content, 'before')
    assert.ok(store.list().some(row => row.name === 'extra'), 'import is upsert, not rollback')
  } finally { try { store.close() } catch { /* already closed */ } }
})

test('independent experiment units isolate global policies and all session state even with identical session ids', async t => {
  const dir = createTestDirectory('phase-c-units-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const firstPath = join(dir, 'unit-a.sqlite3')
  const secondPath = join(dir, 'unit-b.sqlite3')
  const seedPath = join(dir, 'seed.sqlite3')
  const seed = new TemplateStore(seedPath)
  seed.create({ name: 'same input', content: 'synthetic data' })
  seed.close()
  const snapshot = exportDatabase(seedPath)
  for (const path of [firstPath, secondPath]) {
    const empty = new TemplateStore(path)
    empty.close()
    await applySnapshot(path, snapshot)
  }
  const secondBaseline = state(secondPath)
  const first = new TemplateStore(firstPath)
  const second = new TemplateStore(secondPath)
  try {
    first.events.updatePolicy('repeated-failure', { enabled: true, threshold: 2, cooldown_turns: 8 })
    call(first, 'one'); call(first, 'two')
    assert.equal(step(first, 1).length, 1)
    assert.equal(second.events.policies().every(rule => !rule.enabled), true)
    assert.deepEqual(second.events.window(SESSION, 50), [])
    assert.deepEqual(second.events.episodes(SESSION), [])
    assert.deepEqual(second.events.outbox(SESSION), [])
    assert.deepEqual(state(secondPath), secondBaseline, 'unit A cannot mutate unit B')
    assert.equal(exportDatabase(firstPath).data_sha256, exportDatabase(secondPath).data_sha256)
    second.events.updatePolicy('repeated-failure', { enabled: true, threshold: 2 })
    call(second, 'one')
    assert.equal(step(second, 1).length, 0, 'unit B does not borrow the prior failure from A')
    call(second, 'two')
    assert.equal(step(second, 1).length, 1)
    assert.equal(first.events.policy('repeated-failure')?.cooldown_turns, 8)
  } finally { first.close(); second.close() }
})

test('M04/M05 linked restart stages retain their original database and durable-log identity', t => {
  const dir = createTestDirectory('phase-c-restart-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite3')
  let store = new TemplateStore(path)
  const log: InjectionEventProbe[] = []
  try {
    store.events.updatePolicy('repeated-failure', { enabled: true })
    call(store, 'one'); call(store, 'two')
    const id = store.events.episodes(SESSION)[0]?.episode_id
    assert.ok(id)
    store.close() // M05: detected, not yet prepared.
    store = new TemplateStore(path)
    assert.equal(store.events.episodes(SESSION)[0]?.episode_id, id)
    const first = step(store, 1)
    assert.equal(first.length, 1)
    const key = store.events.outbox(SESSION)[0]?.dedup_key
    store.close() // M05: prepared, never committed to the durable log.
    store = new TemplateStore(path)
    const retry = step(store, 2)
    assert.equal(retry.length, 1)
    assert.equal(store.events.outbox(SESSION)[0]?.dedup_key, key)
    assert.equal(store.events.outbox(SESSION)[0]?.attempts, 2)
    for (const message of retry) log.push({ type: 'user/message', data: { source: message.source } })
    store.close() // M05: logged, not yet reconciled.
    store = new TemplateStore(path)
    assert.deepEqual(step(store, 2, log, 2), [])
    assert.equal(store.events.outbox(SESSION)[0]?.state, 'persisted')
    call(store, 'three') // M04: fresh evidence, same episode, cooldown holds.
    assert.deepEqual(step(store, 3, log), [])
    assert.equal(step(store, 4, log).length, 1)
    assert.equal(store.events.episodes(SESSION)[0]?.episode_id, id)
    assert.notEqual(store.events.outbox(SESSION)[1]?.dedup_key, key)
    assert.equal(store.events.episodes(SESSION)[0]?.notify_count, 2)
  } finally { store.close() }
})

test('M05 survives separate process exits before prepare, before logging, and before reconciliation', t => {
  const dir = createTestDirectory('phase-c-process-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = join(dir, 'db.sqlite3')
  const log = join(dir, 'events.json')
  const worker = fileURLToPath(new URL('./phase-c-worker.mjs', import.meta.url))
  const run = (stage: string) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', worker, stage, db, log], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as { messages: number; episodes: Array<{ episode_id: string }>; outbox: Array<{ dedup_key: string; attempts: number; state: string }> }
  }
  const seeded = run('seed')
  assert.equal(seeded.episodes.length, 1)
  assert.equal(seeded.outbox.length, 0)
  const prepared = run('prepare')
  assert.equal(prepared.messages, 1)
  assert.equal(prepared.episodes[0]?.episode_id, seeded.episodes[0]?.episode_id)
  assert.equal(prepared.outbox[0]?.state, 'prepared')
  assert.equal(existsSync(log), false, 'first process never logged the reminder')
  const logged = run('log')
  assert.equal(logged.messages, 1)
  assert.equal(logged.outbox[0]?.dedup_key, prepared.outbox[0]?.dedup_key)
  assert.equal(logged.outbox[0]?.attempts, 2)
  assert.equal(existsSync(log), true)
  const reconciled = run('reconcile')
  assert.equal(reconciled.messages, 0)
  assert.equal(reconciled.outbox[0]?.state, 'persisted')
  assert.equal(reconciled.outbox[0]?.attempts, 2)
})

test('SQLite backup includes live WAL state; restoration into a fresh stopped target preserves all tables', async t => {
  const dir = createTestDirectory('phase-c-backup-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'live.sqlite3')
  const backupPath = join(dir, 'consistent.sqlite3')
  const restoredPath = join(dir, 'restored.sqlite3')
  const store = new TemplateStore(path)
  try {
    store.create({ name: 'WAL-only synthetic template', content: 'safe fixture' })
    store.events.updatePolicy('repeated-failure', { enabled: true })
    call(store, 'one'); call(store, 'two')
    assert.equal(step(store, 1).length, 1)
    assert.ok(existsSync(path + '-wal'))
    assert.ok(statSync(path + '-wal').size > 0)
    const expected = state(path)
    const source = new DatabaseSync(path, { readOnly: true })
    try { await backup(source, backupPath) } finally { source.close() }
    // This is a copy of a completed backup, not a hot copy of the original db.
    copyFileSync(backupPath, restoredPath)
    assert.deepEqual(state(restoredPath), expected)
    assert.equal(exportDatabase(restoredPath).data_sha256, exportDatabase(path).data_sha256)
    const restored = new TemplateStore(restoredPath)
    try {
      assert.equal(restored.events.episodes(SESSION)[0]?.state, 'notified')
      assert.equal(restored.events.outbox(SESSION)[0]?.state, 'prepared')
    } finally { restored.close() }
  } finally { store.close() }
})
