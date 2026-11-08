/**
 * Clipboard sharing: the single-template and whole-category payload format
 * plus the import planner (create vs overwrite), as pure functions so both
 * surfaces (overlay panel + sidebar tab) share one implementation and the
 * planner stays unit-testable without a DOM.
 *
 * Collision rule (owner ruling 2026-11-08): same name + same scope counts
 * as an overwrite risk — the UI asks, the planner just reports the pairs.
 * @module dsh-prompt-templates/client/share
 */
import type { CategoryView, TemplateView } from '../types.ts'

/** Payload format marker and version (v1). */
export const SHARE_FORMAT = 'dsh-prompt-templates'
export const SHARE_VERSION = 1

/** Clipboard payload for one template or one category's templates. */
export interface SharePayload {
  readonly format: typeof SHARE_FORMAT
  readonly version: typeof SHARE_VERSION
  readonly kind: 'templates'
  readonly templates: readonly TemplateView[]
  readonly categories?: readonly CategoryView[]
}

/** Build the clipboard payload for a share action. */
export function buildSharePayload(templates: readonly TemplateView[], categories: readonly CategoryView[] = []): SharePayload {
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    kind: 'templates',
    templates: [...templates],
    categories: [...categories],
  }
}

/** Parse a pasted payload; a one-line error string on any mismatch. */
export function parseSharePayload(text: string): { ok: true, payload: SharePayload } | { ok: false, error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'payload is not an object' }
  const value = raw as Partial<SharePayload>
  if (value.format !== SHARE_FORMAT) return { ok: false, error: 'unknown format' }
  if (value.version !== SHARE_VERSION) return { ok: false, 'error': 'unsupported version ' + String(value.version) }
  if (value.kind !== 'templates') return { ok: false, error: 'unknown kind' }
  if (!Array.isArray(value.templates) || value.templates.length === 0) return { ok: false, error: 'no templates' }
  return {
    ok: true,
    payload: { ...value, categories: Array.isArray(value.categories) ? value.categories : [] } as SharePayload,
  }
}

/** Planned import outcome: plain creates, overwrite pairs, missing categories. */
export interface ImportPlan {
  readonly create: readonly TemplateView[]
  readonly overwrite: readonly { readonly incoming: TemplateView, readonly target: TemplateView }[]
  /** Payload categories the target lacks in the same scope (create them first). */
  readonly missingCategories: readonly CategoryView[]
}

/** Plan the import against the target's rows: same name + same scope collides. */
export function planShareImport(payload: SharePayload, existing: readonly TemplateView[], existingCategories: readonly CategoryView[]): ImportPlan {
  const create: TemplateView[] = []
  const overwrite: { incoming: TemplateView, target: TemplateView }[] = []
  for (const incoming of payload.templates) {
    const clash = existing.find(row => row.name === incoming.name && row.scope === incoming.scope)
    if (clash === undefined) create.push(incoming)
    else overwrite.push({ incoming, target: clash })
  }
  const have = new Set(existingCategories.map(cat => cat.scope + ':' + cat.name))
  const missingCategories = (payload.categories ?? []).filter(cat => !have.has(cat.scope + ':' + cat.name))
  return { create, overwrite, missingCategories }
}
