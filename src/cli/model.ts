import { createHash } from 'node:crypto'
import type { CategoryView, TemplateView } from '../types.ts'

export const SNAPSHOT_SCHEMA_VERSION = 2

const TEMPLATE_KEYS = ['id', 'name', 'content', 'scope', 'session_id', 'description', 'position', 'category', 'created_at', 'updated_at'] as const
const CATEGORY_KEYS = ['name', 'scope', 'session_id'] as const

export interface DataSnapshot {
  readonly schema_version: 2
  readonly categories: readonly CategoryView[]
  readonly templates: readonly TemplateView[]
  readonly data_sha256: string
  readonly exported_at?: string
  readonly source?: string
}

export interface DiffResult {
  readonly identical: boolean
  readonly templates: {
    readonly left: number
    readonly right: number
    readonly only_left: readonly TemplateView[]
    readonly only_right: readonly TemplateView[]
    readonly changed: readonly { id: string; name: string; fields: readonly string[]; left: TemplateView; right: TemplateView }[]
    readonly name_conflicts: readonly { name: string; left_ids: readonly string[]; right_ids: readonly string[] }[]
  }
  readonly categories: {
    readonly left: number
    readonly right: number
    readonly only_left: readonly CategoryView[]
    readonly only_right: readonly CategoryView[]
  }
}

export type MergeStrategy = 'newer' | 'keep-base' | 'keep-incoming'

export interface MergeResult {
  readonly snapshot?: DataSnapshot
  readonly conflicts: readonly MergeConflict[]
  readonly summary: {
    readonly templates: number
    readonly categories: number
    readonly inserted: number
    readonly incoming_selected: number
    readonly base_selected: number
  }
}

export interface MergeConflict {
  readonly kind: 'same-time-different-content' | 'invalid-timestamp' | 'same-name-different-id'
  readonly message: string
  readonly ids: readonly string[]
}

export function parseSnapshot(value: unknown): DataSnapshot {
  const root = object(value, 'snapshot')
  exactKeys(root, ['schema_version', 'categories', 'templates', 'data_sha256', 'exported_at', 'source'], 'snapshot')
  if (root.schema_version !== SNAPSHOT_SCHEMA_VERSION) throw new Error(`unsupported schema_version ${String(root.schema_version)} (expected 2)`)
  if (!Array.isArray(root.categories) || !Array.isArray(root.templates)) throw new Error('categories and templates must be arrays')
  const categories = root.categories.map((entry, index) => parseCategory(entry, `categories[${index}]`))
  const templates = root.templates.map((entry, index) => parseTemplate(entry, `templates[${index}]`))
  const canonical = canonicalData(categories, templates)
  if (typeof root.data_sha256 !== 'string') throw new Error('data_sha256 must be a string')
  const expected = dataHash(canonical)
  if (root.data_sha256 !== expected) throw new Error(`data_sha256 mismatch (expected ${expected})`)
  return {
    ...canonical,
    data_sha256: expected,
    ...(typeof root.exported_at === 'string' ? { exported_at: root.exported_at } : {}),
    ...(typeof root.source === 'string' ? { source: root.source } : {}),
  }
}

export function createSnapshot(categories: readonly CategoryView[], templates: readonly TemplateView[], metadata: { exported_at?: string; source?: string } = {}): DataSnapshot {
  const canonical = canonicalData(categories, templates)
  return { ...canonical, data_sha256: dataHash(canonical), ...metadata }
}

