import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { TemplateStore } from '../src/store.ts'
import { EVOLUTION_NAME, EVOLUTION_CONTENT } from '../src/evolution-default.ts'

function path() {
  mkdirSync('tmp/evolution-tests', { recursive: true })
  return join(mkdtempSync('tmp/evolution-tests/db-'), 'store.sqlite3')
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
  old.exec('DROP TABLE evolution_defaults; PRAGMA user_version=5')
  old.close()
  const migrated = new TemplateStore(file)
  assert.deepEqual(migrated.list(), [original])
  migrated.ensureEvolutionDefault('a', 1)
  migrated.close()
  const db = new DatabaseSync(file)
  const row = db.prepare('SELECT * FROM evolution_defaults').get()!
  assert.equal(row.version, 1)
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
  old.exec('DROP TABLE evolution_defaults; PRAGMA user_version=5')
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

test('explicit make-global keeps global scheduling but feature opt-out still suppresses managed row', () => {
  const s = new TemplateStore(':memory:')
  s.ensureEvolutionDefault('a', 200)
  s.makeGlobal(s.list()[0]!.id)
  assert.equal(s.listScheduled('other', 100, true).length, 1)
  assert.equal(s.listScheduled('other', 100, false).length, 0)
  s.close()
})
