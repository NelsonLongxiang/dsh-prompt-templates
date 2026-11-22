/**
 * §5.16 lesson ribbon, the dock: the ribbon lives inside the conversation header, under the view tabs, so the header
 * and the ribbon read as one vertical block (owner 2026-11-22). The host's own nodes are never moved or restyled; one
 * container of ours is inserted after them. Without a header the ribbon keeps its floating fallback.
 */
import { planDock } from './ribbon.ts'

const TABS = '[data-conversation-tabs], [role="tablist"]'
export const DOCK_ATTR = 'data-lesson-ribbon-dock'

export interface DockSpot {
  readonly parent: Element
  /** Insert right after this element; null appends at the end of parent. */
  readonly after: Element | null
}

/** The conversation header the knot sits in, else the one on the page; then where the ribbon goes in it. */
export function findDock(origin: Element | null | undefined, doc: Pick<Document, 'querySelector'>): DockSpot | null {
  const header = origin?.closest('header')
    ?? doc.querySelector('[data-conversation-header-corner]')?.closest('header')
    ?? doc.querySelector('[data-conversation-tabs]')?.closest('header')
    ?? null
  if (header === null || header.parentElement === null) return null
  let next = header.nextElementSibling
  if (next !== null && next.hasAttribute(DOCK_ATTR)) next = next.nextElementSibling
  const nextHoldsTabs = next !== null && (next.matches(TABS) || next.querySelector(TABS) !== null)
  const gapToNext = next === null ? Number.POSITIVE_INFINITY : next.getBoundingClientRect().top - header.getBoundingClientRect().bottom
  const plan = planDock({ headerHoldsTabs: header.querySelector(TABS) !== null, nextHoldsTabs, gapToNext })
  return plan === 'afterNext' && next !== null ? { parent: header.parentElement, after: next } : { parent: header, after: null }
}

/** Put our container at the spot; nothing moves when it is already there. */
export function placeDock(dock: Element, spot: DockSpot): void {
  if (spot.after === null) {
    if (dock.parentElement !== spot.parent || dock.nextElementSibling !== null) spot.parent.appendChild(dock)
  } else if (dock.parentElement !== spot.parent || dock.previousElementSibling !== spot.after) {
    spot.parent.insertBefore(dock, spot.after.nextSibling)
  }
}
