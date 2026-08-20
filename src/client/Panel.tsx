/**
 * Quick prompt panel: the right-anchored floating surface registered into
 * shell.overlay. Lists global templates plus the current session's private
 * ones; clicking a row inserts its content into the composer draft. The
 * injected face carries the CRUD verbs and insert; the panel store holds
 * visibility; the current session arrives through the standard kit.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconEditOutline16, IconGlobeOutline14, IconPlusOutline16, IconSendOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TemplateView } from '../types.ts'
import type { PromptPanelFace, PanelPosition } from './slots.ts'
import { createPromptPanelStore } from './store.ts'
import type { PromptTemplateKey } from './locales.ts'
import css from './Panel.module.css'

/** One template row: click the body to append, send/edit/delete icons beside;
 * the make-global action appears only on session-scoped rows. */
interface RowProps {
  template: TemplateView
  onInsert: (content: string) => void
  onSend: (content: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onMakeGlobal?: (id: string) => void
  t: (key: PromptTemplateKey) => string
}

function TemplateRow({ template, onInsert, onSend, onEdit, onDelete, onMakeGlobal, t }: RowProps) {
  return (
    <div className={css.row} data-prompt-template>
      <button
        type="button"
        className={css.insert}
        onClick={() => { onInsert(template.content) }}
        title={t('panel.insert')}
      >
        <span className={css.name}>{template.name}</span>
        <span className={css.preview}>{template.content}</span>
      </button>
      <button
        type="button"
        className={css.sendBtn}
        onClick={() => { onSend(template.content) }}
        aria-label={t('panel.sendNow')}
        title={t('panel.sendNow')}
      >
        <IconSendOutline16 size={12} />
      </button>
      {onMakeGlobal !== undefined && (
        <button
          type="button"
          className={css.globalBtn}
          onClick={() => { onMakeGlobal(template.id) }}
          aria-label={t('panel.makeGlobal')}
          title={t('panel.makeGlobal')}
        >
          <IconGlobeOutline14 size={12} />
        </button>
      )}
      <button
        type="button"
        className={css.editBtn}
        onClick={() => { onEdit(template.id) }}
        aria-label={t('panel.edit')}
        title={t('panel.edit')}
      >
        <IconEditOutline16 size={12} />
      </button>
      <button
        type="button"
        className={css.deleteBtn}
        onClick={() => { onDelete(template.id) }}
        aria-label={t('panel.delete')}
      >
        <IconTrashOutline16 size={12} />
      </button>
    </div>
  )
}

/** The template inline form: creation (with scope picker) and in-place edit. */
function TemplateForm({ initial, allowScope, sessionId, t, submitLabel, onSubmit, onDone }: {
  initial?: { name: string; content: string }
  allowScope: boolean
  sessionId: string | null
  t: (key: PromptTemplateKey) => string
  submitLabel: string
  onSubmit: (name: string, content: string, scope: 'global' | 'session') => Promise<boolean>
  onDone: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    const trimmedName = name.trim()
    const trimmedContent = content.trim()
    if (trimmedName === '' || trimmedContent === '') return
    if (allowScope && scope === 'session' && sessionId === null) {
      setError(t('panel.error'))
      return
    }
    setBusy(true)
    setError(null)
    const ok = await onSubmit(trimmedName, trimmedContent, scope)
    setBusy(false)
    if (!ok) {
      setError(t('panel.error'))
      return
    }
    onDone()
  }, [name, content, scope, allowScope, sessionId, onSubmit, t, onDone])

