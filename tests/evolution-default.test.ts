import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { copyFileSync, rmSync } from 'node:fs'
import { createTestDirectory } from './temp-dir.mjs'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { TemplateStore } from '../src/store.ts'
import { EVOLUTION_NAME, EVOLUTION_CONTENT, EVOLUTION_SOURCE, EVOLUTION_VERSION } from '../src/evolution-default.ts'
import { databaseSha256, exportDatabase, importDatabase } from '../src/cli/database.ts'
import { parseSnapshot } from '../src/cli/model.ts'

const directories: string[] = []
after(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }) })

function path() {
  const dir = createTestDirectory('evolution-')
  directories.push(dir)
  return join(dir, 'store.sqlite3')
}

test('one default per session, first turn only enrolls; restart preserves changes and deleted tombstone', () => {
  const file = path()
  let s = new TemplateStore(file)
  s.ensureEvolutionDefault('a', 1)
  s.ensureEvolutionDefault('a', 1)
  s.ensureEvolutionDefault('b', 1)
  assert.equal(s.list().length, 2)
  const a = s.list('session', 'a')[0]!
  assert.equal(a.inject_every, 100)
  assert.equal(a.inject_enabled, true)
  assert.equal(s.listScheduled('a', 1, true).length, 0)
  assert.equal(s.listScheduled('a', 100, true).length, 1)
  assert.equal(s.listScheduled('a', 100, false).length, 0)
  s.update(a.id, { content: 'owner edited', name: 'my assessment', inject_enabled: false, inject_every: 200 })
  s.close()
  s = new TemplateStore(file)
  s.ensureEvolutionDefault('a', 200)
  assert.equal(s.get(a.id)?.content, 'owner edited')
  assert.equal(s.get(a.id)?.inject_enabled, false)
  s.delete(a.id)
  s.close()
  s = new TemplateStore(file)
  s.ensureEvolutionDefault('a', 300)
  assert.equal(s.list('session', 'a').length, 0)
  s.close()
})

test('existing same-name disabled global/session templates suppress seeding without mutations', () => {
  for (const scope of ['global', 'session'] as const) {
    const s = new TemplateStore(':memory:')
    const original = s.create({ name: EVOLUTION_NAME, content: 'mine', scope, session_id: scope === 'session' ? 'a' : null })
    s.ensureEvolutionDefault('a', 1)
    assert.deepEqual(s.list(), [original])
    s.delete(original.id)
    s.ensureEvolutionDefault('a', 2)
    assert.equal(s.list().length, 0)
    s.close()
  }
})

test('historical turns never catch up; a later equivalent global suppresses managed duplicate', () => {
  const s = new TemplateStore(':memory:')
  s.ensureEvolutionDefault('a', 200)
  assert.equal(s.listScheduled('a', 200, true).length, 0)
  assert.equal(s.listScheduled('a', 300, true).length, 1)
  s.create({ name: EVOLUTION_NAME, content: 'global owner policy', inject_enabled: true, inject_every: 100 })
  assert.deepEqual(s.listScheduled('a', 300, true).map(t => t.content), ['global owner policy'])
  s.close()
})

test('v5 migration changes no templates; enrollment records source/version and persists across connections', () => {
  const file = path()
  const s = new TemplateStore(file)
  const original = s.create({ name: 'mine', content: 'private', inject_enabled: false })
  s.close()
  const old = new DatabaseSync(file)
  old.exec('ALTER TABLE templates DROP COLUMN system_prompt; DROP TABLE evolution_defaults; DROP TABLE event_master; PRAGMA user_version=5')
  old.close()
  const migrated = new TemplateStore(file)
  assert.deepEqual(migrated.list(), [original])
  migrated.ensureEvolutionDefault('a', 1)
  migrated.close()
  const db = new DatabaseSync(file)
  const row = db.prepare('SELECT * FROM evolution_defaults').get()!
  assert.equal(row.version, EVOLUTION_VERSION)
  assert.equal(row.source, 'agent-atelier/evolution-self-assessment')
  assert.equal(row.disposition, 'created')
  db.close()
})

test('concurrent enrollment serializes via BEGIN IMMEDIATE and session primary key', async () => {
  const file = path()
  new TemplateStore(file).close()
  const source = new URL('../src/store.ts', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(`import { TemplateStore } from ${JSON.stringify(source)}; const s = new TemplateStore(${JSON.stringify(file)}); s.ensureEvolutionDefault('same', 1); s.close();`, { eval: true })
    worker.on('error', reject)
    worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)))
  })))
  const s = new TemplateStore(file)
  assert.equal(s.list().length, 1)
  s.close()
})

