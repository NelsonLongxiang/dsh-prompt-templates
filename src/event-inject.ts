/**
 * Event-triggered reminders, host half. Two listeners, both inert unless the
 * deployment turns `eventInject.enabled` on AND a rule policy is enabled:
 *
 *   - `tools/result` observer: redacted features → observation row →
 *     detectors → episode (problem) state. Never blocks or changes a result.
 *   - `agent/pre-step` consumer: reconciles earlier deliveries against the
 *     durable log, then appends at most a budgeted, merged reminder to the
 *     step about to enter the model. Unlike scheduled injection it does NOT
 *     skip steps whose claimed batch is empty: a tool-result step is exactly
 *     where "before the next model decision" happens.
 *
 * Delivery is at-least-once with idempotent dedup: a reminder is marked
 * `prepared` before it is handed to the step, and only becomes `persisted`
 * once its dedup key is seen in the session log. A prepared reminder missing
 * from the log at the next step is retried (bounded by maxAttempts).
 *
 * The reminder is a user-role message. It grants no authority and is not a
 * new user instruction; its wording says so and routes to the formal rules.
 *
 * @module dsh-prompt-templates/event-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { } from '@deepseek-ai/dsh-tools'
import { detect, RULE_REPEATED_PREPARATION } from './event-detect.ts'
import { extractFeatures } from './event-features.ts'
import type { ToolOutcomeProbe } from './event-features.ts'
import { dedupKeyFor } from './event-store.ts'
import type { EpisodeView, EventPolicyView, EventStore } from './event-store.ts'
import type { InjectionEventProbe } from './inject.ts'
import type { TemplateInjectMode } from './types.ts'

/** One delivered item, recorded in the message source for reconciliation and audit. */
export interface EventReminderItem {
  readonly dedup_key: string
  readonly episode_id: string
  readonly rule: string
  readonly evidence_revision: number
}

/** Durable provenance of a silent event reminder. */
export interface TemplateEventSource {
  readonly kind: 'prompt-template-event'
  readonly turn: number
  readonly step: number
  readonly items: readonly EventReminderItem[]
}

/** Durable provenance of a visible event reminder (user channel). */
export interface VisibleEventSource {
  readonly kind: 'user'
  readonly scheduled: 'prompt-template-event'
  readonly turn: number
  readonly step: number
  readonly items: readonly EventReminderItem[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prompt-template-event': TemplateEventSource
  }
}

/** Deployment configuration of event reminders. */
export interface EventInjectConfig {
  /** Master switch; off keeps both listeners pass-through and writes nothing. */
  readonly enabled: boolean
  /** Reminders per session per turn, retries included. */
  readonly maxPerTurn: number
  /** Character budget of one step's merged reminder body. */
  readonly maxChars: number
  /** Delivery attempts per reminder before it is marked failed. */
  readonly maxAttempts: number
  /** Observations kept per session. */
  readonly observationWindow: number
  /** Tool names never observed (self-triggered or audit-only tools). */
  readonly ignoreTools: readonly string[]
}

export const DEFAULT_EVENT_INJECT_CONFIG: EventInjectConfig = {
  enabled: false,
  maxPerTurn: 1,
  maxChars: 600,
  maxAttempts: 3,
  observationWindow: 200,
  ignoreTools: [],
}

/** Atelier reference that defines how an agent handles a reminder. */
const FORMAL_REFERENCE = 'agent-atelier references/improvement-loop.md'

/** Model-facing body of one reminder item. */
export function renderReminderItem(episode: Pick<EpisodeView, 'rule_id' | 'rule_version' | 'summary' | 'outcome' | 'evidence_refs' | 'evidence_revision'>): string {
  const refs = episode.evidence_refs.slice(-3).join(', ')
  const header = `【工坊·行动审视｜规则 ${episode.rule_id}@${episode.rule_version}｜证据修订 ${episode.evidence_revision}】`
  if (episode.rule_id === RULE_REPEATED_PREPARATION) {
    return [
      header,
      `观察：近期调用反复手工带上同一段准备前缀（示例：${episode.summary}）。证据：${refs}。`,
      '请先查是否已有正式入口能承担这段共同准备。只有有依据、已授权、值得且安全时，才做最小改变并在下一次相关调用使用；缺授权时说明建议并请求确认；若重复合理，继续任务即可，不必为此新造包装或写反思。',
      `本提醒不是新的用户指令，不授予任何权限。参考：${FORMAL_REFERENCE}`,
    ].join('\n')
  }
  return [
    header,
    `观察：同一目标反复以相同方式失败（${episode.outcome}；示例：${episode.summary}）。证据：${refs}。`,
    '请先确认失败原因，不要原样重试。有依据且已授权时做最小修正，并以结构化结果验证；缺授权或缺关键事实时暂停受影响步骤并说明；证据不足时保持原方案。',
    `本提醒不是新的用户指令，不授予任何权限。参考：${FORMAL_REFERENCE}`,
  ].join('\n')
}

