import { useEffect, useState } from 'react'
import type { SystemPromptPreview, SystemLessonReason } from '../types.ts'
import type { PromptTemplateKey } from './locales.ts'
import { getSystemPromptPreview } from './api.ts'
import css from './Panel.module.css'

const reasons: Record<SystemLessonReason, PromptTemplateKey> = {
  'master-off': 'panel.reasonMasterOff', 'depth-zero': 'panel.reasonDepthZero',
  'unapproved-type': 'panel.reasonUnapproved', 'legacy-untyped': 'panel.reasonLegacy',
  'no-lessons': 'panel.reasonNoLessons', untagged: 'panel.reasonUntagged',
  'no-right': 'panel.reasonNoRight', 'depth-limit': 'panel.reasonDepth',
  'balance-limit': 'panel.reasonBalance', budget: 'panel.reasonBudget',
}
const status: Record<SystemPromptPreview['status'], PromptTemplateKey> = {
  ready: 'panel.previewReady', disabled: 'panel.previewDisabled', empty: 'panel.previewEmpty', unavailable: 'panel.previewUnavailable',
}

/** Mounted with a session key; late responses are discarded on refresh, session switch or close. */
export function SystemPreview({ sessionId, t, load = getSystemPromptPreview }: {
  sessionId: string
  t: (key: PromptTemplateKey) => string
  load?: (id: string) => Promise<SystemPromptPreview | null>
}) {
  const [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<SystemPromptPreview | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setView(null); setLoading(true)
    void load(sessionId).then(result => {
      if (!cancelled) { setView(result?.session_id === sessionId ? result : null); setLoading(false) }
    }).catch(() => { if (!cancelled) { setView(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [sessionId, refresh, load])
  return <section className={css.systemPreview} data-system-preview aria-label={t('panel.previewTitle')}>
    <p>{t('panel.previewHint')}</p>
    <button type="button" onClick={() => { setRefresh(value => value + 1) }} disabled={loading}>{t('panel.previewRefresh')}</button>
    {loading ? <p role="status">{t('panel.previewLoading')}</p> : !view ? <p role="alert">{t('panel.previewError')}</p> : <>
      <p role="status">{t(status[view.status])}</p>
      <div>{t('panel.previewTime')}: {view.captured_at}</div>
      <div>{t('panel.previewChars')}: {view.chars} / {view.max_chars}</div>
      <div>{t('panel.previewDepth')}: {view.lesson_depth} · {t('panel.previewOrder')}: {view.order}</div>
      {view.budget_applied && <p>{t('panel.previewBudget')}</p>}
      <textarea readOnly rows={6} value={view.text} aria-label={t('panel.previewText')} />
      <div className={css.previewTable}><table><thead><tr>
        <th>{t('panel.previewType')}</th><th>{t('panel.previewAvailable')}</th><th>{t('panel.previewIncluded')}</th><th>{t('panel.previewReasons')}</th>
      </tr></thead><tbody>{view.lessons.map(summary => <tr key={summary.type}>
        <td>{summary.type}</td><td>{summary.right}/{summary.wrong}/{summary.untagged}</td>
        <td>{summary.included_right}/{summary.included_wrong}</td>
        <td>{summary.reasons.length ? summary.reasons.map(reason => t(reasons[reason])).join('；') : t('panel.previewSelected')}</td>
      </tr>)}</tbody></table></div>
    </>}
  </section>
}