test('max interval is respected; template explicitly degrades without installing or granting authority', () => {
  const s = new TemplateStore(':memory:', { injectMaxEvery: 30 })
  s.ensureEvolutionDefault('a', 1)
  assert.equal(s.list().length, 0)
  assert.match(EVOLUTION_CONTENT, /不是强制晋升/)
  assert.match(EVOLUTION_CONTENT, /缺失/)
  assert.match(EVOLUTION_CONTENT, /不自动安装/)
  assert.match(EVOLUTION_CONTENT, /不以提醒代替授权/)
  s.close()
})

test('concurrent first v5 migration rechecks version while holding write lock', async () => {
  const file = path()
  new TemplateStore(file).close()
  const old = new DatabaseSync(file)
  old.exec('ALTER TABLE templates DROP COLUMN system_prompt; DROP TABLE evolution_defaults; DROP TABLE event_master; PRAGMA user_version=5')
  old.close()
  const source = new URL('../src/store.ts', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(`import { TemplateStore } from ${JSON.stringify(source)}; const s = new TemplateStore(${JSON.stringify(file)}); s.ensureEvolutionDefault('same', 1); s.close();`, { eval: true })
    worker.on('error', reject)
    worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)))
  })))
  const s = new TemplateStore(file)
  assert.equal(s.list().length, 1)
  s.close()
})

test('first migration waits through a writer held beyond the normal five-second busy timeout', async () => {
  const file = path()
  new TemplateStore(file).close()
  const existing = new TemplateStore(file)
  const saved = existing.create({ name: 'owner data', content: 'must survive migration' })
  existing.close()
  const old = new DatabaseSync(file)
  old.exec('ALTER TABLE templates DROP COLUMN system_prompt; DROP TABLE evolution_defaults; DROP TABLE event_master; PRAGMA user_version=5')
  old.close()
  // A separate worker owns the write lock. The main thread must remain free
  // while synchronous constructors wait, and all workers settle before cleanup.
  const holder = new Worker(`const { parentPort } = require('node:worker_threads'); const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(${JSON.stringify(file)}); db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
     parentPort.postMessage('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
     db.exec('COMMIT'); db.close();`, { eval: true })
  const holderDone = new Promise<void>((resolve, reject) => {
    holder.on('error', reject)
    holder.on('exit', code => code === 0 ? resolve() : reject(new Error(`holder exit ${code}`)))
  })
  await new Promise<void>((resolve, reject) => { holder.once('message', () => resolve()); holder.once('error', reject) })
  const source = new URL('../src/store.ts', import.meta.url).href
  const openers = Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(`import { TemplateStore } from ${JSON.stringify(source)}; const s = new TemplateStore(${JSON.stringify(file)}); s.ensureEvolutionDefault('same', 1); s.close();`, { eval: true })
    worker.on('error', reject)
    worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)))
  }))
  const results = await Promise.allSettled([holderDone, ...openers])
  for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '')
  const s = new TemplateStore(file)
  assert.equal(s.list().length, 2)
  assert.equal(s.get(saved.id)!.content, 'must survive migration')
  assert.equal(s.list().filter(row => row.name === EVOLUTION_NAME).length, 1)
  const version = s.db.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(version.user_version, 12)
  assert.equal(s.db.prepare('PRAGMA busy_timeout').get()!.timeout, 5000, 'ordinary writes keep their existing five-second budget')
  s.close()
})

test('a writer beyond the initialization budget fails closed without changing the old schema', () => {
  const file = path()
  new TemplateStore(file).close()
  const owner = new DatabaseSync(file)
  owner.exec('ALTER TABLE templates DROP COLUMN system_prompt; DROP TABLE evolution_defaults; DROP TABLE event_master; PRAGMA user_version=5; BEGIN IMMEDIATE')
  const started = performance.now()
  try {
    assert.throws(() => new TemplateStore(file), (error: any) => error.errcode === 5)
    assert.ok(performance.now() - started >= 29_000, 'must use the bounded initialization budget, not the ordinary five seconds')
    assert.equal(owner.prepare('PRAGMA user_version').get()!.user_version, 5)
  } finally { owner.exec('ROLLBACK'); owner.close() }
  const reopened = new TemplateStore(file)
  assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 12)
  reopened.close()
})

test('explicit make-global keeps global scheduling but feature opt-out still suppresses managed row', () => {
  const s = new TemplateStore(':memory:')
  s.ensureEvolutionDefault('a', 200)
  s.makeGlobal(s.list()[0]!.id)
  assert.equal(s.listScheduled('other', 100, true).length, 1)
  assert.equal(s.listScheduled('other', 100, false).length, 0)
  s.close()
})

