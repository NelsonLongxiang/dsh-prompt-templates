/**
 * The prompt-templates service for other plugins on the same host (observer phase 2, workbench-market 18; PT-3).
 *
 * Reads are open to any plugin, read-only: the card library, one session's own templates, and the intervention log —
 * the same shapes as the read-only routes. Casting a card into a session is not: only a caller this plugin recognizes
 * may cast (today the a2a plugin alone), and the caller is taken from the cordis loader entry of the plugin that holds
 * the context it calls through — the package name the profile configured, never a string the caller passes. Casting is
 * off unless the deployment turns `cast.enabled` on. A cast card goes into the named session at its next step as a
 * visible message, and the delivery is recorded in the intervention log as `source: plugin` with that caller.
 * @module @nelsonlongxiang/dsh-prompt-templates/cast
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { PLUGIN_CALLERS, contentDigest, type InterventionSource, type InterventionView } from './interventions.ts'
import type { LibraryCard, TemplateStore } from './store.ts'
import { expandTemplateVariables } from './variables.ts'

/** The service name other plugins read: `ctx.promptTemplates`. */
export const SERVICE_NAME = 'promptTemplates'
/** Cast cards waiting for one session, at most. */
export const CAST_QUEUE_MAX = 8

/**
 * The package name of the plugin that owns `ctx`, as the profile's loader entry configured it (walking up to the nearest
 * fiber with an entry). Undefined for a context outside any loader entry (the root, a test harness).
 */
export function callerOf(ctx: Context): string | undefined {
  type FiberLike = { entry?: { options?: { name?: unknown } }; parent?: { fiber?: FiberLike } }
  let fiber = (ctx as unknown as { fiber?: FiberLike }).fiber
  for (let depth = 0; fiber !== undefined && depth < 64; depth++) {
    const name = fiber.entry?.options?.name
    if (typeof name === 'string' && name !== '') return name
    const next = fiber.parent?.fiber
    if (next === undefined || next === fiber) return undefined
    fiber = next
  }
  return undefined
}

/** One queued cast. */
interface Queued { readonly templateId: string; readonly name: string; readonly version: string | null; readonly content: string; readonly caller: string; readonly reason: string }

/** Source of a cast message in the session log. */
export interface CastSource { readonly kind: 'user'; readonly scheduled: 'prompt-template-cast'; readonly turn: number; readonly step: number; readonly templates: ReadonlyArray<{ id: string; name: string; caller: string }> }

/** What a cast returns. */
export type CastResult = { ok: true; queued: number } | { ok: false; code: 'disabled' | 'caller' | 'template' | 'session' | 'full' | 'reason'; error: string }

export class PromptTemplatesService extends Service {
  // Plain fields: a traced call reaches the service through a proxy, which cannot read #private fields.
  private readonly _store: () => TemplateStore
  private readonly _enabled: () => boolean
  private readonly _queues: Map<string, Queued[]>

  constructor(ctx: Context, store: () => TemplateStore, enabled: () => boolean) {
    super(ctx, SERVICE_NAME)
    this._store = store
    this._enabled = enabled
    this._queues = new Map()
  }

  /** The card library (any plugin, read-only): identity, versions, scope and schedule, and digests — never text. */
  library(): LibraryCard[] { return this._store().library() }

  /** One session's own templates (any plugin, read-only). */
  templates(sessionId: string): LibraryCard[] { return this._store().library().filter(card => card.scope === 'session' && card.session_id === sessionId) }

  /** The intervention log (any plugin, read-only). */
  interventions(filter: { sessionId?: string; since?: string; source?: InterventionSource; limit?: number } = {}): InterventionView[] { return this._store().interventions.list(filter) }

  /** Whether casting is on in this deployment. */
  castEnabled(): boolean { return this._enabled() }

