import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TemplateStore } from '../src/store.ts'
import { databaseSha256, exportDatabase, importDatabase } from '../src/cli/database.ts'
import { createSnapshot } from '../src/cli/model.ts'

function tempDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pt-cli-')), 'db.sqlite3')
  const store = new TemplateStore(path)
  store.createCategory({ name: 'ops', scope: 'global' })
  store.create({ name: 'base', content: 'old', scope: 'global', category: 'ops' })
  store.close()
  return path
}

test('export is deterministic business data and import defaults to zero-write dry-run', async () => {
  const path = tempDb()
  const beforeHash = databaseSha256(path)
  const current = exportDatabase(path)
  const incoming = createSnapshot(current.categories, [...current.templates, {
    id: 'incoming', name: 'new', content: 'new', scope: 'global', session_id: null,
    description: null, position: 1, category: 'ops', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  }])
  const result = await importDatabase(path, incoming, { apply: false, maxChanges: 10 })
  assert.equal(result.applied, false)
  assert.equal(result.plan.template_inserts, 1)
  assert.equal(databaseSha256(path), beforeHash)
})

test('zero-change apply is idempotent for global categories with null session_id', async () => {
  const path = tempDb()
  const snapshot = exportDatabase(path)
  const beforeHash = databaseSha256(path)
  const dry = await importDatabase(path, snapshot, { apply: false, maxChanges: 10 })
  assert.equal(dry.plan.changes, 0)
  const result = await importDatabase(path, snapshot, {
    apply: true,
    maxChanges: 10,
    expectedDbSha256: beforeHash,
    confirmedSummarySha256: dry.plan.summary_sha256,
  })
  assert.equal(result.applied, true)
  assert.equal(exportDatabase(path).categories.length, 1)
  assert.equal(databaseSha256(path), beforeHash)
})

test('apply requires the expected db hash, creates backup and commits atomically', async () => {
  const path = tempDb()
  const current = exportDatabase(path)
  const incoming = createSnapshot(current.categories, [...current.templates, {
    id: 'incoming', name: 'new', content: 'new', scope: 'global', session_id: null,
    description: null, position: 1, category: 'ops', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  }])
  await assert.rejects(() => importDatabase(path, incoming, { apply: true, maxChanges: 10 }), /expect-db-sha256/)
  await assert.rejects(() => importDatabase(path, incoming, { apply: true, maxChanges: 10, expectedDbSha256: 'bad' }), /confirm-summary-hash/)
  const dry = await importDatabase(path, incoming, { apply: false, maxChanges: 10 })
  await assert.rejects(() => importDatabase(path, incoming, { apply: true, maxChanges: 10, expectedDbSha256: 'bad', confirmedSummarySha256: dry.plan.summary_sha256 }), /sha256 changed/)
  const result = await importDatabase(path, incoming, { apply: true, maxChanges: 10, expectedDbSha256: databaseSha256(path), confirmedSummarySha256: dry.plan.summary_sha256 })
  assert.equal(result.applied, true)
  assert.equal(existsSync(result.backup!), true)
  assert.equal(exportDatabase(path).templates.length, 2)
})

test('a mid-transaction sqlite failure rolls every prior insert back', async () => {
  const path = tempDb()
  const current = exportDatabase(path)
  const valid = {
    id: 'first', name: 'first', content: 'first', scope: 'global' as const, session_id: null,
    description: null, position: 1, category: 'ops', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  }
  const invalid = {
    id: 'second', name: 'second', content: 'second', scope: 'global' as const, session_id: null,
    description: {} as unknown as string, position: 2, category: 'ops', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  }
  const incoming = createSnapshot(current.categories, [...current.templates, valid, invalid])
  const dry = await importDatabase(path, incoming, { apply: false, maxChanges: 10 })
  await assert.rejects(() => importDatabase(path, incoming, {
    apply: true, maxChanges: 10, expectedDbSha256: databaseSha256(path), confirmedSummarySha256: dry.plan.summary_sha256,
  }))
  assert.deepEqual(exportDatabase(path).templates.map(item => item.id), current.templates.map(item => item.id))
})

test('max changes blocks before backup or write', async () => {
  const path = tempDb()
  const current = exportDatabase(path)
  const incoming = createSnapshot(current.categories, [...current.templates, {
    id: 'incoming', name: 'new', content: 'new', scope: 'global', session_id: null,
    description: null, position: 1, category: 'ops', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  }])
  const before = databaseSha256(path)
  await assert.rejects(() => importDatabase(path, incoming, { apply: true, maxChanges: 0, expectedDbSha256: before }), /exceeding/)
  assert.equal(databaseSha256(path), before)
})
