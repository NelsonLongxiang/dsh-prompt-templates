import assert from 'node:assert/strict'
import test from 'node:test'
import type { CategoryView, TemplateView } from '../src/types.ts'
import { LESSON_TAB_CATEGORY, filterTemplateRows, searchableTemplateRows } from '../src/client/filter.ts'
import { LESSON_CATEGORY } from '../src/lessons.ts'

function row(id: string, name: string, content: string, scope: 'global' | 'session', sessionId: string | null, category: string | null): TemplateView {
  return { id, name, content, scope, session_id: sessionId, description: null, position: 0, category, inject_enabled: false, inject_every: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }
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

// Owner 2026-11-21 (0.20.0): the session's lessons must show in the 会话模板 tab, not only in their own 体会 tab.
test('the session tab lists this session\'s lessons beside its uncategorised templates; the 体会 tab still shows them', () => {
  const lessonTab: CategoryView = { name: LESSON_CATEGORY, scope: 'session', session_id: 'session-a' }
  const withLessons = [...rows,
    row('s-plain', 'Self-check', 'plain session row', 'session', 'session-a', null),
    row('s-lesson', '体会·找', '下次先拿到完整输出', 'session', 'session-a', LESSON_CATEGORY),
    row('s-lesson-other', '体会·验', 'another session', 'session', 'session-b', LESSON_CATEGORY),
  ]
  assert.equal(LESSON_TAB_CATEGORY, LESSON_CATEGORY)
  assert.deepEqual(filterTemplateRows(withLessons, '', 'session', undefined, 'session-a').map(item => item.id), ['s-plain', 's-lesson'])
  assert.deepEqual(filterTemplateRows(withLessons, '', `cat:session:${LESSON_CATEGORY}`, lessonTab, 'session-a').map(item => item.id), ['s-lesson'])
  // Other user categories stay in their own tab only.
  assert.ok(!filterTemplateRows(withLessons, '', 'session', undefined, 'session-a').some(item => item.id === 's-current'))
})
