import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TemplateStore } from '../src/store.ts'
import { databaseSha256, exportDatabase, importDatabase } from '../src/cli/database.ts'
import { createSnapshot } from '../src/cli/model.ts'

/** Template literal with the inject facts defaulted, for compact fixtures. */
function row(over: {
  id: string
  name: string
  content: string
  position: number
  category?: string | null
}): Omit<import('../src/types.ts').TemplateView, 'inject_enabled' | 'inject_every'> & { inject_enabled: boolean, inject_every: number | null } {
  return {
    scope: 'global', session_id: null, description: null,
    inject_enabled: false, inject_every: null,
    created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
    ...over,
  }
}

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
  const incoming = createSnapshot(current.categories, [...current.templates, row({
    id: 'incoming', name: 'new', content: 'new', position: 1, category: 'ops',
  })])
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
  const incoming = createSnapshot(current.categories, [...current.templates, row({
    id: 'incoming', name: 'new', content: 'new', position: 1, category: 'ops',
  })])
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
  const valid = row({ id: 'first', name: 'first', content: 'first', position: 1, category: 'ops' })
  const invalid = row({ id: 'second', name: 'second', content: 'second', position: 2, category: 'ops' })
  // One unbindable field exercises the atomic rollback of a mid-flight batch.
  ;(invalid as Record<string, unknown>)['description'] = {}
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
  const incoming = createSnapshot(current.categories, [...current.templates, row({
    id: 'incoming', name: 'new', content: 'new', position: 1, category: 'ops',
  })])
  const before = databaseSha256(path)
  await assert.rejects(() => importDatabase(path, incoming, { apply: true, maxChanges: 0, expectedDbSha256: before }), /exceeding/)
  assert.equal(databaseSha256(path), before)
})
