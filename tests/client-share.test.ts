/**
 * Clipboard sharing: payload round-trip, strict parsing, and the import
 * planner (create vs same-name/same-scope overwrite, category gap detection).
 * Pure functions — no DOM, no host routes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSharePayload, parseSharePayload, planShareImport } from '../src/client/share.ts'
import type { CategoryView, TemplateView } from '../src/types.ts'

function row(over: Partial<TemplateView> = {}): TemplateView {
  return {
    id: 'id-1', name: 'n', content: 'c', scope: 'global', session_id: null,
    description: null, position: 1, category: null,
    inject_enabled: false, inject_every: null, mode: 'inject',
    created_at: '2026-11-08', updated_at: '2026-11-08',
    ...over,
  }
}

const CAT: CategoryView = { name: 'work', scope: 'global', session_id: null }

test('payload builds and parses back (single template and category)', () => {
  const single = buildSharePayload([row()])
  const backSingle = parseSharePayload(JSON.stringify(single))
  assert.equal(backSingle.ok, true)
  if (backSingle.ok) {
    assert.equal(backSingle.payload.templates.length, 1)
    assert.deepEqual(backSingle.payload.templates[0], single.templates[0])
    assert.deepEqual(backSingle.payload.categories, [])
  }
  const pack = buildSharePayload([row({ name: 'a' }), row({ name: 'b', category: 'work' })], [CAT])
  const backPack = parseSharePayload(JSON.stringify(pack))
  assert.equal(backPack.ok, true)
  if (backPack.ok) assert.deepEqual(backPack.payload.categories, [CAT])
})

test('parsing rejects anything that is not a v1 templates payload', () => {
  assert.equal(parseSharePayload('{').ok, false)
  assert.equal(parseSharePayload('42').ok, false)
  assert.equal(parseSharePayload(JSON.stringify({ format: 'other', version: 1, kind: 'templates', templates: [row()] })).ok, false)
  assert.equal(parseSharePayload(JSON.stringify({ format: 'dsh-prompt-templates', version: 2, kind: 'templates', templates: [row()] })).ok, false)
  assert.equal(parseSharePayload(JSON.stringify({ format: 'dsh-prompt-templates', version: 1, kind: 'templates', templates: [] })).ok, false)
})

test('plan: no clash creates everything; same name + same scope overwrites', () => {
  const incoming = [row({ name: 'fresh' }), row({ name: 'dupe', content: 'new body' })]
  const existing = [row({ id: 'old', name: 'dupe', content: 'old body' })]
  const plan = planShareImport(buildSharePayload(incoming), existing, [])
  assert.equal(plan.create.length, 1)
  assert.equal(plan.create[0]?.name, 'fresh')
  assert.equal(plan.overwrite.length, 1)
  assert.equal(plan.overwrite[0]?.target.id, 'old')
  assert.equal(plan.overwrite[0]?.incoming.content, 'new body')
})

test('plan: same name in a different scope does not clash', () => {
  const incoming = [row({ name: 'dupe', scope: 'session', session_id: 'sess-x' })]
  const existing = [row({ name: 'dupe', scope: 'global' })]
  const payload = { format: 'dsh-prompt-templates', version: 1, kind: 'templates', templates: incoming, categories: [] } as const
  const plan = planShareImport(payload, existing, [])
  assert.equal(plan.create.length, 1)
  assert.equal(plan.overwrite.length, 0)
})

test('plan: category gap is detected per scope', () => {
  const cat: CategoryView = { name: 'work', scope: 'session', session_id: 'sess-x' }
  const payload = { format: 'dsh-prompt-templates', version: 1, kind: 'templates', templates: [row()], categories: [CAT, cat] } as const
  const plan = planShareImport(payload, [], [CAT])
  assert.deepEqual(plan.missingCategories, [cat])
})
