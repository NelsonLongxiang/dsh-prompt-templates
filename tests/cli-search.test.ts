import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TemplateStore } from '../src/store.ts'
import { searchTemplates } from '../src/cli/database.ts'

function tempDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pt-search-')), 'db.sqlite3')
  const store = new TemplateStore(path)
  store.createCategory({ name: 'ops', scope: 'global' })
  store.create({ name: '发布和更新', content: 'use tea registry publish', scope: 'global', category: 'ops' })
  store.create({ name: '边界纪律', content: '禁止修改 profile', scope: 'global' })
  store.create({ name: '私有备注', content: 'publish now private', scope: 'session', session_id: 'sess-a' })
  store.create({ name: '他人私有', content: 'publish other secret', scope: 'session', session_id: 'sess-b' })
  store.close()
  return path
}

test('search matches name and content case-insensitively across globals', () => {
  const path = tempDb()
  const byName = searchTemplates(path, { query: 'PUBLISH', limit: 10 })
  assert.equal(byName.total, 1)
  assert.equal(byName.items[0]?.name, '发布和更新')
  const byContent = searchTemplates(path, { query: 'TEA REGISTRY', limit: 10 })
  assert.equal(byContent.items[0]?.name, '发布和更新')
})

test('session-private rows appear only for the named session', () => {
  const path = tempDb()
  assert.deepEqual(searchTemplates(path, { query: 'private', limit: 10 }).items.map(x => x.name), [])
  const withSession = searchTemplates(path, { query: 'private', limit: 10, sessionId: 'sess-a' })
  assert.deepEqual(withSession.items.map(x => x.name), ['私有备注'])
  assert.equal(searchTemplates(path, { query: 'secret', limit: 10, sessionId: 'sess-a' }).total, 0)
})

test('category filter narrows and limit truncates with total preserved', () => {
  const path = tempDb()
  const ops = searchTemplates(path, { category: 'ops', limit: 10 })
  assert.equal(ops.total, 1)
  const limited = searchTemplates(path, { query: '', limit: 1 })
  assert.equal(limited.items.length, 1)
  assert.equal(limited.total, 2)
  assert.equal(limited.limit, 1)
})

test('empty query lists every searchable row sorted by name', () => {
  const path = tempDb()
  const result = searchTemplates(path, { limit: 10, sessionId: 'sess-a' })
  // zh-CN collation: 边界(bian) < 发布(fa) < 私有(si)
  assert.deepEqual(result.items.map(x => x.name), ['边界纪律', '发布和更新', '私有备注'])
  assert.deepEqual(result.matched_scopes, ['global', 'session'])
})
