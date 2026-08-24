import type { CategoryView, TemplateView } from '../types.ts'

/**
 * Filter the panel's rows. A non-empty query is global across every category
 * while respecting privacy: every global template and only the current
 * session's private templates are searchable. With no query, the active tab
 * keeps its normal partition/category semantics.
 */
export function filterTemplateRows(
  templates: readonly TemplateView[],
  query: string,
  effectiveTab: string,
  activeCategory: CategoryView | undefined,
  sessionId: string | null,
): TemplateView[] {
  const needle = query.trim().toLowerCase()
  const matches = (row: TemplateView): boolean =>
    row.name.toLowerCase().includes(needle) || row.content.toLowerCase().includes(needle)

  if (needle !== '') {
    return templates.filter(row =>
      matches(row)
      && (row.scope === 'global' || (row.scope === 'session' && row.session_id === sessionId)),
    )
  }

  return templates.filter((row) => {
    if (effectiveTab === 'global') return row.scope === 'global' && row.category === null
    if (effectiveTab === 'session') return row.scope === 'session' && row.session_id === sessionId && row.category === null
    return activeCategory !== undefined
      && row.category === activeCategory.name
      && row.scope === activeCategory.scope
      && (activeCategory.scope === 'global' || row.session_id === sessionId)
  })
}
