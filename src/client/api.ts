/**
 * Browser-side API over the host's `/plugins/dsh-prompt-templates` routes.
 * One fetch helper per verb; every response settles into the same
 * `{ ok: true; value } | { ok: false; error }` envelope the panel face
 * consumes, so callers never see transport details.
 */

import type { TemplateView } from '../types.ts'

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

/** Create one template. */
export async function createTemplate(request: {
  name: string
  content: string
  scope: 'global' | 'session'
  session_id: string | null
}): Promise<TemplateActionResult> {
  return mutate('POST', '/templates', request)
}

/** Patch one template by id. */
export async function updateTemplate(id: string, request: {
  name?: string
  content?: string
  description?: string | null
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
