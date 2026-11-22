/**
 * §5.16 lesson ribbon, the overlay half: an always-on ribbon hung just under the conversation header (where the header
 * knot measured it). It rolls through the session's lessons one at a time, ROTATE_MS each; a lesson just written,
 * rewritten or kept jumps the queue for FRESH_MS; hovering holds it. Wrong is hazard tape, right is a sash, untagged is
 * plain; a tab hangs below with the latest evidence. It can be collapsed to a thin band, remembered per session in
 * this browser. Reduced motion: no sway, no roll, the text just changes.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { changedLesson, FRESH_MS, nextIndex, orderRibbon, pickAnchor, POLL_MS, readCollapsed, ROTATE_MS, writeCollapsed, type RibbonAnchor, type RibbonBus, type RibbonLesson, type RibbonState } from './ribbon.ts'
import { loadRibbonLessons } from './ribbon-data.ts'
import css from './Ribbon.module.css'

export interface LessonRibbonFace {
  readonly bus: RibbonBus
  /** The session the composer entry attached (fallback when no header knot published one). */
  readonly targetSession: () => string | null
  readonly subscribeTarget: (notify: () => void) => () => void
}

export type LessonRibbonProps = PropsRuntime<'shell.overlay'> & LessonRibbonFace & PropsLocale<'promptTemplates'>

const storage = (): Storage | undefined => { try { return window.localStorage } catch { return undefined } }

/** Fallback position without the knot: under the block that holds the conversation's view tabs, if any. */
function tabsAnchor(): RibbonAnchor | null {
  const tabs = document.querySelector('[data-conversation-tabs]')
  const block = tabs?.parentElement?.parentElement ?? tabs?.parentElement ?? null
  if (block == null) return null
  const rect = block.getBoundingClientRect()
  return { left: rect.left, top: rect.bottom, width: rect.width }
}

/**
 * Real-host fix (owner 2026-11-22: the ribbon did not render): the knot is the preferred source, but the ribbon no
 * longer depends on it. Without a knot it uses the composer's session, fetches the lessons itself and places itself
 * under the view tabs, else at the viewport top.
 */
function useRibbonState(bus: RibbonBus, targetSession: () => string | null, subscribeTarget: (notify: () => void) => () => void): RibbonState {
  const published = useSyncExternalStore(bus.subscribe, bus.get, bus.get)
  const target = useSyncExternalStore(subscribeTarget, targetSession, targetSession)
  const [own, setOwn] = useState<{ sessionId: string | null; lessons: readonly RibbonLesson[] }>({ sessionId: null, lessons: [] })
  const [, setTick] = useState(0)
  const fallback = published.sessionId === null ? target : null
  useEffect(() => {
    if (fallback === null) return
    let alive = true
    const refresh = async (): Promise<void> => {
      try { const lessons = await loadRibbonLessons(fallback); if (alive) setOwn({ sessionId: fallback, lessons }) } catch { /* keep the last snapshot */ }
    }
    void refresh()
    const poll = setInterval(() => { void refresh() }, POLL_MS)
    const reflow = (): void => { setTick(n => n + 1) }
    const place = setInterval(reflow, 1000)
    window.addEventListener('resize', reflow)
    return () => { alive = false; clearInterval(poll); clearInterval(place); window.removeEventListener('resize', reflow) }
  }, [fallback])
  if (published.sessionId !== null) {
    if (published.anchor !== null) return published
    const picked = pickAnchor([{ source: 'header', anchor: tabsAnchor() }], window.innerWidth)
    return { ...published, anchor: picked.anchor, anchorSource: picked.source }
  }
  if (fallback === null || own.sessionId !== fallback) return { sessionId: null, lessons: [], anchor: null }
  const picked = pickAnchor([{ source: 'header', anchor: tabsAnchor() }], window.innerWidth)
  return { sessionId: fallback, lessons: own.lessons, anchor: picked.anchor, anchorSource: picked.source }
}

