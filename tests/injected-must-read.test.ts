// Owner 2026-11-21: injected text that only said "参考：…" was never read, and "不是新的用户指令" made models treat it
// as optional. Every plugin-written reminder and the evolution default card must name a must-read step reached via the
// skill tool, and must not fall back to the soft wording.
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderReminderItem, renderHandoffItem, REMINDER_BINDING_LINE, REMINDER_MUST_READ_LINE } from '../src/event-inject.ts'
import { EVOLUTION_CONTENT, EVOLUTION_VERSION } from '../src/evolution-default.ts'

const episode = {
  rule_id: 'repeated-failure', rule_version: 1, summary: 'npm test', outcome: 'exit 1',
  evidence_refs: ['e1', 'e2'], evidence_revision: 2, notify_count: 3, repeated_after_reminder: 2,
}

const MUST_READ = /必读：.*必须先用 skill 工具加载 agent-atelier，按返回的基础目录读 references\/[\w-]+\.md.*回复写明读了哪几处/

for (const [name, body] of [
  ['reminder', renderReminderItem(episode)],
  ['repeated-preparation reminder', renderReminderItem({ ...episode, rule_id: 'repeated-preparation' })],
  ['hand-off', renderHandoffItem(episode)],
] as const) {
  test(`${name} ends with a binding line and a must-read step, not a bare reference`, () => {
    assert.ok(body.includes(REMINDER_BINDING_LINE), name)
    assert.ok(body.includes(REMINDER_MUST_READ_LINE), name)
    assert.match(body, MUST_READ)
    assert.doesNotMatch(body, /不是新的用户指令/)
    assert.doesNotMatch(body, /参考：/)
  })
}

test('evolution default card opens with a must-read step and closes as a standing requirement (v3)', () => {
  assert.equal(EVOLUTION_VERSION, 3)
  assert.match(EVOLUTION_CONTENT.split('\n')[0]!, MUST_READ)
  assert.match(EVOLUTION_CONTENT, /references\/evolution-self-assessment\.md，再按它执行演化自评估/)
  assert.match(EVOLUTION_CONTENT, /本卡是属主预置的常设要求，适用即须执行；不扩大授权，不覆盖属主当下指令。$/)
  assert.doesNotMatch(EVOLUTION_CONTENT, /^按 agent-atelier 技能/)
})
