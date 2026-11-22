/**
 * §5.16 lesson ribbon, the overlay half: an always-on ribbon hung just under the conversation header (where the header
 * knot measured it). It rolls through the session's lessons one at a time, ROTATE_MS each; a lesson just written,
 * rewritten or kept jumps the queue for FRESH_MS; hovering holds it. Wrong is hazard tape, right is a sash, untagged is
 * plain; a tab hangs below with the latest evidence. It can be collapsed to a thin band, remembered per session in
 * this browser. Reduced motion: no sway, no roll, the text just changes.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { changedLesson, clearTabStrips, FRESH_MS, measureTabStrips, dwellMs, marqueeMs, nextIndex, orderRibbon, splitLanes, pickAnchor, POLL_MS, readCollapsed, writeCollapsed, type RibbonAnchor, type RibbonBus, type RibbonLesson, type RibbonState } from './ribbon.ts'
import { loadRibbonLessons } from './ribbon-data.ts'
import { DOCK_ATTR, findDock, placeDock } from './ribbon-dock.ts'
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

/**
 * Text that scrolls sideways when it does not fit (owner 2026-11-22「文本显示不全时，需要滚动」): pause, scroll to the
 * end, pause, back; it reports one pass's length so the lane waits for it. Text that fits stays still. Reduced motion:
 * no scrolling, the ellipsis and the hover title remain.
 */
