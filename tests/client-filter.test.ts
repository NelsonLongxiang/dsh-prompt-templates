import assert from 'node:assert/strict'
import test from 'node:test'
import type { CategoryView, TemplateView } from '../src/types.ts'
import { filterTemplateRows, searchableTemplateRows } from '../src/client/filter.ts'

function row(id: string, name: string, content: string, scope: 'global' | 'session', sessionId: string | null, category: string | null): TemplateView {
  return { id, name, content, scope, session_id: sessionId, description: null, position: 0, category, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }
}

const active: CategoryView = { name: 'active', scope: 'global', session_id: null }
const rows = [
  row('g-default', 'Default', 'plain', 'global', null, null),
  row('g-active', 'Active', 'in active category', 'global', null, 'active'),
  row('g-other', 'Needle Global', 'outside active tab', 'global', null, 'other'),
  row('s-current', 'Current private', 'Needle in current session', 'session', 'session-a', 'private'),
  row('s-other', 'Other private', 'Needle in other session', 'session', 'session-b', 'private'),
]

test('an empty query keeps the active category partition', () => {
  assert.deepEqual(filterTemplateRows(rows, '', 'cat:global:active', active, 'session-a').map(item => item.id), ['g-active'])
})

test('a query searches every global category and the current session only', () => {
  assert.deepEqual(
    filterTemplateRows(rows, 'needle', 'cat:global:active', active, 'session-a').map(item => item.id),
    ['g-other', 's-current'],
  )
})

test('global search is case-insensitive across names and content', () => {
  assert.deepEqual(filterTemplateRows(rows, 'OUTSIDE ACTIVE', 'global', undefined, 'session-a').map(item => item.id), ['g-other'])
  assert.deepEqual(filterTemplateRows(rows, 'current PRIVATE', 'global', undefined, 'session-a').map(item => item.id), ['s-current'])
})

test('global search never leaks another session private template', () => {
  assert.deepEqual(filterTemplateRows(rows, 'other private', 'session', undefined, 'session-a'), [])
})

test('searchable count includes all globals and current-session private rows only', () => {
  assert.deepEqual(searchableTemplateRows(rows, 'session-a').map(item => item.id), ['g-default', 'g-active', 'g-other', 's-current'])
  assert.equal(searchableTemplateRows(rows, null).length, 3)
})
