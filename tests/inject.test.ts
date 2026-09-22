import assert from 'node:assert/strict'
import test from 'node:test'
import type { TemplateView } from '../src/types.ts'
import { alreadyInjectedAtTurn, dueTemplates, isBoundaryTurn, renderInjectionMessage } from '../src/inject.ts'

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
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...over,
  }
}

test('boundary predicate: positive integer turns only', () => {
  assert.equal(isBoundaryTurn(5, 5), true)
  assert.equal(isBoundaryTurn(10, 5), true)
  assert.equal(isBoundaryTurn(1, 1), true)
  assert.equal(isBoundaryTurn(3, 5), false)
  assert.equal(isBoundaryTurn(4, 5), false)
  assert.equal(isBoundaryTurn(6, 5), false)
  assert.equal(isBoundaryTurn(0, 5), false)
  assert.equal(isBoundaryTurn(5, 0), false)
  assert.equal(isBoundaryTurn(5.5, 5), false)
  assert.equal(isBoundaryTurn(Number.NaN, 5), false)
})

test('dueTemplates narrows by interval and preserves store order', () => {
  const rows = [
    template({ id: 'a', inject_every: 5 }),
    template({ id: 'b', inject_enabled: false, inject_every: 5 }),
    template({ id: 'c', inject_every: null }),
    template({ id: 'd', inject_every: 3 }),
    template({ id: 'e', inject_every: 10 }),
  ]
  assert.deepEqual(dueTemplates(rows, 5).map(item => item.id), ['a'])
  assert.deepEqual(dueTemplates(rows, 10).map(item => item.id), ['a', 'e'])
  assert.deepEqual(dueTemplates(rows, 1).map(item => item.id), [])
  const due = dueTemplates(rows, 5)[0]
  assert.deepEqual(due && { id: due.id, name: due.name, content: due.content, every: due.every }, {
    id: 'a', name: '推动', content: 'keep moving', every: 5,
  })
})

test('renderInjectionMessage frames one reminder with durable source records', () => {
  const message = renderInjectionMessage(10, [
    { id: 'a', name: '推动', content: 'keep moving', every: 5 },
    { id: 'b', name: 'weird"name', content: 'line one\nline two', every: 10 },
    { id: 'c', name: 'A&B<C>', content: 'x', every: 1 },
  ])
  assert.equal(message.source.kind, 'prompt-template-schedule')
  assert.equal(message.source.turn, 10)
  assert.deepEqual(message.source.templates, [
    { id: 'a', name: '推动', every: 5 },
    { id: 'b', name: 'weird"name', every: 10 },
    { id: 'c', name: 'A&B<C>', every: 1 },
  ])
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  assert.match(text, /^<system-reminder>/)
  assert.match(text, /<\/system-reminder>$/)
  assert.match(text, /turn 10/)
  assert.ok(text.includes('<template name="推动" every="5">\nkeep moving\n</template>'))
  assert.ok(text.includes('<template name="weird&quot;name" every="10">\nline one\nline two\n</template>'))
  assert.ok(text.includes('<template name="A&amp;B&lt;C&gt;" every="1">'))
})

test('alreadyInjectedAtTurn scans the window backward for the source kind and turn', () => {
  const event = (kind: string, turn: number) => ({
    type: 'user/message',
    data: { source: { kind, turn } },
  })
  const events = [
    { type: 'turn/close', data: {} },
    event('prompt-template-schedule', 5),
    event('user', 5),
    event('prompt-template-schedule', 10),
  ]
  assert.equal(alreadyInjectedAtTurn(events, 0, 10), true)
  assert.equal(alreadyInjectedAtTurn(events, 0, 5), true)
  assert.equal(alreadyInjectedAtTurn(events, 0, 15), false)
  // The window is inclusive of scannedFrom: starting at index 2 skips the
  // turn-5 record but still sees the turn-10 one.
  assert.equal(alreadyInjectedAtTurn(events, 1, 5), true)
  assert.equal(alreadyInjectedAtTurn(events, 2, 5), false)
  assert.equal(alreadyInjectedAtTurn(events, 2, 10), true)
  assert.equal(alreadyInjectedAtTurn([], 0, 5), false)
  // Unreadable or foreign sources never match, never throw.
  assert.equal(alreadyInjectedAtTurn([{ type: 'user/message', data: {} }, { type: 'user/message', data: { source: 'garbage' } }], 0, 5), false)
})