function Marquee({ text, className, onPass }: { text: string; className: string | undefined; onPass: (ms: number) => void }) {
  const box = useRef<HTMLSpanElement>(null)
  const run = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const measure = (): void => {
      const outer = box.current, inner = run.current
      if (outer === null || inner === null) return
      const overflow = inner.offsetWidth - outer.clientWidth
      setShift(overflow > 1 ? overflow : 0)
      onPass(marqueeMs(overflow))
    }
    measure()
    if (typeof ResizeObserver === 'undefined' || box.current === null) return
    const observer = new ResizeObserver(measure)
    observer.observe(box.current)
    return () => { observer.disconnect() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  const ms = marqueeMs(shift)
  const style = ms > 0 ? { ['--marquee-shift' as string]: `-${String(shift)}px`, ['--marquee-ms' as string]: `${String(ms)}ms` } : undefined
  return (
    <span ref={box} className={ms > 0 ? `${className ?? ''} ${css.scrolling ?? ''}` : className} style={style} data-lesson-ribbon-marquee={ms > 0 ? 'on' : 'off'}>
      <span ref={run} className={css.run}>{text}</span>
    </span>
  )
}

interface Jump { readonly id: string; readonly seq: number }

/**
 * One lane: the lessons of one outcome, rolling on their own clock. Owner 2026-11-22: wrong and right hang side by side
 * (the header is wide enough), each lane in its own colours; a lane wraps under the other when the header is narrow.
 */
function Lane({ lessons, jump, onFold, t }: { lessons: readonly RibbonLesson[]; jump: Jump | null; onFold: (() => void) | null } & Pick<LessonRibbonProps, 't'>) {
  const [index, setIndex] = useState(0)
  const [roll, setRoll] = useState(0)
  const [unfurl, setUnfurl] = useState(0)
  const [hover, setHover] = useState(false)
  const holdUntil = useRef(0)

  // A lesson just written, rewritten or kept in this lane jumps its queue.
  useEffect(() => {
    if (jump === null) return
    const at = lessons.findIndex(l => l.id === jump.id)
    if (at >= 0) { setIndex(at); holdUntil.current = Date.now() + FRESH_MS; setUnfurl(n => n + 1) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq])
  useEffect(() => { if (index >= lessons.length) setIndex(0) }, [index, lessons.length])

  // Each lesson stays ROTATE_MS, or until its text and evidence have scrolled through once; a fresh one holds FRESH_MS.
  const [scroll, setScroll] = useState<{ text: number; tab: number }>({ text: 0, tab: 0 })
  const dwell = dwellMs([scroll.text, scroll.tab])
  useEffect(() => {
    if (lessons.length < 2 || hover) return
    const timer = setTimeout(() => {
      setIndex(i => nextIndex(i, lessons.length))
      setRoll(n => n + 1)
    }, Math.max(dwell, holdUntil.current - Date.now()))
    return () => { clearTimeout(timer) }
  }, [hover, lessons.length, dwell, roll, unfurl])

  const at = Math.min(index, lessons.length - 1)
  const lesson = lessons[at]!
  const kind = lesson.outcome === 'wrong' ? css.hazard : lesson.outcome === 'right' ? css.sash : css.plain
  const tag = lesson.outcome === 'wrong' ? t('panel.lessonWrong') : lesson.outcome === 'right' ? t('panel.lessonRight') : null
  const noEvidence = lesson.evidence === null
  // A lesson without evidence has no tab to wait for.
  useEffect(() => { if (noEvidence) setScroll(v => (v.tab === 0 ? v : { ...v, tab: 0 })) }, [lesson.id, noEvidence])
  return (
    <div className={`${css.ribbon} ${kind}`} data-lesson-ribbon-lane={lesson.outcome ?? 'plain'} onMouseEnter={() => { setHover(true) }} onMouseLeave={() => { setHover(false) }}>
      <div key={`band-${String(unfurl)}`} className={unfurl > 0 ? `${css.band} ${css.unfurl}` : css.band} title={lesson.content}>
        <div key={`face-${String(roll)}-${lesson.id}`} className={css.face}>
          <span className={css.sign} aria-hidden="true">{lesson.outcome === 'wrong' ? '!' : lesson.outcome === 'right' ? '✓' : '·'}</span>
          <span className={css.tag}>{tag === null ? lesson.key : `${lesson.key} · ${tag}`}</span>
          <Marquee text={lesson.content} className={css.text} onPass={ms => { setScroll(v => (v.text === ms ? v : { ...v, text: ms })) }} />
        </div>
        {lessons.length > 1 && (
          <span className={css.pager} aria-label={t('ribbon.position').replace('{i}', String(at + 1)).replace('{n}', String(lessons.length))}>
            {lessons.map((l, i) => <i key={l.id} className={i === at ? css.dotOn : css.dot} />)}
            <span>{at + 1}/{lessons.length}</span>
          </span>
        )}
        {onFold !== null && (
          <button type="button" className={css.fold} onClick={onFold} aria-label={t('ribbon.collapse')} title={t('ribbon.collapse')} data-lesson-ribbon-fold>
            ▴
          </button>
        )}
      </div>
      {lesson.evidence !== null
        ? <div key={`tab-${lesson.id}-${String(roll)}`} className={css.tabRow}><Marquee text={lesson.evidence} className={css.tab} onPass={ms => { setScroll(v => (v.tab === ms ? v : { ...v, tab: ms })) }} /></div>
        : null}
    </div>
  )
}

export function LessonRibbon({ bus, targetSession, subscribeTarget, t }: LessonRibbonProps) {
  const state = useRibbonState(bus, targetSession, subscribeTarget)
  const lessons = orderRibbon(state.lessons)
  const lanes = splitLanes(lessons)
  const [collapsed, setCollapsed] = useState(false)
  const [jump, setJump] = useState<Jump | null>(null)
  const previous = useRef<{ sessionId: string | null; lessons: readonly RibbonLesson[] | null }>({ sessionId: null, lessons: null })

  // Per-session collapse choice.
  useEffect(() => { setCollapsed(state.sessionId === null ? false : readCollapsed(storage(), state.sessionId)) }, [state.sessionId])

  // A new or changed lesson jumps its lane's queue; a session switch remounts the lanes without a jump.
  useEffect(() => {
    const prev = previous.current
    const sameSession = prev.sessionId === state.sessionId
    const changed = changedLesson(sameSession ? prev.lessons : null, lessons)
    previous.current = { sessionId: state.sessionId, lessons }
    if (sameSession && changed !== null) setJump(j => ({ id: changed, seq: (j?.seq ?? 0) + 1 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Owner 2026-11-22: the ribbon is part of the header, stacked under the tabs. Dock our own container there every
  // render (the header can re-render or move); without a header the floating ribbon below is the fallback.
  const show = state.sessionId !== null && lessons.length > 0
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [dock, setDock] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const spot = show && typeof document !== 'undefined' ? findDock(state.origin, document) : null
    if (spot === null) { dockRef.current?.remove(); if (dock !== null) setDock(null); return }
    if (dockRef.current === null) {
      const el = document.createElement('div')
      el.setAttribute(DOCK_ATTR, '')
      el.style.gridColumn = '1 / -1'
      dockRef.current = el
    }
    placeDock(dockRef.current, spot)
    if (dock !== dockRef.current) setDock(dockRef.current)
  })
  useEffect(() => () => { dockRef.current?.remove() }, [])

  // Nothing to show only when there is no session or no lesson; a missing anchor falls back to the viewport top.
  if (!show || state.sessionId === null) return null
  // Cleared again here: the knot's published anchor can be up to a second old, and the fallbacks never were.
  const anchor = clearTabStrips(state.anchor ?? pickAnchor([], window.innerWidth).anchor, measureTabStrips(document))
  const sessionId = state.sessionId
  const setFold = (value: boolean): void => { setCollapsed(value); writeCollapsed(storage(), sessionId, value) }
  const docked = dock !== null
  const style = docked ? undefined : { left: anchor.left, top: anchor.top, width: anchor.width }
  const sky = `${css.sky}${docked ? ` ${css.docked}` : ''}`
  const where = docked ? 'dock' : state.anchorSource ?? 'header'
  const laneKind = (outcome: RibbonLesson['outcome']): string => (outcome === 'wrong' ? css.hazard : outcome === 'right' ? css.sash : css.plain) ?? ''

  // Floating: hung on the document body so a transformed or clipping overlay ancestor cannot trap it.
  // Docked: into our container inside the header.
  const hang = (node: ReactNode): ReactNode => (typeof document === 'undefined' ? node : createPortal(node, dock ?? document.body))
  if (collapsed) {
    return hang(
      <div className={sky} style={style} data-lesson-ribbon="collapsed" data-lesson-ribbon-anchor={where}>
        <div className={css.lanes}>
          {lanes.map(lane => <div key={lane.outcome ?? 'plain'} className={`${css.thin} ${laneKind(lane.outcome)}`} />)}
        </div>
        <button type="button" className={css.unfold} onClick={() => { setFold(false) }} data-lesson-ribbon-unfold>
          {t('ribbon.expand')} ▾
        </button>
      </div>
    )
  }
  return hang(
    <div className={sky} style={style} data-lesson-ribbon="open" data-lesson-ribbon-anchor={where} aria-label={t('ribbon.title')}>
      <div className={css.lanes}>
        {lanes.map((lane, i) => (
          <Lane
            key={`${sessionId}-${lane.outcome ?? 'plain'}`}
            lessons={lane.lessons}
            jump={jump}
            onFold={i === lanes.length - 1 ? () => { setFold(true) } : null}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}
