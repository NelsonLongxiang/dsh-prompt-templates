/**
 * Quick prompt panel: the right-anchored floating surface registered into
 * shell.overlay. The shell owns only placement (drag-by-title, persisted
 * position) and visibility; the template library itself — search, tabs,
 * rows, forms, footer — is the shared TemplateLibrary component, also
 * mounted by the right-sidebar tab. The current session arrives through
 * the composer entry attachment (targetSession), never the session list.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelPosition, PromptPanelFace, TemplateLibraryFace } from './slots.ts'
import { TemplateLibrary } from './Library.tsx'
import { createPromptPanelStore } from './store.ts'
import css from './Panel.module.css'

const PANEL_WIDTH = 320

/**
 * Clamp a restored panel position into the current viewport so a placement
 * saved on a wider screen (or a monitor that is no longer attached) can never
 * render the panel unreachable off-screen. Null passes through untouched.
 * @param position - the persisted placement, if any.
 * @returns the clamped placement.
 */
function clampToViewport(position: PanelPosition | null): PanelPosition | null {
  if (position === null) return null
  const maxX = Math.max(0, window.innerWidth - PANEL_WIDTH)
  const maxY = Math.max(0, window.innerHeight - 40)
  return {
    x: Math.min(Math.max(position.x, 0), maxX),
    y: Math.min(Math.max(position.y, 0), maxY),
  }
}

/** Full props of the shell.overlay panel entry. */
export type PromptPanelProps =
  PropsRuntime<'shell.overlay'>
  & PromptPanelFace
  & PropsStore<ReturnType<typeof createPromptPanelStore>>
  & PropsLocale<'promptTemplates'>

/**
 * The prompt-templates floating panel shell.
 * @param props - runtime kit, injected face members, store handle, and locale.
 */
export function PromptPanel(props: PromptPanelProps) {
  const {
    useStore, refresh, refreshCategories, createCategory, removeCategory,
    create, update, remove, makeGlobal,
    insert, send, interject, targetSession, targetVersion, subscribeTarget,
    panelPosition, savePanelPosition, resetPanelPosition,
    actions, t,
  } = props
  const open = useStore(s => s.open)
  // Re-render whenever the delivery target changes: the composer entry
  // attaches its session whenever its composer becomes the visible one, so
  // switching conversations bumps the version and the open panel re-reads
  // the target. Without this the panel's handlers keep the previous
  // render's sessionId closure and sends after a switch land nowhere.
  useSyncExternalStore(subscribeTarget, targetVersion)
  // Delivery target: the composer entry attachment, never the session list.
  // The 0.2.0 session list has no selection field (SessionListState.current
  // is gone), so guessing ids[0] would target the newest list row — a
  // foreign session on any busy host.
  const currentSession = targetSession()
  const sessionId = currentSession ?? null

  // Drag placement: seeded from the persisted position, live-updated while
  // dragging, committed to the settings document on release. A null with no
  // drag in flight keeps the CSS right-anchored default. The restored value
  // is clamped into the current viewport: a position saved on a wider screen
  // or a second monitor would otherwise render the panel off-screen forever.
  const persisted = clampToViewport(panelPosition())
  const [dragPos, setDragPos] = useState<PanelPosition | null>(null)
  const dragRef = useRef<{ pointerId: number; offX: number; offY: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Drag-by-title: capture the pointer, track the offset, clamp so the
  // header always stays reachable inside the viewport, commit on release.
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    const panel = panelRef.current
    if (panel === null) return
    const rect = panel.getBoundingClientRect()
    dragRef.current = { pointerId: event.pointerId, offX: event.clientX - rect.left, offY: event.clientY - rect.top }
    // jsdom lacks the pointer-capture API; feature-detect before using it.
    if (Reflect.has(event.currentTarget, 'setPointerCapture')) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    const width = panelRef.current?.getBoundingClientRect().width ?? PANEL_WIDTH
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - 40)
    const x = Math.min(Math.max(event.clientX - drag.offX, 0), maxX)
    const y = Math.min(Math.max(event.clientY - drag.offY, 0), maxY)
    setDragPos({ x, y })
  }

  const onHeaderPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (Reflect.has(event.currentTarget, 'releasePointerCapture')) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dragPos !== null) savePanelPosition(dragPos)
  }

  // Double-click the title to forget the placement and re-anchor right.
  const onHeaderDoubleClick = (): void => {
    setDragPos(null)
    resetPanelPosition()
  }

  if (!open) return null

  const placement = dragPos ?? persisted
  // With bottom:auto the fixed panel's height is content-driven, so a long
  // list would stretch past the viewport with no internal scroll. Cap the
  // height at (viewport - top - margin); the flex column + body's
  // min-height/overflow then keeps the list scrolling inside the panel.
  const placementStyle = placement === null
    ? undefined
    : {
        left: placement.x,
        top: placement.y,
        right: 'auto',
        bottom: 'auto',
        maxHeight: `calc(100vh - ${placement.y}px - 16px)`,
      } as const

  // The library verbs are the face minus the overlay-only placement knobs.
  const libraryFace: TemplateLibraryFace = {
    refresh, refreshCategories, createCategory, removeCategory,
    create, update, remove, makeGlobal,
    insert, send, interject,
  }

  return (
    <div className={css.panel} data-prompt-panel ref={panelRef} style={placementStyle}>
      <TemplateLibrary
        sessionId={sessionId}
        face={libraryFace}
        t={t}
        header={{
          onPointerDown: onHeaderPointerDown,
          onPointerMove: onHeaderPointerMove,
          onPointerUp: onHeaderPointerUp,
          onDoubleClick: onHeaderDoubleClick,
          hint: t('panel.dragHint'),
        }}
        headerExtra={(
          <button
            type="button"
            className={css.closeBtn}
            onClick={() => { actions.close() }}
            aria-label={t('panel.close')}
          >
            ×
          </button>
        )}
      />
    </div>
  )
}
