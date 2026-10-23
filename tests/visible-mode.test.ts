/**
 * Visible-mode scheduled injection (v4 schema): mode column persistence,
 * migration from v3, delivery-mode validation, the dual-shape dedup scan,
 * and the user-channel render.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TemplateRuleError, TemplateStore } from '../src/store.ts'
import { alreadyInjectedAtTurn, dueTemplates, renderInjectionMessage, renderVisibleInjectionMessage } from '../src/inject.ts'
import type { TemplateView } from '../src/types.ts'

function template(over: Partial<TemplateView> = {}): TemplateView {
  return {
    id: 't1',
    name: '推动',
    content: 'keep moving',
    scope: 'global',
    session_id: null,
    description: null,
    position: 0,
    category: null,
    inject_enabled: true,
    inject_every: 5,
    mode: 'inject',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...over,
  }
}

test('mode column: defaults to inject, persists visible, rejects unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-mode-'))
  const db = join(dir, 'm.sqlite3').replaceAll('\\', '/')
  let store: TemplateStore | undefined
  try {
    store = new TemplateStore(db)
    const created = store.create({ name: 'a', content: 'x', scope: 'global' })
    assert.equal(created.mode, 'inject')

    const visible = store.create({ name: 'b', content: 'y', scope: 'global', inject_enabled: true, inject_every: 3, mode: 'visible' })
    assert.equal(visible.mode, 'visible')

    assert.equal(store.get(created.id)?.mode, 'inject')
    const patched = store.update(created.id, { mode: 'visible' })
    assert.equal(patched?.mode, 'visible')
    // Reopening keeps the stored mode (round-trip through SQLite).
    store.close()
    store = new TemplateStore(db)
    assert.equal(store.get(created.id)?.mode, 'visible')
    assert.equal(store.get(visible.id)?.mode, 'visible')
    assert.throws(() => store.create({ name: 'c', content: 'z', scope: 'global', mode: 'loud' as never }), TemplateRuleError)
  } finally {
    try { store?.close() } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(db + suffix, { force: true }) } catch { /* EPERM races on Windows temp */ }
    }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('v3 database migrates to v4 in place, mode defaults inject', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-mig-'))
  const db = join(dir, 'v3.sqlite3').replaceAll('\\', '/')
  let store: TemplateStore | undefined
  try {
    const legacy = new DatabaseSync(db)
    legacy.exec(`PRAGMA user_version=3;
      CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, scope TEXT NOT NULL,
        session_id TEXT, description TEXT, position INTEGER NOT NULL DEFAULT 0, category TEXT,
        inject_enabled INTEGER NOT NULL DEFAULT 0, inject_every INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE categories (name TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT, PRIMARY KEY (scope, session_id, name));
      INSERT INTO templates (id,name,content,scope,session_id,description,position,category,inject_enabled,inject_every,created_at,updated_at)
        VALUES ('old','n','c','global',NULL,NULL,0,NULL,1,5,'2026-01-01 00:00:00','2026-01-01 00:00:00')`)
    legacy.close()

    store = new TemplateStore(db)
    const migrated = store.get('old')
    assert.equal(migrated?.mode, 'inject')
    store.close()
    store = undefined
    const probe = new DatabaseSync(db)
    const version = (probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    probe.close()
    assert.equal(version, 4)
  } finally {
    // Windows: a WAL-mode sqlite keeps -shm/-wal siblings; close before remove.
    try { store?.close() } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(db + suffix, { force: true }) } catch { /* EPERM races on Windows temp */ }
    }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('dueTemplates carries the delivery mode', () => {
  const rows = [
    template({ id: 'a', inject_every: 5, mode: 'inject' }),
    template({ id: 'b', inject_every: 5, mode: 'visible' }),
  ]
  const due = dueTemplates(rows, 10)
  assert.deepEqual(due.map(item => [item.id, item.mode]), [['a', 'inject'], ['b', 'visible']])
})

test('dedup scan matches BOTH the silent and the visible source shapes', () => {
  const silentEvent = (turn: number) => ({ type: 'user/message', data: { source: { kind: 'prompt-template-schedule', turn } } })
  const visibleEvent = (turn: number) => ({ type: 'user/message', data: { source: { kind: 'user', scheduled: 'prompt-template', turn } } })
  const plainUser = (turn: number) => ({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, turn } })
  assert.equal(alreadyInjectedAtTurn([silentEvent(5)], 0, 5), true)
  assert.equal(alreadyInjectedAtTurn([visibleEvent(5)], 0, 5), true)
  // A plain human user message at the same turn is NOT a scheduled injection.
  assert.equal(alreadyInjectedAtTurn([plainUser(5)], 0, 5), false)
  assert.equal(alreadyInjectedAtTurn([visibleEvent(4)], 0, 5), false)
})

test('renderVisibleInjectionMessage stamps the user channel with the schedule marker', () => {
  const message = renderVisibleInjectionMessage(10, [
    { id: 'a', name: '推动', content: 'keep moving', every: 5, mode: 'visible' },
  ])
  const source = message.source as { kind: string, scheduled?: string, turn: number }
  assert.equal(source.kind, 'user')
  assert.equal(source.scheduled, 'prompt-template')
  assert.equal(source.turn, 10)
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  assert.match(text, /⚙️ 定时注入 · 第 10 轮/)
  assert.ok(text.includes('keep moving'))
  // No reminder frame: this message is written for both the model and the human.
  assert.doesNotMatch(text, /<system-reminder>/)
  // The silent renderer keeps its invisible framing untouched.
  const silent = renderInjectionMessage(10, [
    { id: 'a', name: '推动', content: 'keep moving', every: 5, mode: 'inject' },
  ])
  assert.match(silent.content[0].type === 'text' ? silent.content[0].text : '', /^<system-reminder>/)
  assert.equal((silent.source as { kind: string }).kind, 'prompt-template-schedule')
})