export function canonicalJson(snapshot: DataSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

export function diffSnapshots(left: DataSnapshot, right: DataSnapshot): DiffResult {
  const leftById = new Map(left.templates.map(item => [item.id, item]))
  const rightById = new Map(right.templates.map(item => [item.id, item]))
  const onlyLeft = left.templates.filter(item => !rightById.has(item.id))
  const onlyRight = right.templates.filter(item => !leftById.has(item.id))
  const changed: Array<{ id: string; name: string; fields: string[]; left: TemplateView; right: TemplateView }> = []
  for (const [id, l] of leftById) {
    const r = rightById.get(id)
    if (r === undefined) continue
    const fields = TEMPLATE_KEYS.filter(key => l[key] !== r[key])
    if (fields.length > 0) changed.push({ id, name: l.name, fields: [...fields], left: l, right: r })
  }
  const leftNames = idsByName(left.templates)
  const rightNames = idsByName(right.templates)
  const nameConflicts: Array<{ name: string; left_ids: string[]; right_ids: string[] }> = []
  for (const name of new Set([...leftNames.keys(), ...rightNames.keys()])) {
    const a = leftNames.get(name) ?? []
    const b = rightNames.get(name) ?? []
    if (a.length > 0 && b.length > 0 && a.join('\0') !== b.join('\0')) nameConflicts.push({ name, left_ids: a, right_ids: b })
  }
  const leftCategoryKeys = new Set(left.categories.map(categoryKey))
  const rightCategoryKeys = new Set(right.categories.map(categoryKey))
  const categoryOnlyLeft = left.categories.filter(item => !rightCategoryKeys.has(categoryKey(item)))
  const categoryOnlyRight = right.categories.filter(item => !leftCategoryKeys.has(categoryKey(item)))
  const identical = onlyLeft.length === 0 && onlyRight.length === 0 && changed.length === 0 && categoryOnlyLeft.length === 0 && categoryOnlyRight.length === 0
  return {
    identical,
    templates: { left: left.templates.length, right: right.templates.length, only_left: onlyLeft, only_right: onlyRight, changed, name_conflicts: nameConflicts },
    categories: { left: left.categories.length, right: right.categories.length, only_left: categoryOnlyLeft, only_right: categoryOnlyRight },
  }
}

export function mergeSnapshots(base: DataSnapshot, incoming: DataSnapshot, strategy: MergeStrategy, allowNameConflicts = false): MergeResult {
  const conflicts: MergeConflict[] = []
  const selected = new Map(base.templates.map(item => [item.id, item]))
  let inserted = 0
  let incomingSelected = 0
  let baseSelected = 0
  for (const item of incoming.templates) {
    const current = selected.get(item.id)
    if (current === undefined) { selected.set(item.id, item); inserted++; continue }
    if (sameTemplate(current, item)) continue
    if (strategy === 'keep-base') { baseSelected++; continue }
    if (strategy === 'keep-incoming') { selected.set(item.id, item); incomingSelected++; continue }
    const leftTime = timestamp(current.updated_at)
    const rightTime = timestamp(item.updated_at)
    if (leftTime === null || rightTime === null) {
      conflicts.push({ kind: 'invalid-timestamp', message: `template ${item.id} has an invalid updated_at`, ids: [item.id] })
    } else if (leftTime === rightTime) {
      conflicts.push({ kind: 'same-time-different-content', message: `template ${item.id} differs at the same updated_at`, ids: [item.id] })
    } else if (rightTime > leftTime) {
      selected.set(item.id, item); incomingSelected++
    } else baseSelected++
  }
  const mergedTemplates = [...selected.values()]
  // Historical same-name rows already present in both snapshots are not a
  // new merge conflict (session-scoped templates may legitimately share a
  // label). Block only when the two inputs disagree on that name's ID set.
  if (!allowNameConflicts) {
    for (const conflict of diffSnapshots(base, incoming).templates.name_conflicts) {
      conflicts.push({
        kind: 'same-name-different-id',
        message: `template name ${JSON.stringify(conflict.name)} resolves to different ids across inputs`,
        ids: [...new Set([...conflict.left_ids, ...conflict.right_ids])].sort(),
      })
    }
  }
  const categories = new Map<string, CategoryView>()
  for (const item of [...base.categories, ...incoming.categories]) categories.set(categoryKey(item), item)
  const summary = { templates: mergedTemplates.length, categories: categories.size, inserted, incoming_selected: incomingSelected, base_selected: baseSelected }
  if (conflicts.length > 0) return { conflicts, summary }
  return { snapshot: createSnapshot([...categories.values()], mergedTemplates, { source: `merge:${strategy}` }), conflicts, summary }
}

function canonicalData(categories: readonly CategoryView[], templates: readonly TemplateView[]): Pick<DataSnapshot, 'schema_version' | 'categories' | 'templates'> {
  const sortedCategories = categories.map(item => ({ ...item })).sort((a, b) => categoryKey(a).localeCompare(categoryKey(b)))
  const sortedTemplates = templates.map(item => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id))
  return { schema_version: SNAPSHOT_SCHEMA_VERSION, categories: sortedCategories, templates: sortedTemplates }
}

function dataHash(data: Pick<DataSnapshot, 'schema_version' | 'categories' | 'templates'>): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

function parseCategory(value: unknown, label: string): CategoryView {
  const item = object(value, label)
  exactKeys(item, CATEGORY_KEYS, label)
  const name = nonEmpty(item.name, `${label}.name`)
  const scope = parseScope(item.scope, `${label}.scope`)
  const sessionId = nullableString(item.session_id, `${label}.session_id`)
  scopeSession(scope, sessionId, label)
  return { name, scope, session_id: sessionId }
}

function parseTemplate(value: unknown, label: string): TemplateView {
  const item = object(value, label)
  exactKeys(item, TEMPLATE_KEYS, label)
  const scope = parseScope(item.scope, `${label}.scope`)
  const sessionId = nullableString(item.session_id, `${label}.session_id`)
  scopeSession(scope, sessionId, label)
  if (!Number.isInteger(item.position) || Number(item.position) < 0) throw new Error(`${label}.position must be a non-negative integer`)
  return {
    id: nonEmpty(item.id, `${label}.id`),
    name: nonEmpty(item.name, `${label}.name`),
    content: nonEmpty(item.content, `${label}.content`),
    scope,
    session_id: sessionId,
    description: nullableString(item.description, `${label}.description`),
    position: Number(item.position),
    category: nullableString(item.category, `${label}.category`),
    created_at: nonEmpty(item.created_at, `${label}.created_at`),
    updated_at: nonEmpty(item.updated_at, `${label}.updated_at`),
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) throw new Error(`${label} has unknown fields: ${extras.join(', ')}`)
}
function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}
function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null`)
  return value
}
function parseScope(value: unknown, label: string): 'global' | 'session' {
  if (value !== 'global' && value !== 'session') throw new Error(`${label} must be global or session`)
  return value
}
function scopeSession(scope: 'global' | 'session', sessionId: string | null, label: string): void {
  if (scope === 'global' && sessionId !== null) throw new Error(`${label}: global scope must have null session_id`)
  if (scope === 'session' && (sessionId === null || sessionId === '')) throw new Error(`${label}: session scope requires session_id`)
}
function categoryKey(item: CategoryView): string { return `${item.scope}\0${item.session_id ?? ''}\0${item.name}` }
function idsByName(items: readonly TemplateView[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const item of items) map.set(item.name, [...map.get(item.name) ?? [], item.id].sort())
  return map
}
function sameTemplate(left: TemplateView, right: TemplateView): boolean { return TEMPLATE_KEYS.every(key => left[key] === right[key]) }
function timestamp(value: string): number | null {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(parsed) ? parsed : null
}
