/**
 * §5.16 lesson ribbon, the header half: a small knot appended to the conversation header's utilities. It fetches the
 * visible session's lessons, counts wrong and right, measures where the conversation header ends, and publishes all of
 * it to the ribbon bus; the overlay draws the ribbon there. Clicking the knot opens the panel on this session.
 */
import { useEffect, useRef, useState } from 'react'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { listLessonPins, listTemplates } from './api.ts'
import { POLL_MS, ribbonCounts, type RibbonAnchor, type RibbonBus, type RibbonLesson } from './ribbon.ts'
import css from './Ribbon.module.css'

/** The knot's injected face. */
export interface LessonKnotFace {
  readonly bus: RibbonBus
  /** Open the panel on this session (the 会话模板 tab lists the lessons). */
  readonly openPanel: (sessionId: string) => void
}

export type LessonKnotProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & LessonKnotFace
  & PropsLocale<'promptTemplates'>
  & { sessionId?: string | undefined }

/** Where the conversation header ends: the nearest ancestor that also holds the view tabs, else a wide ancestor. */
export function headerAnchor(from: HTMLElement): RibbonAnchor | null {
  let node: HTMLElement | null = from.parentElement
  let wide: HTMLElement | null = null
  while (node !== null && node !== document.body) {
    if (node.querySelector('[data-conversation-tabs]') !== null) { wide = node; break }
    if (wide === null && node.getBoundingClientRect().width >= 400) wide = node
    node = node.parentElement
  }
  if (wide === null) return null
  const rect = wide.getBoundingClientRect()
  return rect.width <= 0 ? null : { left: rect.left, top: rect.bottom, width: rect.width }
}

async function loadRibbonLessons(sessionId: string): Promise<RibbonLesson[]> {
  const [items, templates] = await Promise.all([listLessonPins(sessionId), listTemplates()])
  const text = new Map(templates.map(t => [t.id, t.content]))
  return items.flatMap(item => {
    const content = text.get(item.id)
    if (content === undefined) return []
    return [{ id: item.id, key: item.key, content, outcome: item.outcome, evidence: item.latestEvidence, stamp: `${item.version ?? ''}|${content}|${item.latestEvidence ?? ''}` }]
  })
}

export function LessonKnot({ bus, openPanel, sessionId, t }: LessonKnotProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [lessons, setLessons] = useState<readonly RibbonLesson[]>([])

  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadRibbonLessons(sessionId)
        if (alive) setLessons(next)
      } catch { /* an unreachable host keeps the last snapshot */ }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId])

  // Publish the lessons and the header's position; follow resizes and scrolls of the layout.
  useEffect(() => {
    if (sessionId === undefined) return
    const publish = (): void => {
      const el = ref.current
      bus.publish({ sessionId, lessons, anchor: el === null ? null : headerAnchor(el) })
    }
    publish()
    window.addEventListener('resize', publish)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    const host = ref.current?.parentElement
    if (observer !== null && host != null) observer.observe(host)
    const timer = setInterval(publish, 1000)
    return () => { window.removeEventListener('resize', publish); observer?.disconnect(); clearInterval(timer) }
  }, [bus, lessons, sessionId])
  useEffect(() => () => { if (sessionId !== undefined) bus.release(sessionId) }, [bus, sessionId])

  const counts = ribbonCounts(lessons)
  if (sessionId === undefined) return null
  // Mounted even with no lessons so the anchor is measurable; invisible until there is something to count.
  const title = t('ribbon.count').replace('{wrong}', String(counts.wrong)).replace('{right}', String(counts.right)).replace('{n}', String(counts.total))
  return (
    <button
      ref={ref}
      type="button"
      className={counts.total === 0 ? css.knotEmpty : css.knot}
      onClick={() => { openPanel(sessionId) }}
      title={title}
      aria-label={title}
      data-lesson-knot
    >
      <i className={css.knotWrong} aria-hidden="true" />{counts.wrong}
      <i className={css.knotRight} aria-hidden="true" />{counts.right}
    </button>
  )
}