export function LessonRibbon({ bus, targetSession, subscribeTarget, t }: LessonRibbonProps) {
  const state = useRibbonState(bus, targetSession, subscribeTarget)
  const lessons = orderRibbon(state.lessons)
  const [index, setIndex] = useState(0)
  const [roll, setRoll] = useState(0)
  const [unfurl, setUnfurl] = useState(0)
  const [hover, setHover] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const holdUntil = useRef(0)
  const previous = useRef<{ sessionId: string | null; lessons: readonly RibbonLesson[] | null }>({ sessionId: null, lessons: null })

  // Per-session collapse choice.
  useEffect(() => { setCollapsed(state.sessionId === null ? false : readCollapsed(storage(), state.sessionId)) }, [state.sessionId])

  // A new or changed lesson jumps the queue; a session switch starts from the first lesson without a jump.
  useEffect(() => {
    const prev = previous.current
    const sameSession = prev.sessionId === state.sessionId
    const changed = changedLesson(sameSession ? prev.lessons : null, lessons)
    previous.current = { sessionId: state.sessionId, lessons }
    if (!sameSession) { setIndex(0); return }
    if (changed !== null) {
      const at = lessons.findIndex(l => l.id === changed)
      if (at >= 0) { setIndex(at); holdUntil.current = Date.now() + FRESH_MS; setUnfurl(n => n + 1) }
    } else if (index >= lessons.length) setIndex(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    if (lessons.length < 2) return
    const timer = setInterval(() => {
      if (hover || Date.now() < holdUntil.current) return
      setIndex(i => nextIndex(i, lessons.length))
      setRoll(n => n + 1)
    }, ROTATE_MS)
    return () => { clearInterval(timer) }
  }, [hover, lessons.length])

  // Nothing to show only when there is no session or no lesson; a missing anchor falls back to the viewport top.
  if (state.sessionId === null || lessons.length === 0) return null
  const anchor = state.anchor ?? pickAnchor([], window.innerWidth).anchor
  const lesson = lessons[Math.min(index, lessons.length - 1)]!
  const kind = lesson.outcome === 'wrong' ? css.hazard : lesson.outcome === 'right' ? css.sash : css.plain
  const sessionId = state.sessionId
  const setFold = (value: boolean): void => { setCollapsed(value); writeCollapsed(storage(), sessionId, value) }
  const tag = lesson.outcome === 'wrong' ? t('panel.lessonWrong') : lesson.outcome === 'right' ? t('panel.lessonRight') : null
  const style = { left: anchor.left, top: anchor.top, width: anchor.width }

  // Hung on the document body: a transformed or clipping overlay ancestor must not trap a fixed-position ribbon.
  const hang = (node: ReactNode): ReactNode => (typeof document === 'undefined' ? node : createPortal(node, document.body))
  if (collapsed) {
    return hang(
      <div className={`${css.sky} ${kind}`} style={style} data-lesson-ribbon="collapsed" data-lesson-ribbon-anchor={state.anchorSource ?? 'header'}>
        <div className={css.thin} />
        <button type="button" className={css.unfold} onClick={() => { setFold(false) }} data-lesson-ribbon-unfold>
          {t('ribbon.expand')} ▾
        </button>
      </div>
    )
  }
  return hang(
    <div className={`${css.sky} ${kind}`} style={style} data-lesson-ribbon="open" data-lesson-ribbon-anchor={state.anchorSource ?? 'header'} aria-label={t('ribbon.title')}>
      <div className={css.ribbon} onMouseEnter={() => { setHover(true) }} onMouseLeave={() => { setHover(false) }}>
        <div key={`band-${String(unfurl)}`} className={unfurl > 0 ? `${css.band} ${css.unfurl}` : css.band} title={lesson.content}>
          <div key={`face-${String(roll)}-${lesson.id}`} className={css.face}>
            <span className={css.sign} aria-hidden="true">{lesson.outcome === 'wrong' ? '!' : lesson.outcome === 'right' ? '✓' : '·'}</span>
            <span className={css.tag}>{tag === null ? lesson.key : `${lesson.key} · ${tag}`}</span>
            <span className={css.text}>{lesson.content}</span>
          </div>
          {lessons.length > 1 && (
            <span className={css.pager} aria-label={t('ribbon.position').replace('{i}', String(index + 1)).replace('{n}', String(lessons.length))}>
              {lessons.map((l, i) => <i key={l.id} className={i === index ? css.dotOn : css.dot} />)}
              <span>{index + 1}/{lessons.length}</span>
            </span>
          )}
          <button type="button" className={css.fold} onClick={() => { setFold(true) }} aria-label={t('ribbon.collapse')} title={t('ribbon.collapse')} data-lesson-ribbon-fold>
            ▴
          </button>
        </div>
        {lesson.evidence !== null && <div key={`tab-${lesson.id}-${String(roll)}`} className={css.tab}>{lesson.evidence}</div>}
      </div>
    </div>
  )
}
