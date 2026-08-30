import assert from 'node:assert/strict'
import test from 'node:test'
import type { TemplateView } from '../src/types.ts'
import { createSnapshot, diffSnapshots, mergeSnapshots, parseSnapshot } from '../src/cli/model.ts'

function row(id: string, name: string, updated_at: string, content = `content-${id}`): TemplateView {
  return { id, name, content, scope: 'global', session_id: null, description: null, position: 0, category: null, inject_enabled: false, inject_every: null, created_at: '2026-01-01 00:00:00', updated_at }
}

test('canonical snapshot round trips and rejects unknown fields', () => {
  const snapshot = createSnapshot([{ name: 'z', scope: 'global', session_id: null }], [row('b', 'B', '2026-01-02 00:00:00'), row('a', 'A', '2026-01-01 00:00:00')])
  assert.deepEqual(snapshot.templates.map(item => item.id), ['a', 'b'])
  assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot)
  assert.throws(() => parseSnapshot({ ...snapshot, extra: true }), /unknown fields/)
  assert.throws(() => parseSnapshot({ ...snapshot, data_sha256: 'bad' }), /data_sha256 mismatch/)
})

test('schema-2 snapshots import with inject facts defaulted off', () => {
  const expected = createSnapshot([], [row('1', 'A', '2026-01-01 00:00:00')])
  // A v2 record carries no inject keys at all (exact key set of the old schema).
  const { inject_enabled: _enabled, inject_every: _every, ...v2Template } = row('1', 'A', '2026-01-01 00:00:00')
  const v2 = {
    schema_version: 2,
    categories: [],
    templates: [v2Template],
    data_sha256: expected.data_sha256,
  }
  const parsed = parseSnapshot(v2)
  assert.equal(parsed.schema_version, 3)
  assert.equal(parsed.templates[0]?.inject_enabled, false)
  assert.equal(parsed.templates[0]?.inject_every, null)
  // v2 records reject v3-only keys loudly instead of silently absorbing them.
  assert.throws(() => parseSnapshot({ ...v2, templates: [row('1', 'A', '2026-01-01 00:00:00')] }), /unknown fields/)
  // Out-of-range intervals are rejected at the interchange bound.
  const over = createSnapshot([], [{ ...row('1', 'A', '2026-01-01 00:00:00'), inject_every: 1001 }])
  assert.throws(() => parseSnapshot({ ...over, schema_version: 3 }), /at most 1000/)
})

test('diff and merge treat inject facts as ordinary compared fields', () => {
  const left = createSnapshot([], [row('1', 'A', '2026-01-01 00:00:00')])
  const right = createSnapshot([], [{ ...row('1', 'A', '2026-01-02 00:00:00'), inject_enabled: true, inject_every: 5 }])
  const diff = diffSnapshots(left, right)
  assert.equal(diff.identical, false)
  assert.deepEqual(diff.templates.changed[0]?.fields.sort(), ['inject_enabled', 'inject_every', 'updated_at'])
  const merged = mergeSnapshots(left, right, 'newer')
  assert.equal(merged.conflicts.length, 0)
  assert.equal(merged.snapshot?.templates.find(item => item.id === '1')?.inject_enabled, true)
  assert.equal(merged.snapshot?.templates.find(item => item.id === '1')?.inject_every, 5)
})

test('diff finds ids, fields, names and category compound keys', () => {
  const left = createSnapshot([{ name: 'a', scope: 'global', session_id: null }], [row('1', 'same-name', '2026-01-01 00:00:00'), row('2', 'changed', '2026-01-01 00:00:00')])
  const right = createSnapshot([{ name: 'b', scope: 'global', session_id: null }], [row('3', 'same-name', '2026-01-02 00:00:00'), row('2', 'changed', '2026-01-02 00:00:00', 'new')])
  const diff = diffSnapshots(left, right)
  assert.equal(diff.identical, false)
  assert.deepEqual(diff.templates.only_left.map(item => item.id), ['1'])
  assert.deepEqual(diff.templates.only_right.map(item => item.id), ['3'])
  assert.deepEqual(diff.templates.changed[0]?.fields.sort(), ['content', 'updated_at'])
  assert.equal(diff.templates.name_conflicts.length, 1)
  assert.equal(diff.categories.only_left.length, 1)
  assert.equal(diff.categories.only_right.length, 1)
})

test('newer merge chooses strict newer, unions ids and blocks equal-time conflicts', () => {
  const base = createSnapshot([], [row('1', 'one', '2026-01-01 00:00:00'), row('2', 'two', '2026-01-03 00:00:00')])
  const incoming = createSnapshot([], [row('1', 'one', '2026-01-02 00:00:00', 'newer'), row('3', 'three', '2026-01-01 00:00:00')])
  const merged = mergeSnapshots(base, incoming, 'newer')
  assert.equal(merged.conflicts.length, 0)
  assert.equal(merged.snapshot?.templates.length, 3)
  assert.equal(merged.snapshot?.templates.find(item => item.id === '1')?.content, 'newer')

  const conflict = mergeSnapshots(base, createSnapshot([], [row('1', 'one', '2026-01-01 00:00:00', 'different')]), 'newer')
  assert.equal(conflict.snapshot, undefined)
  assert.equal(conflict.conflicts[0]?.kind, 'same-time-different-content')
})

test('merge blocks cross-input name/id disagreement but permits shared historical duplicates', () => {
  const base = createSnapshot([], [row('1', 'dup', '2026-01-01 00:00:00')])
  const incoming = createSnapshot([], [row('2', 'dup', '2026-01-02 00:00:00')])
  assert.equal(mergeSnapshots(base, incoming, 'newer').snapshot, undefined)
  assert.equal(mergeSnapshots(base, incoming, 'newer', true).snapshot?.templates.length, 2)

  const shared = createSnapshot([], [row('1', 'dup', '2026-01-01 00:00:00'), row('2', 'dup', '2026-01-02 00:00:00')])
  assert.equal(mergeSnapshots(shared, shared, 'newer').snapshot?.templates.length, 2)
})
