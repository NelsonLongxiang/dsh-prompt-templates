import type { TemplateView } from '../types.ts'

/** Plan before any write: active global rows require the separate owner risk workflow. */
export function planTemplateReorder(rows: readonly TemplateView[], draggedId: string, targetId: string): { blocked: boolean; changes: Array<{ id: string; position: number }> } {
  const ids = rows.map(row => row.id), from = ids.indexOf(draggedId), to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return { blocked: false, changes: [] }
  ids.splice(to, 0, ...ids.splice(from, 1))
  const changes = ids.map((id, position) => ({ id, position })).filter(change => rows.find(row => row.id === change.id)?.position !== change.position)
  const blocked = changes.some(change => rows.some(row => row.id === change.id && row.scope === 'global' && row.system_prompt))
  return { blocked, changes: blocked ? [] : changes }
}