test('failed migration rolls back and closes the connection instead of leaking a live database', t => {
  const file = path()
  new TemplateStore(file).close()
  // Broken/incomplete old DB: the v7 table is already present while its version is v6.
  const seed = new DatabaseSync(file)
  seed.exec("DROP TABLE evolution_defaults; CREATE TABLE evolution_defaults (session_id TEXT PRIMARY KEY, template_id TEXT, source TEXT NOT NULL, version INTEGER NOT NULL, enrolled_turn INTEGER NOT NULL, disposition TEXT NOT NULL); PRAGMA user_version=6"); seed.close()
  const close = DatabaseSync.prototype.close
  let closed = 0
  DatabaseSync.prototype.close = function () { closed += 1; return close.call(this) }
  try {
    assert.throws(() => new TemplateStore(file), /evolution_defaults.*already exists/)
    assert.equal(closed, 1, 'a failed constructor must release its own database handle')
  } finally { DatabaseSync.prototype.close = close }
  const check = new DatabaseSync(file)
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 6)
    check.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally { check.close() }
})

test('renamed, disabled and deleted defaults stay user-owned across repeated enrollment', () => {
  const store = new TemplateStore(':memory:')
  try {
    store.ensureEvolutionDefault('a', 1)
    const row = store.list()[0]!
    store.update(row.id, { name: 'owner chosen name', content: 'owner text', mode: 'inject', inject_every: 250 })
    store.ensureEvolutionDefault('a', 100)
    assert.equal(store.list().length, 1)
    assert.equal(store.listScheduled('a', 250, true)[0]!.content, 'owner text')
    store.update(row.id, { inject_enabled: false })
    store.ensureEvolutionDefault('a', 300)
    assert.equal(store.listScheduled('a', 500, true).length, 0)
    store.delete(row.id); store.ensureEvolutionDefault('a', 600)
    assert.deepEqual(store.list(), [])
  } finally { store.close() }
})

test('disabled late global blocks duplicate and removing it restores only existing session configuration', () => {
  const store = new TemplateStore(':memory:')
  try {
    store.ensureEvolutionDefault('a', 1)
    const original = store.list()[0]!
    store.update(original.id, { content: 'my content', inject_every: 200, mode: 'inject' })
    const global = store.create({ name: EVOLUTION_NAME, content: 'global disabled', inject_enabled: false })
    assert.deepEqual(store.listScheduled('a', 200, true), [])
    assert.equal(store.get(original.id)!.content, 'my content')
    store.delete(global.id)
    assert.deepEqual(store.listScheduled('a', 400, true).map(t => t.id), [original.id])
    store.update(original.id, { inject_enabled: false })
    const global2 = store.create({ name: EVOLUTION_NAME, content: 'another global', inject_enabled: false })
    store.delete(global2.id)
    assert.deepEqual(store.listScheduled('a', 600, true), [], 'global removal must not re-enable a disabled session row')
  } finally { store.close() }
})

test('enrollment failure rolls template creation back and leaves no tombstone', () => {
  const file = path(); const store = new TemplateStore(file)
  const db = new DatabaseSync(file)
  try {
    db.exec("CREATE TRIGGER reject_enrollment BEFORE INSERT ON evolution_defaults BEGIN SELECT RAISE(ABORT, 'synthetic enrollment fault'); END")
    assert.throws(() => store.ensureEvolutionDefault('a', 1), /synthetic enrollment fault/)
    assert.deepEqual(store.list(), [])
    assert.equal(db.prepare('SELECT count(*) AS n FROM evolution_defaults').get()!.n, 0)
    db.exec('DROP TRIGGER reject_enrollment')
    store.ensureEvolutionDefault('a', 100)
    assert.equal(store.list().length, 1)
    assert.equal(store.listScheduled('a', 100, true).length, 0)
    assert.equal(store.listScheduled('a', 200, true).length, 1)
  } finally { db.close(); store.close() }
})


test('new prompt routes only real Super Agents to role governance; old enrollment content/version stays untouched', () => {
  assert.match(EVOLUTION_CONTENT, /仅当实际身份是 A2A Net Super Agent/)
  assert.match(EVOLUTION_CONTENT, /角色规则变更遵循 propose/)
  assert.match(EVOLUTION_CONTENT, /成员操作另按实际来源和逐操作授权核对/)
  assert.doesNotMatch(EVOLUTION_CONTENT, /规则和成员变更须 propose/)
  const file = path()
  let store = new TemplateStore(file)
  store.ensureEvolutionDefault('old', 1)
  const old = store.list()[0]!
  store.update(old.id, { content: 'older owner-approved content', inject_every: 200 })
  store.close()
  const db = new DatabaseSync(file)
  db.prepare('UPDATE evolution_defaults SET version=1 WHERE session_id=?').run('old')
  db.close()
  store = new TemplateStore(file)
  try {
    store.ensureEvolutionDefault('old', 200); store.ensureEvolutionDefault('new', 200)
    assert.equal(store.get(old.id)?.content, 'older owner-approved content')
    assert.equal(store.get(old.id)?.inject_every, 200)
    const next = store.list('session', 'new')[0]!
    assert.equal(next.content, EVOLUTION_CONTENT)
    const check = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(check.prepare('SELECT version FROM evolution_defaults WHERE session_id=?').get('old')!.version, 1)
      assert.equal(check.prepare('SELECT version FROM evolution_defaults WHERE session_id=?').get('new')!.version, EVOLUTION_VERSION)
    } finally { check.close() }
  } finally { store.close() }
})