  return (
    <div className={css.addForm} data-prompt-add>
      <input
        className={css.nameInput}
        type="text"
        placeholder={t('panel.addName')}
        value={name}
        onChange={(e) => { setName(e.target.value) }}
        aria-label={t('panel.addName')}
      />
      <textarea
        className={css.contentInput}
        placeholder={t('panel.addContent')}
        value={content}
        onChange={(e) => { setContent(e.target.value) }}
        rows={3}
        aria-label={t('panel.addContent')}
      />
      <div className={css.addRow}>
        {allowScope && (
          <label className={css.scopeLabel}>
            <select value={scope} onChange={(e) => { setScope(e.target.value as 'global' | 'session') }} aria-label="scope">
              <option value="global">{t('panel.global')}</option>
              <option value="session" disabled={sessionId === null}>{t('panel.session')}</option>
            </select>
          </label>
        )}
        <div className={css.addActions}>
          {error !== null && <span className={css.error} role="alert">{error}</span>}
          <button type="button" className={css.saveBtn} onClick={() => void submit()} disabled={busy || name.trim() === '' || content.trim() === ''}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Panel width used for viewport clamping (mirrors the CSS `.panel` width). */
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
 * The prompt-templates panel body.
 * @param props - runtime kit, injected face members, store handle, and locale.
 */
export function PromptPanel(props: PromptPanelProps) {
  const {
    useStore, useSessions, refresh, create, update, remove, makeGlobal,
    insert, send,
    panelPosition, savePanelPosition, resetPanelPosition,
    actions, t,
  } = props
  const open = useStore(s => s.open)
  const currentSession = useSessions(s => s.current)
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [showAdd, setShowAdd] = useState(false)
  // Live search filter over name + content, case-insensitive.
  const [query, setQuery] = useState('')
  // In-place editing: the id whose row swaps to the edit form, null = none.
  const [editingId, setEditingId] = useState<string | null>(null)
  // Drag placement: seeded from the persisted position, live-updated while
  // dragging, committed to the settings document on release. A null with no
  // drag in flight keeps the CSS right-anchored default. The restored value
  // is clamped into the current viewport: a position saved on a wider screen
  // or a second monitor would otherwise render the panel off-screen forever.
  const persisted = clampToViewport(panelPosition())
  const [dragPos, setDragPos] = useState<PanelPosition | null>(null)
  const dragRef = useRef<{ pointerId: number; offX: number; offY: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const sessionId = currentSession ?? null

  const load = useCallback(async () => {
    const items = await refresh()
    setTemplates(items)
  }, [refresh])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const handleInsert = useCallback((content: string) => {
    if (sessionId === null) return
    insert(sessionId, content)
  }, [insert, sessionId])

  const handleSend = useCallback((content: string) => {
    if (sessionId === null) return
    send(sessionId, content)
  }, [send, sessionId])

  const handleRemove = useCallback(async (id: string) => {
    const result = await remove(id)
    if (result.ok) void load()
  }, [remove, load])

  const handleMakeGlobal = useCallback(async (id: string) => {
    const result = await makeGlobal(id)
    if (result.ok) void load()
  }, [makeGlobal, load])

  // Drag-by-header: capture the pointer, track the offset, clamp so the
  // header always stays reachable inside the viewport, commit on release.
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
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

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    const width = panelRef.current?.getBoundingClientRect().width ?? 320
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - 40)
    const x = Math.min(Math.max(event.clientX - drag.offX, 0), maxX)
    const y = Math.min(Math.max(event.clientY - drag.offY, 0), maxY)
    setDragPos({ x, y })
  }

  const onHeaderPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (Reflect.has(event.currentTarget, 'releasePointerCapture')) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dragPos !== null) savePanelPosition(dragPos)
  }

  // Double-click the header to forget the placement and re-anchor right.
  const onHeaderDoubleClick = (): void => {
    setDragPos(null)
    resetPanelPosition()
  }

  if (!open) return null

  // The full set is loaded; group here — a server-side session filter would
  // hide global rows (their session_id is NULL and never matches). The search
  // query narrows both groups by name + content, case-insensitive.
  const needle = query.trim().toLowerCase()
  const matches = (row: TemplateView): boolean =>
    needle === ''
    || row.name.toLowerCase().includes(needle)
    || row.content.toLowerCase().includes(needle)
  const globalRows = templates.filter(row => row.scope === 'global' && matches(row))
  /** One list row: the edit form while being edited, the rendered row otherwise. */
  const renderTemplateRow = (row: TemplateView) => (
    editingId === row.id
      ? (
        <TemplateForm
          key={row.id}
          initial={{ name: row.name, content: row.content }}
          allowScope={false}
          sessionId={sessionId}
          t={t}
          submitLabel={t('panel.addSave')}
          onSubmit={async (name, content) => (await update(row.id, { name, content })).ok}
          onDone={() => { setEditingId(null); void load() }}
        />
      )
      : (
        <TemplateRow
          key={row.id}
          template={row}
          onInsert={(c) => { handleInsert(c) }}
          onSend={(c) => { handleSend(c) }}
          onEdit={(id) => { setEditingId(id) }}
          onDelete={(id) => { void handleRemove(id) }}
          onMakeGlobal={row.scope === 'session' ? (id) => { void handleMakeGlobal(id) } : undefined}
          t={t}
        />
      )
  )
  const sessionRows = templates.filter(
    row => row.scope === 'session' && row.session_id === sessionId && matches(row),
  )
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

  return (
    <div className={css.panel} data-prompt-panel ref={panelRef} style={placementStyle}>
      <div
        className={css.header}
        title={t('panel.dragHint')}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onDoubleClick={onHeaderDoubleClick}
      >
        <span className={css.title}>{t('panel.title')}</span>
        <button
          type="button"
          className={css.closeBtn}
          onClick={() => { actions.close() }}
          aria-label={t('panel.close')}
        >
          ×
        </button>
      </div>
      <div className={css.searchBar}>
        <input
          type="search"
          className={css.searchInput}
          value={query}
          onChange={(e) => { setQuery(e.target.value) }}
          placeholder={t('panel.search')}
          aria-label={t('panel.search')}
        />
      </div>
      <div className={css.body}>
        {templates.length === 0 && !showAdd && (
          <div className={css.empty}>{t('panel.empty')}</div>
        )}
        {templates.length > 0 && needle !== '' && globalRows.length === 0 && sessionRows.length === 0 && (
          <div className={css.empty}>{t('panel.noMatch')}</div>
        )}
        {globalRows.length > 0 && (
          <div className={css.group}>
            <div className={css.groupTitle}>{t('panel.global')}</div>
            {globalRows.map(row => renderTemplateRow(row))}
          </div>
        )}
        {sessionRows.length > 0 && sessionId !== null && (
          <div className={css.group}>
            <div className={css.groupTitle}>{t('panel.session')}</div>
            {sessionRows.map(row => renderTemplateRow(row))}
          </div>
        )}
        {showAdd && (
          <TemplateForm
            sessionId={sessionId}
            t={t}
            allowScope
            submitLabel={t('panel.addSave')}
            onSubmit={async (name, content, scope) => {
              const result = await create({
                name,
                content,
                scope,
                session_id: scope === 'session' ? sessionId : null,
              })
              return result.ok
            }}
            onDone={() => { setShowAdd(false); void load() }}
          />
        )}
      </div>
      <div className={css.footer}>
        <button type="button" className={css.addBtn} onClick={() => { setShowAdd(v => !v) }}>
          <IconPlusOutline16 size={12} /> {t('panel.add')}
        </button>
      </div>
    </div>
  )
}