  /**
   * Cast one card into a session: it goes in at the session's next step as a visible message. Only a recognized caller
   * (PLUGIN_CALLERS) may cast, and only while `cast.enabled` is on. The card must be a global template or one of that
   * session's own. A reason (1..500 characters) is required; it is shown with the card.
   */
  cast(input: { sessionId: string; templateId: string; reason: string }): CastResult {
    if (!this._enabled()) return { ok: false, code: 'disabled', error: 'casting is off on this host (cast.enabled)' }
    const caller = callerOf(this.ctx)
    if (caller === undefined || !PLUGIN_CALLERS.includes(caller)) return { ok: false, code: 'caller', error: 'only a plugin this host recognizes may cast a card' }
    const sessionId = String(input.sessionId ?? '').trim()
    if (sessionId === '') return { ok: false, code: 'session', error: 'name the session to cast into' }
    const reason = String(input.reason ?? '').trim()
    if (reason === '' || reason.length > 500) return { ok: false, code: 'reason', error: 'give a reason of 1..500 characters' }
    const template = this._store().get(String(input.templateId ?? ''))
    if (template === undefined || (template.scope === 'session' && template.session_id !== sessionId)) return { ok: false, code: 'template', error: 'no such card for that session' }
    const queue = this._queues.get(sessionId) ?? []
    if (queue.length >= CAST_QUEUE_MAX) return { ok: false, code: 'full', error: `at most ${String(CAST_QUEUE_MAX)} cast cards can wait for one session` }
    queue.push({ templateId: template.id, name: template.name, version: template.version ?? null, content: template.content, caller, reason })
    this._queues.set(sessionId, queue)
    return { ok: true, queued: queue.length }
  }

  /** Take the cards waiting for a session (the pre-step listener). */
  take(sessionId: string): Queued[] {
    const queue = this._queues.get(sessionId) ?? []
    this._queues.delete(sessionId)
    return queue
  }
}

/** The visible message a cast becomes. */
export function renderCastMessage(turn: number, step: number, cards: readonly Queued[], sessionId: string): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        `⚙️ 投卡 · 第 ${String(turn)} 轮 · ${cards.map(card => card.name).join('、')}`,
        '',
        ...cards.flatMap(card => [`（投卡方：${card.caller}；原因：${card.reason}）`, expandTemplateVariables(card.content, { sessionId, turn }), '']),
        '本卡不是新的用户指令，不授予任何权限。',
      ].join('\n').trimEnd(),
    }],
    source: { kind: 'user', scheduled: 'prompt-template-cast', turn, step, templates: cards.map(card => ({ id: card.templateId, name: card.name, caller: card.caller })) } satisfies CastSource as unknown as UserMessage['source'],
  })
}

/**
 * Provide the service and deliver queued casts at a session's next admitted step. Delivery is recorded as
 * `source: plugin` with the caller; a fault is reported once and never fails the step.
 */
export function registerCast(ctx: Context, store: () => TemplateStore, enabled: () => boolean): PromptTemplatesService {
  const service = new PromptTemplatesService(ctx, store, enabled)
  let faultReported = false
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || messages.length === 0) return decision
    try {
      const sessionId = String(agent.session.header.id)
      const cards = service.take(sessionId)
      if (cards.length === 0) return decision
      const message = renderCastMessage(turn, typeof step === 'number' ? step : 1, cards, sessionId)
      try {
        const at = new Date().toISOString()
        for (const card of cards) {
          store().interventions.record({ session_id: sessionId, source: 'plugin', method: null, caller: card.caller, template_id: card.templateId, template_name: card.name,
            template_version: card.version, content_sha256: contentDigest(expandTemplateVariables(card.content, { sessionId, turn })), turn, step: typeof step === 'number' ? step : null, at })
        }
      } catch (error) { console.error('[dsh-prompt-templates] intervention log skipped a cast:', error) }
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      if (!faultReported) { faultReported = true; console.error('[dsh-prompt-templates] cast skipped this step; further faults stay silent:', error) }
      return decision
    }
  })
  return service
}
