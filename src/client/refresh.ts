/**
 * Keep the template library current while it stays mounted (owner 2026-11-21: a self-check template or a lesson the
 * model wrote with its tools never showed in the session tab). The library used to read the rows once on mount, and
 * the sidebar tab stays mounted for the whole conversation, so rows the agent wrote server-side never arrived. This
 * re-reads on a timer, when the window regains focus, and when the page becomes visible again.
 * @module @nelsonlongxiang/dsh-prompt-templates/client/refresh
 */

/** How often the mounted library re-reads its rows, in milliseconds. */
export const LIBRARY_REFRESH_MS = 15_000

/** The event sources the refresh listens to; the browser's `window` and `document` in production. */
export interface RefreshTargets {
  readonly window?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  readonly document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly visibilityState?: string }
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

/**
 * Start re-reading. `reload` is called on every tick, on window focus and when the document turns visible; never while
 * it is hidden. Returns the stop function for an effect cleanup.
 */
export function startLibraryRefresh(reload: () => void, targets: RefreshTargets = defaultTargets(), intervalMs = LIBRARY_REFRESH_MS): () => void {
  const doc = targets.document
  const visible = (): boolean => doc?.visibilityState === undefined || doc.visibilityState === 'visible'
  const tick = (): void => { if (visible()) reload() }
  const onVisibility = (): void => { if (visible()) reload() }
  const set = targets.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms))
  const clear = targets.clearInterval ?? ((handle: unknown) => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) })
  const handle = set(tick, intervalMs)
  targets.window?.addEventListener('focus', tick)
  doc?.addEventListener('visibilitychange', onVisibility)
  return () => {
    clear(handle)
    targets.window?.removeEventListener('focus', tick)
    doc?.removeEventListener('visibilitychange', onVisibility)
  }
}

function defaultTargets(): RefreshTargets {
  const g = globalThis as { window?: RefreshTargets['window']; document?: RefreshTargets['document'] }
  return { window: g.window, document: g.document }
}
