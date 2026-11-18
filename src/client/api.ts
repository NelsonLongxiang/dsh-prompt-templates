/**
 * Browser-side API over the host's `/plugins/dsh-prompt-templates` routes.
 * One fetch helper per verb; every response settles into the same
 * `{ ok: true; value } | { ok: false; error }` envelope the panel face
 * consumes, so callers never see transport details.
 */

import type { CategoryView, InjectionHistoryEntry, InjectionStatusView, TemplateInjectMode, TemplateView } from '../types.ts'

/** Business error carried by a failed call. */
export interface TemplateError {
  readonly code: string
  readonly message: string
}

/** Settled outcome of one template mutation. */
export type TemplateActionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: TemplateError }

const BASE = '/plugins/dsh-prompt-templates'

/** Load the full template set (global + every session's). */
export async function listTemplates(): Promise<TemplateView[]> {
  const response = await fetch(`${BASE}/templates`, { cache: 'no-store' })
  if (!response.ok) return []
  const body = await response.json() as { items?: TemplateView[] }
  return [...body.items ?? []]
}

/** Poll a session's latest scheduled injection; null when none since boot (badges hide). */
export async function injectStatus(sessionId: string): Promise<InjectionStatusView | null> {
  const response = await fetch(`${BASE}/inject-status?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) return null
  const body = await response.json() as { status?: InjectionStatusView | null }
  return body.status ?? null
}

/** Load a session recent scheduled injections, newest first (empty when none). */
export async function injectionHistory(sessionId: string): Promise<readonly InjectionHistoryEntry[]> {
  const response = await fetch(`${BASE}/inject-status?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) return []
  const body = await response.json() as { history?: InjectionHistoryEntry[] }
  return [...body.history ?? []]
}

/** Load every user category tab (global + all sessions'; the panel filters). */
export async function listCategories(): Promise<CategoryView[]> {
  const response = await fetch(`${BASE}/categories`, { cache: 'no-store' })
  if (!response.ok) return []
  const body = await response.json() as { items?: CategoryView[] }
  return [...body.items ?? []]
}

/** Create one category tab. */
export async function createCategory(request: {
  name: string
  scope: 'global' | 'session'
  session_id: string | null
}): Promise<TemplateActionResult> {
  return mutate('POST', '/categories', request)
}

/** Delete one category tab (its templates fall back to the default tab). */
export async function deleteCategory(name: string, scope: 'global' | 'session', sessionId: string | null): Promise<TemplateActionResult> {
  const params = new URLSearchParams({ scope })
  if (sessionId !== null) params.set('session_id', sessionId)
  return mutate('DELETE', `/categories/${encodeURIComponent(name)}?${params.toString()}`)
}

/** Create one template. */
export async function createTemplate(request: {
  name: string
  content: string
  scope: 'global' | 'session'
  session_id: string | null
  description?: string | null
  category?: string | null
  inject_enabled?: boolean
  inject_every?: number | null
  mode?: TemplateInjectMode
}): Promise<TemplateActionResult> {
  return mutate('POST', '/templates', request)
}

/** Patch one template by id. */
export async function updateTemplate(id: string, request: {
  name?: string
  content?: string
  description?: string | null
  position?: number
  category?: string | null
  inject_enabled?: boolean
  inject_every?: number | null
  mode?: TemplateInjectMode
}): Promise<TemplateActionResult> {
  return mutate('PATCH', `/templates/${encodeURIComponent(id)}`, request)
}

/** Promote one session template to the global partition. */
export async function makeTemplateGlobal(id: string): Promise<TemplateActionResult> {
  return mutate('POST', `/templates/${encodeURIComponent(id)}/make-global`, {})
}

/** Delete one template by id. */
export async function deleteTemplate(id: string): Promise<TemplateActionResult> {
  return mutate('DELETE', `/templates/${encodeURIComponent(id)}`)
}

/** One event-reminder rule's policy as the panel renders it (wire shape). */
export interface EventPolicyWire {
  readonly rule_id: string
  readonly rule_version: number
  readonly enabled: boolean
  readonly threshold: number
  readonly window_size: number
  readonly cooldown_turns: number
  readonly max_per_episode: number
  readonly mode: TemplateInjectMode
  readonly updated_at: string
}

/** Editable policy fields the panel sends (rule id/version are not editable). */
export interface EventPolicyPatch {
  readonly enabled?: boolean
  readonly threshold?: number
  readonly cooldown_turns?: number
}

/** One problem episode of one session, read-only in the panel (wire shape). */
export interface EventEpisodeWire {
  readonly episode_id: string
  readonly rule_id: string
  readonly state: string
  readonly evidence_revision: number
  readonly notify_count: number
  readonly summary: string
  readonly updated_at: string
}

/** Load the event rules plus the deployment master-switch state; null when unavailable. */
export async function eventPolicies(): Promise<{ items: EventPolicyWire[]; enabled: boolean } | null> {
  const response = await fetch(`${BASE}/event-policies`, { cache: 'no-store' })
  if (!response.ok) return null
  const body = await response.json() as { items?: EventPolicyWire[]; config?: { enabled?: boolean } }
  return { items: [...body.items ?? []], enabled: body.config?.enabled === true }
}

/** Flip the stored master switch (panel-owned; deployment config seeds it once). */
export function setEventMaster(enabled: boolean): Promise<TemplateActionResult> {
  return mutate('PATCH', '/event-policies/master', { enabled })
}

/** Flip or tune one event rule (partial patch). */
export function updateEventPolicy(ruleId: string, patch: EventPolicyPatch): Promise<TemplateActionResult> {
  return mutate('PATCH', `/event-policies/${encodeURIComponent(ruleId)}`, patch)
}

/** Load one session's recent problem episodes (empty when none or unavailable). */
export async function eventEpisodes(sessionId: string): Promise<EventEpisodeWire[]> {
  const response = await fetch(`${BASE}/event-episodes?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) return []
  const body = await response.json() as { items?: EventEpisodeWire[] }
  return [...body.items ?? []]
}

/** Run one mutating request and settle it into the action envelope. */
async function mutate(method: string, path: string, body?: unknown): Promise<TemplateActionResult> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: TemplateError } | null
      return {
        ok: false,
        error: payload?.error ?? { code: `http:${response.status}`, message: response.statusText },
      }
    }
    return { ok: true, value: await response.json().catch(() => undefined) }
  } catch (error) {
    return { ok: false, error: { code: 'network-error', message: String(error) } }
  }
}
