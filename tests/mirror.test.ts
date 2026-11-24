/**
 * The mirror variable: recent turn endings set beside what came next, rendered from the session's durable events.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMirror, type MirrorEventProbe } from '../src/mirror.ts'
import { expandTemplateVariables } from '../src/variables.ts'

const user = (kind: string, text: string): MirrorEventProbe => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const say = (text: string): MirrorEventProbe => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const call: MirrorEventProbe = { type: 'tool/call', data: {} }

test('each finished turn shows its last words, its action count and who spoke next', () => {
  const events = [
    user('user', '先做原型'), call, say('中间的话'), say('已做完，等你点头'),
    user('time-context', '<system-reminder>time</system-reminder>'),
    user('user', '你在等我点头'), say('好。'),
    user('a2a-relay', '评审席回执到了'),
  ]
  const mirror = renderMirror(events)
  assert.match(mirror, /^镜（/)
  assert.match(mirror, /你收尾（1 个动作）：…已做完，等你点头\n  属主随后：你在等我点头/)
  assert.match(mirror, /你收尾（0 个动作）：…好。\n  他会话随后：评审席回执到了/)
  assert.doesNotMatch(mirror, /中间的话/)
  assert.doesNotMatch(mirror, /system-reminder/)
})

test('only the last three turns show', () => {
  const events: MirrorEventProbe[] = []
  for (let i = 1; i <= 5; i++) events.push(user('user', `话${i}`), say(`收尾${i}`))
  events.push(user('user', '最新'))
  const mirror = renderMirror(events)
  assert.doesNotMatch(mirror, /收尾2/)
  assert.match(mirror, /收尾3[\s\S]*收尾4[\s\S]*收尾5\n  属主随后：最新/)
})

test('no finished turn renders nothing, and the variable then expands to an empty string', () => {
  assert.equal(renderMirror([user('user', '第一句')]), '')
  assert.equal(expandTemplateVariables('前{{mirror}}后', { mirror: '' }), '前后')
  assert.equal(expandTemplateVariables('{{ mirror }}', {}), '{{ mirror }}')
})
