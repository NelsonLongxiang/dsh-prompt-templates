import { createTestDirectory } from './temp-dir.mjs'
/**
 * Event reminders, storage and delivery: schema v5, policies, episodes, the
 * outbox state machine, budgets, and the crash/restart/compaction windows
 * (spec M04–M06). Drives the exported halves directly with a fake log.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { DEFAULT_EVENT_INJECT_CONFIG, deliveredEventKeys, observeToolResult, prepareEventReminders } from '../src/event-inject.ts'
import type { EventInjectConfig } from '../src/event-inject.ts'
import { EventRuleError } from '../src/event-store.ts'
import { alreadyInjectedAtTurn } from '../src/inject.ts'
import type { InjectionEventProbe } from '../src/inject.ts'
import { TemplateStore } from '../src/store.ts'

const ON: EventInjectConfig = { ...DEFAULT_EVENT_INJECT_CONFIG, enabled: true }
const SESSION = 'sess-1'

interface Harness {
  store: TemplateStore
  log: InjectionEventProbe[]
  memo: { scanned: number, keys: Set<string> }
  call: (command: string, result?: { isError: boolean, error?: unknown }, extra?: Record<string, unknown>) => void
  step: (turn: number, step: number, config?: EventInjectConfig) => ReturnType<typeof prepareEventReminders>
  commit: (messages: ReturnType<typeof prepareEventReminders>) => void
}

function harness(store = new TemplateStore(':memory:'), config: EventInjectConfig = ON): Harness {
  let call = 0
  const log: InjectionEventProbe[] = []
  const memo = { scanned: 0, keys: new Set<string>() }
  return {
    store,
    log,
    memo,
    call(command, result = { isError: false }, extra = {}) {
      call += 1
      observeToolResult(store.events, config, {
        callId: `call-${call}`, name: 'bash', arguments: { command },
        agent: { session: { header: { id: SESSION } } }, ...extra,
      }, result as never)
    },
    step(turn, step, stepConfig = config) {
      return prepareEventReminders(store.events, stepConfig, SESSION, turn, step, () => log, memo)
    },
    commit(messages) {
      for (const message of messages) log.push({ type: 'user/message', data: { source: (message as unknown as { source: unknown }).source } })
    },
  }
}

function enable(store: TemplateStore, rule: string, patch: Record<string, unknown> = {}): void {
  store.events.updatePolicy(rule, { enabled: true, ...patch })
}

function items(messages: ReturnType<typeof prepareEventReminders>): Array<{ dedup_key: string, episode_id: string, evidence_revision: number }> {
  return messages.flatMap(message => (message as unknown as { source: { items: Array<{ dedup_key: string, episode_id: string, evidence_revision: number }> } }).source.items)
}

function textOf(message: unknown): string {
  return ((message as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
}

const PREP = (n: number): string => `TOKEN_X=abc /opt/py/bin/python task${n}.py`

test('fresh databases get the v5 event tables with every rule disabled', () => {
  const store = new TemplateStore(':memory:')
  try {
    const policies = store.events.policies()
    assert.deepEqual(policies.map(policy => [policy.rule_id, policy.enabled, policy.threshold, policy.mode]), [
      ['repeated-preparation', false, 3, 'visible'],
      ['repeated-failure', false, 2, 'visible'],
    ])
  } finally { store.close() }
})

test('v4 databases migrate to v5 in place, keeping templates and seeding disabled policies', () => {
  const dir = createTestDirectory('pt-v4-')
  const path = join(dir, 'v4.sqlite3')
  try {
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, scope TEXT NOT NULL,
        session_id TEXT, description TEXT, position INTEGER NOT NULL DEFAULT 0, category TEXT,
        inject_enabled INTEGER NOT NULL DEFAULT 0, inject_every INTEGER, mode TEXT NOT NULL DEFAULT 'inject',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE categories (name TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT, PRIMARY KEY (scope, session_id, name));
      INSERT INTO templates (id,name,content,scope,position,inject_enabled,inject_every,mode,created_at,updated_at)
        VALUES ('t','行动审视','body','global',0,1,26,'visible','2026-01-01','2026-01-01');
      PRAGMA user_version=4;`)
    legacy.close()
    const store = new TemplateStore(path)
    try {
      const kept = store.get('t')
      assert.equal(kept?.inject_enabled, true)
      assert.equal(kept?.inject_every, 26)
      assert.equal(kept?.mode, 'visible')
      assert.equal(store.events.policies().every(policy => !policy.enabled), true)
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v7 databases migrate to the current schema: existing episodes gain 提醒后仍在重复 = 0, templates a version, and the intervention log', () => {
  const dir = createTestDirectory('pt-v7-')
  const path = join(dir, 'v7.sqlite3')
  try {
    // Build a real v7 file: a current store, then the v8 column removed and the version set back.
    new TemplateStore(path).close()
    const old = new DatabaseSync(path)
    old.exec(`INSERT INTO event_episodes (episode_id, session_id, rule_id, rule_version, key, tool_name, target_fingerprint, state,
        evidence_refs, evidence_revision, notify_count, summary, outcome, created_at, updated_at)
      VALUES ('ep_old', 's', 'repeated-failure', 1, 'k', 'bash', 'f', 'notified', '[]', 2, 1, 'x', 'error:exit:3', '2026-11-01', '2026-11-01');
      ALTER TABLE event_episodes DROP COLUMN repeated_after_reminder;
      ALTER TABLE templates DROP COLUMN version;
      DROP TABLE interventions;
      DROP TABLE template_versions;
      DROP TABLE self_check_log;
      PRAGMA user_version=7;`)
    old.close()
    const store = new TemplateStore(path)
    try {
      assert.equal(store.events.episode('ep_old')?.repeated_after_reminder, 0)
      assert.equal(store.events.episode('ep_old')?.notify_count, 1)
      assert.deepEqual(store.interventions.list(), [])
      assert.ok(store.library().every(card => card.active_version === null && card.stored_versions.length === 0))
    } finally { store.close() }
    const check = new DatabaseSync(path)
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11)
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('policy updates validate their fields; unknown rules are undefined', () => {
  const store = new TemplateStore(':memory:')
  try {
    assert.equal(store.events.updatePolicy('nope', { enabled: true }), undefined)
    assert.throws(() => store.events.updatePolicy('repeated-failure', { threshold: 0 }), EventRuleError)
    assert.throws(() => store.events.updatePolicy('repeated-failure', { mode: 'loud' as never }), EventRuleError)
    assert.throws(() => store.events.updatePolicy('repeated-failure', { enabled: 'yes' as never }), EventRuleError)
    const updated = store.events.updatePolicy('repeated-failure', { enabled: true, threshold: 4, mode: 'inject' })
    assert.equal(updated?.enabled, true)
    assert.equal(updated?.threshold, 4)
    assert.equal(updated?.mode, 'inject')
  } finally { store.close() }
})

test('nothing is observed while the deployment switch or every policy is off', () => {
  const off = harness(new TemplateStore(':memory:'), DEFAULT_EVENT_INJECT_CONFIG)
  for (let n = 0; n < 5; n += 1) off.call(PREP(n))
  assert.equal(off.store.events.window(SESSION, 50).length, 0)
  off.store.close()
  const noPolicy = harness()
  for (let n = 0; n < 5; n += 1) noPolicy.call(PREP(n))
  assert.equal(noPolicy.store.events.window(SESSION, 50).length, 0)
  assert.deepEqual(noPolicy.step(1, 1), [])
  noPolicy.store.close()
})

test('M04: a reminder is sent once per evidence revision, then cooldown and per-episode budget apply', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation')
    h.call(PREP(1)); h.call(PREP(2))
    assert.deepEqual(h.step(1, 1), [])
    h.call(PREP(3))
    const first = h.step(1, 2)
    assert.equal(first.length, 1)
    const [item] = items(first)
    assert.equal(item?.evidence_revision, 1)
    const text = textOf(first[0])
    assert.match(text, /^⚙️ 事件提醒 · 第 1 轮第 2 步/)
    assert.ok(text.includes('repeated-preparation@1'))
    assert.ok(!text.includes('abc'), 'assignment values never reach the prompt')
    assert.ok(text.includes('在已有授权内推进'))
    // 0.16: every reminder ends with the host-neutral hand-off line, naming no a2a tool.
    assert.ok(text.trimEnd().endsWith('按提醒查过仍解不开的，按所在环境的上报方式交出去，写清已查处、缺的那一句背景。'))
    assert.ok(!/a2a_/.test(text), 'the plugin does not bind to a2a')
    assert.equal(h.store.events.episode(item?.episode_id ?? '')?.repeated_after_reminder, 0)
    h.commit(first)
    // Same evidence replayed: nothing new.
    assert.deepEqual(h.step(1, 3), [])
    assert.deepEqual(h.step(2, 1), [])
    assert.equal(h.store.events.outbox(SESSION, ['persisted']).length, 1)
    // New evidence after the reminder: flagged `repeated`, but cooldown (3 turns) holds.
    h.call(PREP(4))
    const episode = h.store.events.episode(item?.episode_id ?? '')
    assert.equal(episode?.signal, 'repeated')
    assert.equal(episode?.evidence_revision, 2)
    assert.equal(episode?.repeated_after_reminder, 1)
    assert.deepEqual(h.step(3, 1), [])
    const second = h.step(4, 1)
    assert.equal(items(second)[0]?.evidence_revision, 2)
    // A new reminder clears `signal`, but 提醒后仍在重复 stays for a later reader (0.16, schema v8).
    const reminded = h.store.events.episode(item?.episode_id ?? '')
    assert.equal(reminded?.signal, null)
    assert.equal(reminded?.repeated_after_reminder, 1)
    assert.notEqual(items(second)[0]?.dedup_key, item?.dedup_key)
    h.commit(second)
    // max_per_episode = 2: more evidence no longer reminds. It gets the one hand-off notice instead (see the T2 tests).
    h.call(PREP(5))
    const handoff = h.step(10, 1)
    assert.equal(items(handoff).length, 1)
    assert.ok(textOf(handoff[0]).includes('【工坊·交接'), 'a hand-off notice')
    assert.ok(!textOf(handoff[0]).includes('【工坊·行动审视'), 'not a third reminder')
  } finally { h.store.close() }
})

function phaseOf(messages: ReturnType<typeof prepareEventReminders>): Array<string | undefined> {
  return messages.flatMap(message => (message as unknown as { source: { items: Array<{ phase?: string }> } }).source.items.map(item => item.phase))
}

test('T2: once reminding has run out and the pattern still repeats, one hand-off notice goes out, then silence', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation', { cooldown_turns: 1 })
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    const first = h.step(1, 1)
    h.commit(first)
    const id = items(first)[0]?.episode_id ?? ''
    h.call(PREP(4))
    h.commit(h.step(2, 1))
    const spent = h.store.events.episode(id)
    assert.equal(spent?.notify_count, 2, 'the per-episode budget (2) is spent')
    // Budget spent, but nothing repeated since the last reminder: nothing to hand off yet.
    assert.equal(spent === undefined ? undefined : h.store.events.handoffState(spent), 'none')
    assert.deepEqual(h.step(3, 1), [])
    h.call(PREP(5))
    const due = h.store.events.episode(id)
    assert.equal(due === undefined ? undefined : h.store.events.handoffState(due), 'due')
    const handoff = h.step(4, 1)
    assert.equal(handoff.length, 1)
    assert.deepEqual(phaseOf(handoff), ['handoff'])
    assert.ok(items(handoff)[0]?.dedup_key.endsWith('|handoff'))
    const text = textOf(handoff[0])
    assert.match(text, /^⚙️ 事件提醒 · 第 4 轮第 1 步/)
    assert.ok(text.includes('【工坊·交接｜规则 repeated-preparation@1'))
    assert.ok(text.includes('已提醒 2 次，提醒后仍重复 2 次'))
    assert.ok(text.includes('交给属主或评审'))
    assert.ok(text.includes('插件不再就此提醒'))
    assert.ok(text.includes('在已有授权内推进'))
    assert.ok(!text.includes('abc'), 'assignment values never reach the prompt')
    assert.ok(!/a2a_/.test(text), 'the plugin does not bind to a2a')
    // Not another reminder: the episode's own count, state and revision are untouched.
    const after = h.store.events.episode(id)
    assert.equal(after?.notify_count, 2)
    assert.equal(after?.state, 'notified')
    assert.equal(after?.notified_revision, spent?.notified_revision)
    assert.equal(after === undefined ? undefined : h.store.events.handoffState(after), 'pending')
    h.commit(handoff)
    assert.deepEqual(h.step(4, 2), [], 'the turn budget counts the hand-off')
    const sent = h.store.events.episode(id)
    assert.equal(sent === undefined ? undefined : h.store.events.handoffState(sent), 'sent')
    // More repetition afterwards: silence. Exactly one hand-off, ever.
    h.call(PREP(6))
    h.call(PREP(7))
    assert.deepEqual(h.step(9, 1), [])
    assert.equal(h.store.events.outbox(SESSION).filter(row => row.dedup_key.endsWith('|handoff')).length, 1)
  } finally { h.store.close() }
})

test('T2: an undelivered hand-off is retried with the same key and never superseded; resolved episodes and disabled rules get none', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation', { cooldown_turns: 1, max_per_episode: 1 })
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    h.commit(h.step(1, 1))
    h.call(PREP(4))
    const handoff = items(h.step(2, 1))
    assert.equal(handoff.length, 1)
    assert.ok(handoff[0]?.dedup_key.endsWith('|handoff'))
    // Not committed, and newer evidence arrives: the same hand-off is retried, not superseded.
    h.call(PREP(5))
    const retry = items(h.step(3, 1))
    assert.deepEqual(retry.map(row => row.dedup_key), handoff.map(row => row.dedup_key))
    const row = h.store.events.outbox(SESSION).find(entry => entry.dedup_key === handoff[0]?.dedup_key)
    assert.equal(row?.attempts, 2)
    assert.ok(!h.store.events.outbox(SESSION).some(entry => entry.state === 'superseded'))
  } finally { h.store.close() }

  const resolved = harness()
  try {
    enable(resolved.store, 'repeated-preparation', { cooldown_turns: 1, max_per_episode: 1 })
    for (let n = 1; n <= 3; n += 1) resolved.call(PREP(n))
    const first = resolved.step(1, 1)
    resolved.commit(first)
    const id = items(first)[0]?.episode_id ?? ''
    resolved.store.events.resolveEpisode(id, 'deferred', ['call-3'], 'the owner takes it up later')
    resolved.call(PREP(4))
    assert.deepEqual(resolved.step(2, 1), [], 'someone already took it up')
    const episode = resolved.store.events.episode(id)
    assert.equal(episode === undefined ? undefined : resolved.store.events.handoffState(episode), 'none')
  } finally { resolved.store.close() }

  const disabled = harness()
  try {
    enable(disabled.store, 'repeated-preparation', { cooldown_turns: 1, max_per_episode: 1 })
    for (let n = 1; n <= 3; n += 1) disabled.call(PREP(n))
    const first = disabled.step(1, 1)
    disabled.commit(first)
    const id = items(first)[0]?.episode_id ?? ''
    disabled.call(PREP(4))
    disabled.store.events.updatePolicy('repeated-preparation', { enabled: false })
    assert.deepEqual(disabled.step(2, 1), [], 'a disabled rule sends nothing, hand-off included')
    const episode = disabled.store.events.episode(id)
    assert.equal(episode === undefined ? undefined : disabled.store.events.handoffState(episode), 'due', 'the record still says it is due')
  } finally { disabled.store.close() }
})

test('M05: a prepared reminder missing from the log is retried with the same key, then fails after maxAttempts', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation')
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    const first = items(h.step(1, 2))
    // The step never committed (rejected upstream / crash): no commit to the log.
    const retry = items(h.step(1, 3))
    assert.deepEqual(retry.map(row => row.dedup_key), first.map(row => row.dedup_key))
    assert.equal(h.store.events.outbox(SESSION)[0]?.attempts, 2)
    assert.equal(items(h.step(2, 1)).length, 1)
    assert.equal(h.store.events.outbox(SESSION)[0]?.attempts, 3)
    assert.deepEqual(h.step(3, 1), [])
    assert.equal(h.store.events.outbox(SESSION)[0]?.state, 'failed')
  } finally { h.store.close() }
})

test('M05: newer evidence supersedes an undelivered reminder instead of sending both', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation', { cooldown_turns: 1 })
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    const first = items(h.step(1, 2))
    h.call(PREP(4))
    const next = items(h.step(2, 1))
    assert.equal(next.length, 1)
    assert.equal(next[0]?.evidence_revision, 2)
    const states = new Map(h.store.events.outbox(SESSION).map(row => [row.dedup_key, row.state]))
    assert.equal(states.get(first[0]?.dedup_key ?? ''), 'superseded')
  } finally { h.store.close() }
})

test('M05/M06: restart and compaction reconcile from the durable log, never from memory', () => {
  const dir = createTestDirectory('pt-ev-')
  const path = join(dir, 'db.sqlite3')
  try {
    const before = harness(new TemplateStore(path))
    enable(before.store, 'repeated-preparation')
    for (let n = 1; n <= 3; n += 1) before.call(PREP(n))
    // Crash window "detected, not yet prepared": the episode survives a restart.
    before.store.close()
    const restarted = harness(new TemplateStore(path))
    const sent = restarted.step(1, 1)
    assert.equal(sent.length, 1)
    // Crash window "logged, not yet marked persisted": restart with a fresh memo.
    restarted.commit(sent)
    restarted.store.close()
    const again = harness(new TemplateStore(path))
    again.log.push(...restarted.log)
    assert.deepEqual(again.step(1, 2), [])
    assert.equal(again.store.events.outbox(SESSION)[0]?.state, 'persisted')
    // Compaction shrinks the log: the memo rescans from zero.
    again.memo.scanned = 999
    assert.deepEqual(again.step(2, 1), [])
    again.store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('budgets: maxPerTurn spreads reminders over turns and maxChars clips the merged body', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation')
    enable(h.store, 'repeated-failure')
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    h.call('make test', { isError: true, error: { info: { code: 'EXIT_1' } } })
    h.call('make test', { isError: true, error: { info: { code: 'EXIT_1' } } })
    const turn1 = h.step(1, 1)
    assert.equal(items(turn1).length, 1)
    h.commit(turn1)
    assert.deepEqual(h.step(1, 2), [], 'the turn budget counts delivered reminders')
    const turn2 = h.step(2, 1)
    assert.equal(items(turn2).length, 1)
    assert.notEqual(items(turn2)[0]?.episode_id, items(turn1)[0]?.episode_id)

    const tight = harness()
    enable(tight.store, 'repeated-failure', { mode: 'inject' })
    tight.call('make', { isError: true, error: { info: { code: 'E' } } })
    tight.call('make', { isError: true, error: { info: { code: 'E' } } })
    const clipped = tight.step(1, 1, { ...ON, maxChars: 120 })
    const text = textOf(clipped[0])
    assert.match(text, /^<system-reminder>/)
    const body = text.split('\n').slice(3, -1).join('\n')
    assert.ok(body.length <= 120, `body ${body.length} > 120`)
    tight.store.close()
  } finally { h.store.close() }
})

test('M03: event sources never satisfy the scheduled-injection dedup, and vice versa', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation')
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    h.commit(h.step(5, 1))
    assert.equal(alreadyInjectedAtTurn(h.log, 0, 5), false)
    const scheduled: InjectionEventProbe = { type: 'user/message', data: { source: { kind: 'user', scheduled: 'prompt-template', turn: 5, items: [{ dedup_key: 'x' }] } } }
    assert.deepEqual([...deliveredEventKeys([scheduled], 0)], [])
  } finally { h.store.close() }
})

test('resolutions need evidence references; resolved episodes stop reminding; changes are flagged', () => {
  const h = harness()
  try {
    enable(h.store, 'repeated-preparation', { cooldown_turns: 1, max_per_episode: 5 })
    for (let n = 1; n <= 3; n += 1) h.call(PREP(n))
    const sent = items(h.step(1, 1))
    h.commit(h.step(1, 1))
    const id = sent[0]?.episode_id ?? ''
    // Same tool, no preparation prefix: looks changed (a hint only).
    h.call('make build')
    assert.equal(h.store.events.episode(id)?.signal, 'changed')
    assert.equal(h.store.events.episode(id)?.state, 'notified')
    assert.throws(() => h.store.events.resolveEpisode(id, 'verified', [], null), EventRuleError)
    assert.throws(() => h.store.events.resolveEpisode(id, 'notified', ['call-4'], null), EventRuleError)
    assert.throws(() => h.store.events.resolveEpisode(id, 'rejected', ['call-4'], 1), EventRuleError)
    const rejected = h.store.events.resolveEpisode(id, 'rejected', ['call-4'], 'retry is legitimate here')
    assert.equal(rejected?.state, 'rejected')
    assert.deepEqual(rejected?.resolution_refs, ['call-4'])
    assert.equal(h.store.events.resolveEpisode('missing', 'rejected', ['x'], null), undefined)
    h.call(PREP(9))
    assert.deepEqual(h.step(5, 1), [])
  } finally { h.store.close() }
})

test('M07: PTC sub-calls are observed and flagged; observations are trimmed per session', () => {
  const h = harness(new TemplateStore(':memory:'), { ...ON, observationWindow: 10 })
  try {
    enable(h.store, 'repeated-failure')
    h.call('ls', { isError: false }, { parent: 'token-1' })
    assert.equal(h.store.events.window(SESSION, 1)[0]?.is_ptc_subcall, true)
    for (let n = 0; n < 20; n += 1) h.call(`echo ${n}`)
    assert.equal(h.store.events.window(SESSION, 100).length, 10)
  } finally { h.store.close() }
})


test('master switch: config seeds once, stored flag is authoritative afterwards', () => {
  const dir = createTestDirectory('pt-master-')
  try {
  const file = join(dir, 'db.sqlite3')
  let store = new TemplateStore(file)
  try {
    assert.equal(store.events.masterEnabled(true), true, 'first read seeds from config true')
    assert.equal(store.events.masterEnabled(false), true, 'later config value no longer overrides the stored flag')
    assert.equal(store.events.setMasterEnabled(false), false)
    assert.equal(store.events.masterEnabled(true), false)
  } finally { store.close() }
  store = new TemplateStore(file)
  try {
    assert.equal(store.events.masterEnabled(true), false, 'flipped state survives a restart; seed never re-applies')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT id, enabled FROM event_master').get() as { id: number, enabled: number }
      assert.equal(row.id, 1)
      assert.equal(row.enabled, 0, 'single enforced row id=1, stored off')
    } finally { db.close() }
  } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('master switch: config false seeds off and the observer honors the stored flag', () => {
  const store = new TemplateStore(':memory:')
  try {
    assert.equal(store.events.masterEnabled(false), false)
    enable(store, 'repeated-failure')
    const h = harness(store, { ...ON, enabled: false })
    const fail = { isError: true, error: { info: { code: 'EXIT_1' } } }
    h.call('make test', fail)
    h.call('make test', fail)
    assert.equal(h.step(3, 1).length, 0, 'stored master off observes nothing')
    store.events.setMasterEnabled(true)
    h.call('make test', fail)
    h.call('make test', fail)
    assert.equal(h.step(4, 1).length, 1, 'flipping the stored master enables observation mid-flight')
  } finally { store.close() }
})

test('forward wording (owner 2026-11-25): the English event-reminder frame leads with the action', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/event-inject.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('It is evidence for your own judgement; act on it within the permissions this session already has.'))
  assert.ok(!src.includes('grants no permission') && !src.includes('not a user instruction'))
})
