import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CategoryView } from '../types.ts'

/** One apply-owned observable shared across root and session-scoped surfaces. */
export interface LibrarySelection {
  subscribe: (notify: () => void) => () => void
  tab: (sessionId: string | null) => string
  select: (sessionId: string | null, tab: string) => void
}

interface Selection { sessionId: string; tab: string }
interface LibraryState { recent: Selection[] }
const LIMIT = 100

/** Accept only the tab grammar owned by the library; persisted storage is untrusted. */
function validTab(tab: unknown): tab is string {
  return typeof tab === 'string' && tab.length <= 140 && (tab === 'global' || tab === 'session' || /^cat:(global|session):.+$/s.test(tab))
}

/** A deleted or foreign category must never restore another session's private view. */
export function resolveLibraryTab(tab: string, categories: readonly CategoryView[], sessionId: string | null): string {
  if (!validTab(tab) || (tab === 'session' && sessionId === null)) return 'global'
  if (!tab.startsWith('cat:')) return tab
  return categories.some(cat =>
    `cat:${cat.scope}:${cat.name}` === tab && (cat.scope === 'global' || cat.session_id === sessionId)
  ) ? tab : 'global'
}

/**
 * Controller-owned bare engine store (not a slot StoreHandle.create()). Both scopes
 * consume the same observable through their injected face, without cross-scope seats.
 * Recency is array order, not wall-clock time: visits and selections both count.
 */
export function createLibrarySelection(): LibrarySelection {
  const store = createSnapshotStore<LibraryState>({ recent: [] }, { persist: { name: 'prompt-templates.library' } })
  const raw: unknown = store.getSnapshot()
  const stored = raw !== null && typeof raw === 'object' && 'recent' in raw ? raw.recent : undefined
  const recent: Selection[] = []
  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (item !== null && typeof item === 'object' && typeof item.sessionId === 'string' && validTab(item.tab)
        && !recent.some(entry => entry.sessionId === item.sessionId)) {
        recent.push({ sessionId: item.sessionId, tab: item.tab })
        if (recent.length === LIMIT) break
      }
    }
  }
  // Strip corrupt/oversized persisted data before any subscriber observes it.
  store.set({ recent })
  return {
    subscribe: store.subscribe,
    tab: sessionId => sessionId === null ? 'global' : store.getSnapshot().recent.find(item => item.sessionId === sessionId)?.tab ?? 'global',
    select: (sessionId, tab) => {
      if (sessionId === null || !validTab(tab)) return
      store.update(d => {
        if (d.recent[0]?.sessionId === sessionId && d.recent[0].tab === tab) return
        d.recent = [{ sessionId, tab }, ...d.recent.filter(item => item.sessionId !== sessionId)].slice(0, LIMIT)
      })
    },
  }
}
