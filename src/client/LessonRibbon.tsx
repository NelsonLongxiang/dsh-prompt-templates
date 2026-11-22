/**
 * §5.16 lesson ribbon, the overlay half: an always-on ribbon hung just under the conversation header (where the header
 * knot measured it). It rolls through the session's lessons one at a time, ROTATE_MS each; a lesson just written,
 * rewritten or kept jumps the queue for FRESH_MS; hovering holds it. Wrong is hazard tape, right is a sash, untagged is
 * plain; a tab hangs below with the latest evidence. It can be collapsed to a thin band, remembered per session in
 * this browser. Reduced motion: no sway, no roll, the text just changes.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { changedLesson, FRESH_MS, nextIndex, orderRibbon, readCollapsed, ROTATE_MS, writeCollapsed, type RibbonBus, type RibbonLesson } from './ribbon.ts'
import css from './Ribbon.module.css'

export interface LessonRibbonFace {
  readonly bus: RibbonBus
}

export type LessonRibbonProps = PropsRuntime<'shell.overlay'> & LessonRibbonFace & PropsLocale<'promptTemplates'>

const storage = (): Storage | undefined => { try { return window.localStorage } catch { return undefined } }

export function LessonRibbon({ bus, t }: LessonRibbonProps) {
  const state = useSyncExternalStore(bus.subscribe, bus.get, bus.get)
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

  if (state.anchor === null || state.sessionId === null || lessons.length === 0) return null
  const lesson = lessons[Math.min(index, lessons.length - 1)]!
  const kind = lesson.outcome === 'wrong' ? css.hazard : lesson.outcome === 'right' ? css.sash : css.plain
  const sessionId = state.sessionId
  const setFold = (value: boolean): void => { setCollapsed(value); writeCollapsed(storage(), sessionId, value) }
  const tag = lesson.outcome === 'wrong' ? t('panel.lessonWrong') : lesson.outcome === 'right' ? t('panel.lessonRight') : null
  const style = { left: state.anchor.left, top: state.anchor.top, width: state.anchor.width }

  if (collapsed) {
    return (
      <div className={`${css.sky} ${kind}`} style={style} data-lesson-ribbon="collapsed">
        <div className={css.thin} />
        <button type="button" className={css.unfold} onClick={() => { setFold(false) }} data-lesson-ribbon-unfold>
          {t('ribbon.expand')} ▾
        </button>
      </div>
    )
  }
  return (
    <div className={`${css.sky} ${kind}`} style={style} data-lesson-ribbon="open" aria-label={t('ribbon.title')}>
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
