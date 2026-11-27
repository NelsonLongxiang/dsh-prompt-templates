/** Host lifecycle for opt-in workshop synchronization. No OS scheduler, no remote-triggered writes. */
import type { Context } from '@deepseek-ai/cordis'
import type { TemplateStore } from './store.ts'
import { DEFAULT_WORKSHOP_SYNC, syncWorkshop, type WorkshopSyncConfig, type WorkshopSyncResult } from './workshop-sync.ts'
export { DEFAULT_WORKSHOP_SYNC }

export function registerWorkshopSync(ctx: Context, store: () => TemplateStore, readConfig: () => WorkshopSyncConfig, run = syncWorkshop, timers = { set: setTimeout, clear: clearTimeout }) {
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined, disposed = false
  let controller: AbortController | undefined
  let last: WorkshopSyncResult | null = null
  let configuration = JSON.stringify(readConfig())
  const status = () => ({ enabled: readConfig().enabled, running: !!active, last })
  const start = () => {
    if (disposed || active || !readConfig().enabled) return
    const config = { ...readConfig() }
    controller = new AbortController()
    active = (async () => {
      last = await run(config, store, undefined, controller!.signal)
      // Preserve one last result across host restarts. No result body includes paths or command diagnostics.
      if (!disposed) { try { store().saveWorkshopSyncResult(last) } catch { last = { ...last, status: 'error', error: 'result-persistence-failed' } } }
    })().catch(() => {
      last = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), commit: null, status: 'error', added: [], updated: [], skipped: [], error: 'sync-failed' }
    }).finally(() => {
      active = undefined; controller = undefined
      if (!disposed && readConfig().enabled) timer = timers.set(start, Math.max(1, Math.min(1440, readConfig().intervalMinutes)) * 60000)
      timer?.unref?.()
    })
  }
  const reconcile = () => {
    const next = JSON.stringify(readConfig())
    if (next === configuration) return
    configuration = next
    if (timer) { timers.clear(timer); timer = undefined }
    if (active) controller?.abort()
    if (!readConfig().enabled) return
    start()
  }
  ctx.on('settings/document-updated' as never, reconcile as never)
  ctx.effect(() => {
    if (readConfig().enabled) {
      try { last = store().workshopSyncResult() } catch { /* next run reports persistence issues */ }
      start()
    }
    return async () => { disposed = true; if (timer) timers.clear(timer); controller?.abort(); await active }
  }, 'prompt-templates: workshop sync lifecycle')
  return { status }
}
