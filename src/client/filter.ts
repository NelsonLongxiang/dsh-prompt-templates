import type { CategoryView, TemplateView } from '../types.ts'

/**
 * The category the host files lessons (体会) under (server `LESSON_CATEGORY`). Owner 2026-11-21 on 0.20.0: lessons did
 * not show in the 会话模板 tab — they sat only in their own 体会 tab. The session tab now lists them too; the 体会 tab stays.
 */
export const LESSON_TAB_CATEGORY = '体会'

/**
 * Filter the panel's rows. A non-empty query is global across every category
 * while respecting privacy: every global template and only the current
 * session's private templates are searchable. With no query, the active tab
 * keeps its normal partition/category semantics.
 */
/** All templates a search is allowed to inspect (global + current session). */
export function searchableTemplateRows(templates: readonly TemplateView[], sessionId: string | null): TemplateView[] {
  return templates.filter(row =>
    row.scope === 'global' || (row.scope === 'session' && row.session_id === sessionId),
  )
}

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
    return searchableTemplateRows(templates, sessionId).filter(matches)
  }

  return templates.filter((row) => {
    if (effectiveTab === 'global') return row.scope === 'global' && row.category === null
    if (effectiveTab === 'session') return row.scope === 'session' && row.session_id === sessionId && (row.category === null || row.category === LESSON_TAB_CATEGORY)
    return activeCategory !== undefined
      && row.category === activeCategory.name
      && row.scope === activeCategory.scope
      && (activeCategory.scope === 'global' || row.session_id === sessionId)
  })
}
