/**
 * Template-variable expansion: one pure, client-safe function shared by the
 * scheduled-injection host path and the composer delivery verbs. A variable
 * expands only when its value is available in the delivery context;
 * unavailable or unknown placeholders stay literal.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { TEMPLATE_VARIABLES, expandTemplateVariables } from '../src/variables.ts'

const NOW = new Date(2026, 10, 8, 16, 5) // 2026-11-08 16:05 local, a Sunday

test('clock variables render from the provided instant', () => {
  assert.equal(expandTemplateVariables('{{date}}', { now: NOW }), '2026-11-08')
  assert.equal(expandTemplateVariables('{{time}}', { now: NOW }), '16:05')
  assert.equal(expandTemplateVariables('{{datetime}}', { now: NOW }), '2026-11-08 16:05')
  assert.equal(expandTemplateVariables('{{weekday}}', { now: NOW }), '星期日')
})

test('context variables expand when known and stay literal when unknown', () => {
  assert.equal(expandTemplateVariables('{{session}}', { sessionId: 'sess-a', now: NOW }), 'sess-a')
  assert.equal(expandTemplateVariables('{{turn}}', { turn: 12, now: NOW }), '12')
  assert.equal(expandTemplateVariables('{{turn}}', { now: NOW }), '{{turn}}')
  assert.equal(expandTemplateVariables('{{session}}', { now: NOW }), '{{session}}')
})

test('unknown names, spacing, and plain text pass through untouched', () => {
  assert.equal(expandTemplateVariables('{{ who }}', { now: NOW }), '{{ who }}')
  assert.equal(expandTemplateVariables('{{ date }}', { now: NOW }), '2026-11-08')
  assert.equal(expandTemplateVariables('no placeholders here', { now: NOW }), 'no placeholders here')
  assert.equal(expandTemplateVariables('{{date}} {{nope}} {{turn}}', { turn: 3, now: NOW }), '2026-11-08 {{nope}} 3')
})

test('the advertised variable list matches the implemented set', () => {
  assert.deepEqual([...TEMPLATE_VARIABLES].sort(), ['date', 'datetime', 'session', 'time', 'turn', 'weekday'])
})
