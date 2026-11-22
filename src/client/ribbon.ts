/**
 * §5.16 lesson ribbon, the logic half: the shared state between the header knot (session-scoped, fetches the
 * session's lessons and measures where the conversation header ends) and the overlay ribbon (root-scoped, draws the
 * always-on ribbon there). Pure functions here are what the tests cover; the components only render them.
 */

/** One lesson as the ribbon shows it. */
export interface RibbonLesson {
  readonly id: string
  /** The type (or legacy number) after 体会·. */
  readonly key: string
  readonly content: string
  readonly outcome: 'wrong' | 'right' | null
  /** The latest evidence: the last keep after the last write, else the write's own; null hides the hanging tab. */
  readonly evidence: string | null
  /** Changes whenever the text or the evidence changes: a write, a rewrite or a keep. */
  readonly stamp: string
}

/** Where the ribbon hangs: just under the conversation header, as wide as it. Viewport pixels. */
export interface RibbonAnchor {
  readonly left: number
  readonly top: number
  readonly width: number
}

export interface RibbonState {
  readonly sessionId: string | null
  readonly lessons: readonly RibbonLesson[]
  readonly anchor: RibbonAnchor | null
}

/** Each lesson stays this long before the next one rolls up. */
export const ROTATE_MS = 6000
/** A lesson just written, rewritten or kept jumps the queue and stays this long first. */
export const FRESH_MS = 10000
/** How often the header knot refreshes the session's lessons. */
export const POLL_MS = 10000

const CHAIN = ['收', '放', '找', '落', '验', '记', '续']

/** The ribbon's order: the chain 收→续, then approved types, then legacy numbered lessons; ties keep their order. */
export function orderRibbon(lessons: readonly RibbonLesson[]): RibbonLesson[] {
  const rank = (lesson: RibbonLesson): number => {
    const chain = CHAIN.indexOf(lesson.key)
    return chain >= 0 ? chain : /^\d+$/.test(lesson.key) ? 1000 : 100
  }
  return lessons.map((lesson, index) => ({ lesson, index })).sort((a, b) => rank(a.lesson) - rank(b.lesson) || a.index - b.index).map(({ lesson }) => lesson)
}

/**
 * The lesson that just changed between two snapshots of the same session: new, rewritten, or kept with new evidence.
 * Null on the first snapshot (nothing jumps the queue when the ribbon first appears) and when nothing changed; the
 * last changed one when several did.
 */
export function changedLesson(previous: readonly RibbonLesson[] | null, next: readonly RibbonLesson[]): string | null {
  if (previous === null) return null
  const before = new Map(previous.map(lesson => [lesson.id, lesson.stamp]))
  let changed: string | null = null
  for (const lesson of next) if (before.get(lesson.id) !== lesson.stamp) changed = lesson.id
  return changed
}

/** Counts for the header knot. */
export function ribbonCounts(lessons: readonly RibbonLesson[]): { wrong: number; right: number; total: number } {
  return { wrong: lessons.filter(l => l.outcome === 'wrong').length, right: lessons.filter(l => l.outcome === 'right').length, total: lessons.length }
}

/** The index to show after `index`, wrapping. */
export function nextIndex(index: number, total: number): number {
  return total <= 0 ? 0 : (index + 1) % total
}

const COLLAPSE_PREFIX = 'dsh-prompt-templates:ribbon-collapsed:'

/** Whether this session's ribbon was collapsed in this browser. Storage can be missing or refuse: then expanded. */
export function readCollapsed(storage: Pick<Storage, 'getItem'> | undefined, sessionId: string): boolean {
  try { return storage?.getItem(COLLAPSE_PREFIX + sessionId) === '1' } catch { return false }
}

/** Remember this session's choice in this browser; a refusing storage is ignored. */
export function writeCollapsed(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, sessionId: string, collapsed: boolean): void {
  try {
    if (collapsed) storage?.setItem(COLLAPSE_PREFIX + sessionId, '1')
    else storage?.removeItem(COLLAPSE_PREFIX + sessionId)
  } catch { /* private mode or blocked storage: the choice just is not remembered */ }
}

/** The shared state the knot publishes and the overlay draws. One per client. */
export class RibbonBus {
  #state: RibbonState = { sessionId: null, lessons: [], anchor: null }
  readonly #listeners = new Set<() => void>()

  get = (): RibbonState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Replace the state for one session (the visible conversation's knot). */
  publish(state: RibbonState): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }

  /** The knot of this session unmounted: hide the ribbon unless another session took over meanwhile. */
  release(sessionId: string): void {
    if (this.#state.sessionId === sessionId) this.publish({ sessionId: null, lessons: [], anchor: null })
  }
}
