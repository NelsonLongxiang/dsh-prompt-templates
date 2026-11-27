import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createLibrarySelection, resolveLibraryTab } from '../src/client/library-state.ts'
import type { CategoryView } from '../src/types.ts'

// Browser storage double: no filesystem or global user data is touched.
function storage(t: TestContext) {
  const values = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return values
}

test('both surfaces subscribe to one selection; session partitions and unsubscribe remain independent', t => {
  storage(t)
  const selection = createLibrarySelection()
  let panel = 0; let sidebar = 0
  const off = selection.subscribe(() => { panel++ })
  selection.subscribe(() => { sidebar++ })
  assert.equal(selection.tab('a'), 'global')
  selection.select('a', 'cat:global:工作')
  assert.equal(selection.tab('a'), 'cat:global:工作')
  assert.equal(selection.tab('b'), 'global')
  assert.equal(panel, 1); assert.equal(sidebar, 1)
  selection.select('b', 'session')
  assert.equal(selection.tab('a'), 'cat:global:工作')
  assert.equal(selection.tab('b'), 'session')
  off()
  selection.select('a', 'global')
  assert.equal(panel, 2); assert.equal(sidebar, 3)
})

test('unmount/reopen and a new plugin instance restore browser-persisted selection', t => {
  const values = storage(t)
  const first = createLibrarySelection()
  const off = first.subscribe(() => {})
  first.select('a', 'cat:session:体会')
  off()
  assert.equal(first.tab('a'), 'cat:session:体会')
  assert.equal(createLibrarySelection().tab('a'), 'cat:session:体会')
  assert.deepEqual([...values.keys()], ['prompt-templates.library'])
})

test('recent visits refresh LRU and keep at most 100 distinct sessions, including after hydration', t => {
  const values = storage(t)
  const selection = createLibrarySelection()
  for (let i = 0; i < 100; i++) selection.select(String(i), 'session')
  selection.select('0', selection.tab('0')) // revisit without changing its tab
  selection.select('100', 'session')
  assert.equal(selection.tab('0'), 'session')
  assert.equal(selection.tab('1'), 'global')
  assert.equal(selection.tab('100'), 'session')
  const saved = JSON.parse(values.get('prompt-templates.library')!)
  assert.equal(saved.recent.length, 100)
  assert.equal(createLibrarySelection().tab('0'), 'session')
})

test('invalid persisted values, null session and malformed tab names cannot break the view', t => {
  const values = storage(t)
  for (const bad of [null, [], {}, { recent: null }, { recent: [null, 3, { sessionId: 'a', tab: 42 }] }]) {
    values.set('prompt-templates.library', JSON.stringify(bad))
    const selection = createLibrarySelection()
    assert.equal(selection.tab('a'), 'global')
    selection.select(null, 'session')
    selection.select('a', 'invalid')
    assert.equal(selection.tab(null), 'global')
    assert.equal(selection.tab('a'), 'global')
  }
})

test('deleted and foreign categories fall back; only matching session categories restore', () => {
  const cats = [{ name: '私有', scope: 'session', session_id: 'a' }, { name: '共享', scope: 'global', session_id: null }] as CategoryView[]
  assert.equal(resolveLibraryTab('cat:session:私有', cats, 'a'), 'cat:session:私有')
  assert.equal(resolveLibraryTab('cat:session:私有', cats, 'b'), 'global')
  assert.equal(resolveLibraryTab('cat:global:删除', cats, 'a'), 'global')
  assert.equal(resolveLibraryTab('cat:global:共享', cats, 'b'), 'cat:global:共享')
  assert.equal(resolveLibraryTab('session', cats, null), 'global')
})