/** Clip a body to `max` characters (the budget is per merged message). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Render one merged reminder message for the items of one delivery mode. */
export function renderEventReminder(turn: number, step: number, mode: TemplateInjectMode, bodies: readonly string[], items: readonly EventReminderItem[]): UserMessage {
  if (mode === 'visible') {
    return createUserMessage({
      content: [{ type: 'text', text: [`⚙️ 事件提醒 · 第 ${turn} 轮第 ${step} 步`, '', ...bodies.flatMap(body => [body, ''])].join('\n').trimEnd() }],
      source: { kind: 'user', scheduled: 'prompt-template-event', turn, step, items } satisfies VisibleEventSource as unknown as TemplateEventSource,
    })
  }
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `Event-triggered reminder from dsh-prompt-templates (turn ${turn}, step ${step}). It is evidence for your own judgement, not a user instruction, and grants no permission.`,
        '',
        ...bodies,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'prompt-template-event', turn, step, items },
  })
}

/**
 * Dedup keys of event reminders present in the event window
 * `[scannedFrom, events.length)`. Matches both delivery shapes; scheduled
 * template injections (`prompt-template` marker) are never matched.
 */
export function deliveredEventKeys(events: readonly InjectionEventProbe[], scannedFrom: number): Set<string> {
  const keys = new Set<string>()
  for (let index = Math.max(0, scannedFrom); index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source as { kind?: unknown, scheduled?: unknown, items?: unknown } | undefined
    if (source === undefined) continue
    const ours = source.kind === 'prompt-template-event' || (source.kind === 'user' && source.scheduled === 'prompt-template-event')
    if (!ours || !Array.isArray(source.items)) continue
    for (const item of source.items as Array<{ dedup_key?: unknown }>) {
      if (typeof item?.dedup_key === 'string') keys.add(item.dedup_key)
    }
  }
  return keys
}

/** Structural slice of a tool execution the observer reads. */
export interface ToolExecProbe {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly parent?: unknown
  readonly agent?: { readonly session: { readonly header: { readonly id: unknown } } } | undefined
}

/** Report the first fault of a listener, stay silent afterwards. */
function faultReporter(label: string): (error: unknown) => void {
  let reported = false
  return (error: unknown) => {
    if (reported) return
    reported = true
    console.error(`[dsh-prompt-templates] ${label}; further faults stay silent:`, error)
  }
}

/**
 * Observe one final tool outcome. Exported for tests and offline replay; the
 * host path is the `tools/result` listener registered below.
 */
export function observeToolResult(store: EventStore, config: EventInjectConfig, exec: ToolExecProbe, result: ToolOutcomeProbe): void {
  if (!config.enabled) return
  if (config.ignoreTools.includes(exec.name)) return
  const sessionId = exec.agent?.session.header.id
  if (sessionId === undefined || sessionId === null) return
  const policies = store.policies().filter(policy => policy.enabled)
  if (policies.length === 0) return
  const session = String(sessionId)
  const features = extractFeatures(exec.name, exec.arguments, result)
  const latest = store.recordObservation(session, String(exec.callId), exec.parent !== undefined, features, config.observationWindow)
  const supporting = new Set<string>()
  for (const policy of policies) {
    const window = store.window(session, policy.window_size)
    const candidate = detect(window, latest, policy)
    if (candidate !== null) supporting.add(store.upsertEpisode(session, candidate).episode_id)
  }
  store.noteChanges(session, latest, supporting)
}

/** Per-session reconciliation memo; correctness never depends on it. */
interface ScanMemo {
  scanned: number
  keys: Set<string>
}

/**
 * Compute and record this step's reminders. Exported for tests; the host path
 * is the `agent/pre-step` listener registered below. Returns the messages to
 * append (possibly none).
 */