test('CLI snapshot may restore explicit template settings but never transports or resets enrollment', async () => {
  const file = path(); let store = new TemplateStore(file)
  store.ensureEvolutionDefault('a', 1)
  const template = store.list()[0]!
  store.close()
  const incoming = parseSnapshot(exportDatabase(file))
  assert.equal(incoming.schema_version, 4)
  assert.equal(incoming.templates[0]!.inject_enabled, true, 'CLI configuration snapshots preserve switches; clipboard imports have a different contract')
  store = new TemplateStore(file)
  store.delete(template.id)
  store.close()
  const enrollmentState = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try { return db.prepare('SELECT * FROM evolution_defaults ORDER BY session_id').all() }
    finally { db.close() }
  }
  const before = enrollmentState(file)
  async function apply(file: string) {
    const preview = await importDatabase(file, incoming, { apply: false, maxChanges: 10 })
    await importDatabase(file, incoming, { apply: true, maxChanges: 10, expectedDbSha256: databaseSha256(file), confirmedSummarySha256: preview.plan.summary_sha256 })
  }
  await apply(file)
  assert.deepEqual(enrollmentState(file), before, 'explicit import changes only template data, not deletion/enrollment state')
  store = new TemplateStore(file)
  try {
    store.ensureEvolutionDefault('a', 300)
    assert.equal(store.list().length, 1, 'manual import may explicitly recreate the template, not another auto-created copy')
    assert.equal(store.get(template.id)?.inject_enabled, true, 'explicit CLI import restores the requested settings')
    assert.equal(store.listScheduled('a', 300, true).length, 1)
    assert.equal(store.listScheduled('a', 300, false).length, 0, 'old enrollment still identifies this restored id as managed')
  } finally { store.close() }
  const target = path(); new TemplateStore(target).close()
  await apply(target)
  assert.deepEqual(enrollmentState(target), [], 'JSON does not transport enrollment')
  const other = new TemplateStore(target)
  try {
    other.ensureEvolutionDefault('a', 300)
    assert.equal(other.list().length, 1)
    assert.equal(other.listScheduled('a', 400, true).length, 1)
    assert.equal(other.listScheduled('a', 400, false).length, 1, 'imported row without provenance is user configuration, not a newly managed default')
    assert.equal(other.get(template.id)?.inject_enabled, true)
    assert.equal(enrollmentState(target)[0]!.disposition, 'existing-template-preserved')
  } finally { other.close() }
})

test('consistent SQLite backup preserves enrollment and deleted defaults across restoration', async () => {
  const file = path(); const store = new TemplateStore(file)
  const snapshot = path(); const restoredFile = path()
  let enrolled: unknown[]
  try {
    store.ensureEvolutionDefault('deleted', 1)
    store.ensureEvolutionDefault('kept', 200)
    store.delete(store.list('session', 'deleted')[0]!.id)
    store.update(store.list('session', 'kept')[0]!.id, { content: 'kept content', inject_enabled: false, inject_every: 250 })
    const source = new DatabaseSync(file, { readOnly: true })
    try {
      enrolled = source.prepare('SELECT * FROM evolution_defaults ORDER BY session_id').all()
      await backup(source, snapshot)
    } finally { source.close() }
  } finally { store.close() }
  // Copy the completed backup into a never-opened target, not a hot db-file copy.
  copyFileSync(snapshot, restoredFile)
  const restored = new TemplateStore(restoredFile)
  try {
    restored.ensureEvolutionDefault('deleted', 400)
    restored.ensureEvolutionDefault('kept', 400)
    assert.deepEqual(restored.list('session', 'deleted'), [])
    assert.equal(restored.list('session', 'kept')[0]!.content, 'kept content')
    assert.deepEqual(restored.listScheduled('kept', 500, true), [])
    const check = new DatabaseSync(restoredFile, { readOnly: true })
    try { assert.deepEqual(check.prepare('SELECT * FROM evolution_defaults ORDER BY session_id').all(), enrolled!) }
    finally { check.close() }
  } finally { restored.close() }
})
