import { useEffect, useState } from 'react'
import type { WorkshopSyncStatus } from '../types.ts'
import type { PromptTemplateKey } from './locales.ts'
import { getWorkshopSyncStatus } from './api.ts'
import css from './Panel.module.css'

/** Read-only observation; no automatic writes or run-now action. */
export function WorkshopSync({ t, load = getWorkshopSyncStatus }: { t: (key: PromptTemplateKey) => string; load?: () => Promise<WorkshopSyncStatus | null> }) {
  const [view, setView] = useState<WorkshopSyncStatus | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false, sequence = 0
    const read = async () => { const current = ++sequence; try { const value = await load(); if (!cancelled && current === sequence) setView(value) } catch { if (!cancelled && current === sequence) setView(null) } }
    void read()
    const timer = setInterval(() => { void read() }, 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [load, refresh])
  const last = view?.last
  return <section className={css.systemPreview} data-workshop-sync aria-label={t('panel.syncTitle')}>
    <p>{t('panel.syncReadOnly')}</p>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('panel.syncRefresh')}</button>
    <p role="status">{!view ? t('panel.syncUnavailable') : !view.enabled ? t('panel.syncDisabled') : view.running ? t('panel.syncRunning') : !last ? t('panel.syncNone') : last.status === 'ok' ? t('panel.syncOK') : last.status === 'skipped' ? t('panel.syncSkip') : t('panel.syncFailed')}</p>
    {last && <>
      <div>{t('panel.syncLast')}: {last.finished_at ?? last.started_at}</div>
      <div>{t('panel.syncCommit')}: {last.commit ?? '—'}</div>
      {last.error && <p role="alert">{t('panel.syncError')}: {last.error}</p>}
      {(['added','updated','skipped'] as const).map(kind => <div key={kind}>
        <strong>{t(kind === 'added' ? 'panel.syncAdded' : kind === 'updated' ? 'panel.syncUpdated' : 'panel.syncSkipped')} ({last[kind].length})</strong>
        <ul>{last[kind].map((entry, index) => <li key={index}>{entry.category ? entry.category + ' / ' : ''}{entry.name}{entry.reason ? ' — ' + entry.reason : ''}</li>)}</ul>
      </div>)}
    </>}
  </section>
}