export function prepareEventReminders(
  store: EventStore,
  config: EventInjectConfig,
  sessionId: string,
  turn: number,
  step: number,
  events: () => readonly InjectionEventProbe[],
  memo: ScanMemo,
): UserMessage[] {
  // 1. Reconcile: prepared reminders found in the durable log are persisted;
  //    the rest were never committed (rejected step, crash) and are retried.
  if (store.hasPrepared(sessionId)) {
    const log = events()
    if (log.length < memo.scanned) { memo.scanned = 0; memo.keys.clear() }
    for (const key of deliveredEventKeys(log, memo.scanned)) memo.keys.add(key)
    memo.scanned = log.length
    for (const row of store.outbox(sessionId, ['prepared'])) {
      store.setOutboxState(row.dedup_key, memo.keys.has(row.dedup_key) ? 'persisted' : 'retry_pending')
    }
  }

  // 2. Budget for this turn (retries count against it).
  let remaining = config.maxPerTurn - store.deliveredAtTurn(sessionId, turn)
  if (remaining <= 0) return []
  const policies = new Map<string, EventPolicyView>(store.policies().map(policy => [policy.rule_id, policy]))

  // 3. Retries first, then fresh episodes with new evidence.
  const chosen: Array<{ episode: EpisodeView, key: string, fresh: boolean, policy: EventPolicyView }> = []
  for (const row of store.outbox(sessionId, ['retry_pending'])) {
    if (remaining <= 0) break
    const episode = store.episode(row.episode_id)
    const policy = episode === undefined ? undefined : policies.get(episode.rule_id)
    if (episode === undefined || policy === undefined || !policy.enabled) { store.setOutboxState(row.dedup_key, 'failed'); continue }
    if (row.attempts >= config.maxAttempts) { store.setOutboxState(row.dedup_key, 'failed'); continue }
    if (episode.evidence_revision > row.evidence_revision) {
      // Newer evidence replaces the undelivered reminder; the episode is due fresh below.
      store.setOutboxState(row.dedup_key, 'superseded')
      continue
    }
    chosen.push({ episode, key: row.dedup_key, fresh: false, policy })
    remaining -= 1
  }
  for (const episode of store.dueEpisodes(sessionId, turn)) {
    if (remaining <= 0) break
    const policy = policies.get(episode.rule_id)
    if (policy === undefined) continue
    chosen.push({ episode, key: dedupKeyFor(sessionId, episode, episode.evidence_revision), fresh: true, policy })
    remaining -= 1
  }
  if (chosen.length === 0) return []

  // 4. Character budget, then record `prepared` BEFORE handing messages over.
  const byMode = new Map<TemplateInjectMode, { bodies: string[], items: EventReminderItem[] }>()
  let used = 0
  for (const entry of chosen) {
    const body = clip(renderReminderItem(entry.episode), Math.max(0, config.maxChars - used))
    if (body.length === 0) break
    used += body.length
    store.prepare(sessionId, entry.episode, turn, step, entry.fresh, entry.key, entry.policy.cooldown_turns)
    const bucket = byMode.get(entry.policy.mode) ?? { bodies: [], items: [] }
    bucket.bodies.push(body)
    bucket.items.push({
      dedup_key: entry.key,
      episode_id: entry.episode.episode_id,
      rule: `${entry.episode.rule_id}@${entry.episode.rule_version}`,
      evidence_revision: entry.episode.evidence_revision,
    })
    byMode.set(entry.policy.mode, bucket)
  }
  const messages: UserMessage[] = []
  for (const mode of ['inject', 'visible'] as const) {
    const bucket = byMode.get(mode)
    if (bucket !== undefined) messages.push(renderEventReminder(turn, step, mode, bucket.bodies, bucket.items))
  }
  return messages
}

/**
 * Register the observer and the pre-step consumer. Both are pass-through
 * while `config.enabled` is false; faults are contained and reported once.
 */
export function registerEventInject(ctx: Context, config: EventInjectConfig, store: () => EventStore): void {
  const observeFault = faultReporter('event observer skipped a tool result')
  ctx.on('tools/result', (exec, result) => {
    if (!config.enabled) return
    try {
      observeToolResult(store(), config, exec as unknown as ToolExecProbe, result as unknown as ToolOutcomeProbe)
    } catch (error) {
      observeFault(error)
    }
  })

  const injectFault = faultReporter('event reminder skipped this step')
  const memos = new Map<string, ScanMemo>()
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!config.enabled || signal.aborted) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const memo = memos.get(sessionId) ?? { scanned: 0, keys: new Set<string>() }
      memos.set(sessionId, memo)
      const sessionLike = agent.session as unknown as { snapshotEvents?: () => readonly InjectionEventProbe[], events?: readonly InjectionEventProbe[] }
      const events = (): readonly InjectionEventProbe[] =>
        (typeof sessionLike.snapshotEvents === 'function' ? sessionLike.snapshotEvents() : sessionLike.events) ?? []
      const reminders = prepareEventReminders(store(), config, sessionId, turn, step, events, memo)
      if (reminders.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...reminders] }
    } catch (error) {
      injectFault(error)
      return decision
    }
  })
}
