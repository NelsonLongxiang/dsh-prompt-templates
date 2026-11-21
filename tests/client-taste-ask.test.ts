/** B1b (owner 2026-11-21, option 甲): the panel's ask that the session propose a pinned lesson as a taste rule. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildTasteAsk, lessonTypeOf } from '../src/client/taste-ask.ts'
import { zh, en } from '../src/client/locales.ts'

const lesson = {
  name: '体会·验',
  content: 'CI 绿不等于测试跑了；评审测试改动时，先看测试数有没有突降。',
  evidence: 'PR #57 CI 267/267',
  rounds: { opened: 3, closed: 2, kept: 1 },
  recurrence: { before: { hits: 2, fails: 2 }, after: { hits: 4, fails: 1 } },
}

for (const locale of ['zh', 'en'] as const) {
  const t = locale === 'zh' ? zh : en
  test(`${locale}: the ask names both taste tools, the lesson facts and the endorsement rule`, () => {
    const ask = buildTasteAsk(t['panel.tasteAskText'], lesson, t['panel.tasteAskNone'])
    for (const needle of ['taste__update', 'taste_update', 'taste__rules', 'taste_rules', 'action=propose', 'candidates', 'selected', 'anchor', lesson.content, lesson.evidence, '2/3', '1/4']) {
      assert.ok(ask.includes(needle), `missing ${needle}`)
    }
    assert.doesNotMatch(ask, /\{(type|content|evidence|opened|closed|kept|afterFails|afterHits)\}/)
    assert.ok(ask.includes(locale === 'zh' ? '（验）' : '(验)'))
  })
  test(`${locale}: a lesson without evidence or rounds reads as none and zeros`, () => {
    const ask = buildTasteAsk(t['panel.tasteAskText'], { name: '体会·找', content: 'x', evidence: null }, t['panel.tasteAskNone'])
    assert.ok(ask.includes(`${locale === 'zh' ? '证据：' : 'Evidence: '}${t['panel.tasteAskNone']}`))
    assert.ok(ask.includes('0/0'))
  })
}

test('braces inside the lesson or evidence are never re-expanded', () => {
  const ask = buildTasteAsk('{content} | {evidence}', { name: '体会·落', content: 'use {evidence} literally', evidence: '{content}' }, '-')
  assert.equal(ask, 'use {evidence} literally | {content}')
})

test('lessonTypeOf strips the 体会· prefix and leaves other names alone', () => {
  assert.equal(lessonTypeOf('体会·收'), '收')
  assert.equal(lessonTypeOf('体会·3'), '3')
  assert.equal(lessonTypeOf('other'), 'other')
})

test('the panel inserts the ask (never sends it) and offers it only on pinned lessons', () => {
  const src = readFileSync(new URL('../src/client/Library.tsx', import.meta.url), 'utf8')
  const handler = src.slice(src.indexOf('const handleTasteAsk'), src.indexOf('const handleSend'))
  assert.match(handler, /insert\(sessionId, buildTasteAsk\(/)
  assert.doesNotMatch(handler, /\b(send|interject)\(/)
  assert.match(src, /pin\?\.pinned === true && pin\.onTasteAsk !== undefined/)
})
