import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_INJECT_MAX_EVERY, TemplateRuleError, TemplateStore } from '../src/store.ts'

// Migration tests need ONE database file shared across two connections, so
// they run against real temp files (:memory: is per-connection).
function tempDbPath(): { path: string, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pti-store-'))
  return { path: join(dir, 'test.sqlite3'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('fresh store lands on schema v3 with inject defaults', () => {
  const store = new TemplateStore(':memory:')
  try {
    const view = store.create({ name: 'plain', content: 'body' })
    assert.equal(view.inject_enabled, false)
    assert.equal(view.inject_every, null)
    assert.equal(store.get(view.id)?.inject_enabled, false)
  } finally { store.close() }
})

test('create and update validate the inject pair as a whole', () => {
  const store = new TemplateStore(':memory:')
  try {
    assert.throws(() => store.create({ name: 'zero', content: 'x', inject_enabled: true, inject_every: 0 }), TemplateRuleError)
    assert.throws(() => store.create({ name: 'neg', content: 'x', inject_enabled: true, inject_every: -1 }), TemplateRuleError)
    assert.throws(() => store.create({ name: 'frac', content: 'x', inject_enabled: true, inject_every: 2.5 }), TemplateRuleError)
    assert.throws(() => store.create({ name: 'noval', content: 'x', inject_enabled: true }), TemplateRuleError)
    assert.throws(() => store.create({ name: 'big', content: 'x', inject_enabled: true, inject_every: DEFAULT_INJECT_MAX_EVERY + 1 }), TemplateRuleError)

    const view = store.create({ name: 'ok', content: 'x', inject_enabled: true, inject_every: 5 })
    assert.equal(view.inject_enabled, true)
    assert.equal(view.inject_every, 5)

    // Disabling without an interval patch keeps the stored interval.
    const disabled = store.update(view.id, { inject_enabled: false })
    assert.equal(disabled?.inject_enabled, false)
    assert.equal(disabled?.inject_every, 5)
    // Re-enabling without retyping the interval works again.
    const reenabled = store.update(view.id, { inject_enabled: true })
    assert.equal(reenabled?.inject_enabled, true)
    assert.equal(reenabled?.inject_every, 5)
    // Enabling a never-configured template stays an error.
    const bare = store.create({ name: 'bare', content: 'x' })
    assert.throws(() => store.update(bare.id, { inject_enabled: true }), TemplateRuleError)
    // A patch may retype the interval.
    assert.equal(store.update(view.id, { inject_every: 7 })?.inject_every, 7)
  } finally { store.close() }
})

test('injectMaxEvery option bounds the accepted interval', () => {
  const store = new TemplateStore(':memory:', { injectMaxEvery: 30 })
  try {
    assert.throws(() => store.create({ name: 'over', content: 'x', inject_enabled: true, inject_every: 31 }), TemplateRuleError)
    const view = store.create({ name: 'edge', content: 'x', inject_enabled: true, inject_every: 30 })
    assert.equal(view.inject_every, 30)
  } finally { store.close() }
})

test('listInjectable returns globals plus the session own, in store order', () => {
  const store = new TemplateStore(':memory:')
  try {
    store.create({ name: 'g-off', content: 'x', position: 0 })
    store.create({ name: 'g-on', content: 'x', inject_enabled: true, inject_every: 5, position: 1 })
    store.create({ name: 's-a', content: 'x', scope: 'session', session_id: 'sess-a', inject_enabled: true, inject_every: 3, position: 2 })
    store.create({ name: 's-b', content: 'x', scope: 'session', session_id: 'sess-b', inject_enabled: true, inject_every: 3, position: 3 })
    assert.deepEqual(store.listInjectable('sess-a').map(item => item.name), ['g-on', 's-a'])
    assert.deepEqual(store.listInjectable('sess-b').map(item => item.name), ['g-on', 's-b'])
    assert.deepEqual(store.listInjectable('sess-c').map(item => item.name), ['g-on'])
  } finally { store.close() }
})

test('makeGlobal carries the inject configuration', () => {
  const store = new TemplateStore(':memory:')
  try {
    const made = store.create({ name: 'private', content: 'x', scope: 'session', session_id: 'sess-a', inject_enabled: true, inject_every: 4 })
    const promoted = store.makeGlobal(made.id)
    assert.equal(promoted?.scope, 'global')
    assert.equal(promoted?.session_id, null)
    assert.equal(promoted?.inject_enabled, true)
    assert.equal(promoted?.inject_every, 4)
  } finally { store.close() }
})

const V2_SCHEMA = `CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE categories (
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (scope, session_id, name)
)`

/** Seed a legacy database file and close it, leaving the file on disk. */
function prepareLegacyDb(path: string, version: number, schema: 'v1' | 'v2'): void {
  const db = new DatabaseSync(path)
  try {
    if (schema === 'v2') {
      db.exec(V2_SCHEMA)
    } else {
      // v1 predated the category column and the categories table entirely.
      db.exec(V2_SCHEMA.replaceAll('  category TEXT,\n', '').replaceAll(`;
CREATE TABLE categories (
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (scope, session_id, name)
)`, ''))
    }
    db.prepare(`INSERT INTO templates (id, name, content, scope, session_id, description, position${schema === 'v2' ? ', category' : ''}, created_at, updated_at)
      VALUES ('legacy1', 'legacy', 'old body', 'global', NULL, NULL, 0${schema === 'v2' ? ', NULL' : ''}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`).run()
    db.exec(`PRAGMA user_version=${version}`)
  } finally { db.close() }
}

test('v2 databases migrate to v3 in place, defaults off', () => {
  const { path, cleanup } = tempDbPath()
  prepareLegacyDb(path, 2, 'v2')
  const store = new TemplateStore(path)
  try {
    const rows = store.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.name, 'legacy')
    assert.equal(rows[0]?.inject_enabled, false)
    assert.equal(rows[0]?.inject_every, null)
    // The migrated columns are writable through the normal surface.
    const updated = store.update('legacy1', { inject_enabled: true, inject_every: 6 })
    assert.equal(updated?.inject_every, 6)
  } finally {
    store.close()
    cleanup()
  }
})

test('v1 databases migrate through v2 to v3', () => {
  const { path, cleanup } = tempDbPath()
  prepareLegacyDb(path, 1, 'v1')
  const store = new TemplateStore(path)
  try {
    const rows = store.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.category, null)
    assert.equal(rows[0]?.inject_enabled, false)
  } finally {
    store.close()
    cleanup()
  }
})

test('unknown future schema versions refuse to open', () => {
  const { path, cleanup } = tempDbPath()
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=4')
  db.close()
  assert.throws(() => new TemplateStore(path), /schema version 4/)
  cleanup()
})
