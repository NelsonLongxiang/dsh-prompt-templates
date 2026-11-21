/**
 * B1b (owner 2026-11-21, option 甲): the panel asks the session to propose a
 * pinned lesson as a taste rule. The plugin never calls taste-loop itself:
 * the session proposes with its own `taste__update` (workbench-market MCP
 * gateway) or `taste_update` (local plugin), so the session is the author and
 * taste-loop's two independent non-author endorsements still decide.
 *
 * The ask is INSERTED into the composer, never sent: the owner reads it first.
 * Pure function so the wording contract is unit-testable without a DOM.
 * @module dsh-prompt-templates/client/taste-ask
 */

/** What the panel knows about the lesson row. */
export interface TasteAskLesson {
  /** Template name, `体会·<type>` (legacy `体会·N` falls through as-is). */
  readonly name: string
  readonly content: string
  readonly evidence: string | null
  readonly rounds?: { readonly opened: number; readonly closed: number; readonly kept?: number }
  readonly recurrence?: { readonly before: { readonly hits: number; readonly fails: number }; readonly after: { readonly hits: number; readonly fails: number } }
}

const LESSON_PREFIX = '体会·'

/** The lesson's type from its template name (`体会·验` → `验`). */
export function lessonTypeOf(name: string): string {
  return name.startsWith(LESSON_PREFIX) ? name.slice(LESSON_PREFIX.length) : name
}

/**
 * Fill the localized ask. Single-pass replacement, so braces inside the
 * lesson text or evidence are never re-expanded.
 * @param template - the `panel.tasteAsk` locale string.
 * @param lesson - the row's lesson facts.
 * @param none - the locale word for a missing value.
 */
export function buildTasteAsk(template: string, lesson: TasteAskLesson, none: string): string {
  const rounds = lesson.rounds ?? { opened: 0, closed: 0, kept: 0 }
  const after = lesson.recurrence?.after ?? { hits: 0, fails: 0 }
  const values: Record<string, string> = {
    type: lessonTypeOf(lesson.name),
    content: lesson.content.trim(),
    evidence: lesson.evidence === null || lesson.evidence.trim() === '' ? none : lesson.evidence.trim(),
    opened: String(rounds.opened),
    closed: String(rounds.closed),
    kept: String(rounds.kept ?? 0),
    afterFails: String(after.fails),
    afterHits: String(after.hits),
  }
  return template.replace(/\{(type|content|evidence|opened|closed|kept|afterFails|afterHits)\}/g, (_, key: string) => values[key] ?? '')
}
