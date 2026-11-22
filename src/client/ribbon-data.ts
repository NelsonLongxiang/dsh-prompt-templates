/** §5.16 lesson ribbon: fetch one session's lessons as the ribbon shows them (text joined from the templates route). */
import { listLessonPins, listTemplates } from './api.ts'
import type { RibbonLesson } from './ribbon.ts'

export async function loadRibbonLessons(sessionId: string): Promise<RibbonLesson[]> {
  const [items, templates] = await Promise.all([listLessonPins(sessionId), listTemplates()])
  const text = new Map(templates.map(t => [t.id, t.content]))
  return items.flatMap(item => {
    const content = text.get(item.id)
    if (content === undefined) return []
    return [{ id: item.id, key: item.key, content, outcome: item.outcome, evidence: item.latestEvidence, stamp: `${item.version ?? ''}|${content}|${item.latestEvidence ?? ''}` }]
  })
}
