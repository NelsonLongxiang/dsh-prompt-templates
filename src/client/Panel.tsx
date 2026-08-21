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
import { IconEditOutline16, IconGlobeOutline14, IconPlusOutline16, IconQueueOutline14, IconSendOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CategoryView, TemplateView } from '../types.ts'
import type { PromptPanelFace, PanelPosition } from './slots.ts'
import { createPromptPanelStore } from './store.ts'
import type { PromptTemplateKey } from './locales.ts'
import css from './Panel.module.css'

/** One template row: click the body to insert at the caret, interject/send/
 * edit/delete icons beside; the make-global action appears only on
 * session-scoped rows. Every row control suppresses mousedown default so
 * the composer textarea keeps its focus and selection. The row is also
 * drag-sortable within its list (HTML5 DnD; the drop handler reorders). */
interface RowProps {
  template: TemplateView
  onInsert: (content: string) => void
  onSend: (content: string) => void
  onInterject: (content: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onMakeGlobal?: (id: string) => void
  onDragStart: (id: string) => void
  onDropOn: (id: string) => void
  t: (key: PromptTemplateKey) => string
}

function TemplateRow({ template, onInsert, onSend, onInterject, onEdit, onDelete, onMakeGlobal, onDragStart, onDropOn, t }: RowProps) {
  return (
    <div
      className={css.row}
      data-prompt-template
      onMouseDown={(e) => { e.preventDefault() }}
      draggable
      onDragStart={() => { onDragStart(template.id) }}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropOn(template.id) }}
    >
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
        className={css.interjectBtn}
        onClick={() => { onInterject(template.content) }}
        aria-label={t('panel.interject')}
        title={t('panel.interject')}
      >
        <IconQueueOutline14 size={12} />
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

/** The template inline form: creation (with scope + category pickers) and in-place edit. */
function TemplateForm({ initial, allowScope, sessionId, categories, t, submitLabel, onSubmit, onDone }: {
  initial?: { name: string; content: string }
  allowScope: boolean
  sessionId: string | null
  categories: readonly CategoryView[]
  t: (key: PromptTemplateKey) => string
  submitLabel: string
  onSubmit: (name: string, content: string, scope: 'global' | 'session', category: string | null) => Promise<boolean>
  onDone: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const [category, setCategory] = useState<string | null>(null)
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
    const ok = await onSubmit(trimmedName, trimmedContent, scope, category)
    setBusy(false)
    if (!ok) {
      setError(t('panel.error'))
      return
    }
    onDone()
  }, [name, content, scope, category, allowScope, sessionId, onSubmit, t, onDone])

  // Categories selectable for the CURRENT scope pick (matching partition).
  const scopeCategories = categories.filter(
    (cat) => cat.scope === scope && (cat.scope === 'global' || cat.session_id === sessionId),
  )

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
            <select value={scope} onChange={(e) => { setScope(e.target.value as 'global' | 'session'); setCategory(null) }} aria-label="scope">
              <option value="global">{t('panel.global')}</option>
              <option value="session" disabled={sessionId === null}>{t('panel.session')}</option>
            </select>
          </label>
        )}
        <label className={css.scopeLabel}>
          <select
            value={category ?? ''}
            onChange={(e) => { setCategory(e.target.value === '' ? null : e.target.value) }}
            aria-label={t('panel.category')}
          >
            <option value="">{t('panel.categoryNone')}</option>
            {scopeCategories.map((cat) => <option key={`${cat.scope}:${cat.name}`} value={cat.name}>{cat.name}</option>)}
          </select>
        </label>
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
    useStore, useSessions, refresh, refreshCategories, createCategory, removeCategory,
    create, update, remove, makeGlobal,
    insert, send, interject,
    panelPosition, savePanelPosition, resetPanelPosition,
    actions, t,
  } = props
  const open = useStore(s => s.open)
  const currentSession = useSessions(s => s.current)
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [categories, setCategories] = useState<CategoryView[]>([])
  const [showAdd, setShowAdd] = useState(false)
  // Live search filter over name + content, case-insensitive.
  const [query, setQuery] = useState('')
  // In-place editing: the id whose row swaps to the edit form, null = none.
  const [editingId, setEditingId] = useState<string | null>(null)
  // Active tab: 'global' / 'session' (the implicit default tabs) or
  // `cat:<scope>:<name>` for one user-created category tab.
  const [activeTab, setActiveTab] = useState<string>('global')
  const [showCatForm, setShowCatForm] = useState(false)
  // Row drag-sort: the id currently being dragged (HTML5 DnD).
  const dragRowRef = useRef<string | null>(null)
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

  const loadCategories = useCallback(async () => {
    setCategories(await refreshCategories())
  }, [refreshCategories])

  useEffect(() => {
    if (open) { void load(); void loadCategories() }
  }, [open, load, loadCategories])

  const handleInsert = useCallback((content: string) => {
    if (sessionId === null) return
    insert(sessionId, content)
  }, [insert, sessionId])

  const handleSend = useCallback((content: string) => {
    if (sessionId === null) return
    send(sessionId, content)
  }, [send, sessionId])

  const handleInterject = useCallback((content: string) => {
    if (sessionId === null) return
    interject(sessionId, content)
  }, [interject, sessionId])

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

  // The full set is loaded; filtering happens here. The search query
  // narrows by name + content, case-insensitive.
  const needle = query.trim().toLowerCase()
  const matches = (row: TemplateView): boolean =>
    needle === ''
    || row.name.toLowerCase().includes(needle)
    || row.content.toLowerCase().includes(needle)

  // Visible user-category tabs: global ones always, session ones only for
  // the current session.
  const visibleCategories = categories.filter(
    (cat) => cat.scope === 'global' || (cat.scope === 'session' && cat.session_id === sessionId),
  )
  const activeCategory = activeTab.startsWith('cat:')
    ? visibleCategories.find((cat) => `cat:${cat.scope}:${cat.name}` === activeTab)
    : undefined
  // A deleted (or no-longer-visible) category tab falls back to 全局.
  const effectiveTab = activeTab.startsWith('cat:') && activeCategory === undefined ? 'global' : activeTab

  // The active tab decides the visible partition; rows sort by position.
  const tabRows = templates.filter((row) => {
    if (!matches(row)) return false
    if (effectiveTab === 'global') return row.scope === 'global' && row.category === null
    if (effectiveTab === 'session') return row.scope === 'session' && row.session_id === sessionId && row.category === null
    return activeCategory !== undefined
      && row.category === activeCategory.name
      && row.scope === activeCategory.scope
      && (activeCategory.scope === 'global' || row.session_id === sessionId)
  })

  // Drop one dragged row onto another: reorder within the tab by writing the
  // full position sequence back (idempotent and partition-local).
  const handleRowDrop = (targetId: string): void => {
    const draggedId = dragRowRef.current
    dragRowRef.current = null
    if (draggedId === null || draggedId === targetId) return
    const ids = tabRows.map((row) => row.id)
    const from = ids.indexOf(draggedId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    void (async () => {
      await Promise.all(ids.map((id, index) => update(id, { position: index })))
      void load()
    })()
  }

  /** One list row: the edit form while being edited, the rendered row otherwise. */
  const renderTemplateRow = (row: TemplateView) => (
    editingId === row.id
      ? (
        <TemplateForm
          key={row.id}
          initial={{ name: row.name, content: row.content }}
          allowScope={false}
          sessionId={sessionId}
          categories={visibleCategories}
          t={t}
          submitLabel={t('panel.addSave')}
          onSubmit={async (name, content, _scope, category) => (await update(row.id, { name, content, category: row.scope === 'global' ? category : category })).ok}
          onDone={() => { setEditingId(null); void load() }}
        />
      )
      : (
        <TemplateRow
          key={row.id}
          template={row}
          onInsert={(c) => { handleInsert(c) }}
          onSend={(c) => { handleSend(c) }}
          onInterject={(c) => { handleInterject(c) }}
          onEdit={(id) => { setEditingId(id) }}
          onDelete={(id) => { void handleRemove(id) }}
          onMakeGlobal={row.scope === 'session' ? (id) => { void handleMakeGlobal(id) } : undefined}
          onDragStart={(id) => { dragRowRef.current = id }}
          onDropOn={(id) => { handleRowDrop(id) }}
          t={t}
        />
      )
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
      <div className={css.tabsBar}>
        <button
          type="button"
          className={effectiveTab === 'global' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setActiveTab('global') }}
        >
          {t('panel.global')}
        </button>
        <button
          type="button"
          className={effectiveTab === 'session' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setActiveTab('session') }}
          disabled={sessionId === null}
        >
          {t('panel.session')}
        </button>
        {visibleCategories.map((cat) => {
          const key = `cat:${cat.scope}:${cat.name}`
          return (
            <span key={key} className={effectiveTab === key ? `${css.tab} ${css.tabActive}` : css.tab}>
              <button type="button" onClick={() => { setActiveTab(key) }}>
                {cat.name}
              </button>
              <button
                type="button"
                className={css.tabDelete}
                aria-label={t('panel.deleteCategory')}
                title={t('panel.deleteCategory')}
                onClick={() => {
                  void (async () => {
                    const result = await removeCategory(cat.name, cat.scope, cat.session_id)
                    if (result.ok) { if (effectiveTab === key) setActiveTab('global'); void loadCategories(); void load() }
                  })()
                }}
              >
                ×
              </button>
            </span>
          )
        })}
        <button
          type="button"
          className={css.tabAdd}
          aria-label={t('panel.newCategory')}
          title={t('panel.newCategory')}
          onClick={() => { setShowCatForm(v => !v) }}
        >
          <IconPlusOutline16 size={10} />
        </button>
      </div>
      {showCatForm && (
        <CategoryForm
          sessionId={sessionId}
          createCategory={createCategory}
          t={t}
          onDone={() => { setShowCatForm(false); void loadCategories() }}
        />
      )}
      <div className={css.body}>
        {templates.length === 0 && !showAdd && (
          <div className={css.empty}>{t('panel.empty')}</div>
        )}
        {templates.length > 0 && needle !== '' && tabRows.length === 0 && (
          <div className={css.empty}>{t('panel.noMatch')}</div>
        )}
        {tabRows.length > 0 && (
          <div className={css.group} onDragOver={(e) => { e.preventDefault() }}>
            {tabRows.map(row => renderTemplateRow(row))}
          </div>
        )}
        {showAdd && (
          <TemplateForm
            sessionId={sessionId}
            categories={visibleCategories}
            t={t}
            allowScope
            submitLabel={t('panel.addSave')}
            onSubmit={async (name, content, scope, category) => {
              const result = await create({
                name,
                content,
                scope,
                session_id: scope === 'session' ? sessionId : null,
                category,
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

/** Inline form creating one category tab: name + scope (global, or the current session). */
function CategoryForm({ sessionId, createCategory, t, onDone }: {
  sessionId: string | null
  createCategory: (request: { name: string, scope: 'global' | 'session', session_id: string | null }) => Promise<{ ok: boolean }>
  t: (key: PromptTemplateKey) => string
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed === '') return
    if (scope === 'session' && sessionId === null) { setError(t('panel.error')); return }
    setBusy(true)
    setError(null)
    const result = await createCategory({
      name: trimmed,
      scope,
      session_id: scope === 'session' ? sessionId : null,
    })
    setBusy(false)
    if (!result.ok) { setError(t('panel.error')); return }
    onDone()
  }

  return (
    <div className={css.addForm} data-prompt-category-add>
      <input
        className={css.nameInput}
        type="text"
        placeholder={t('panel.categoryName')}
        value={name}
        onChange={(e) => { setName(e.target.value) }}
        aria-label={t('panel.categoryName')}
      />
      <div className={css.addRow}>
        <label className={css.scopeLabel}>
          <select value={scope} onChange={(e) => { setScope(e.target.value as 'global' | 'session') }} aria-label="scope">
            <option value="global">{t('panel.global')}</option>
            <option value="session" disabled={sessionId === null}>{t('panel.session')}</option>
          </select>
        </label>
        <div className={css.addActions}>
          {error !== null && <span className={css.error} role="alert">{error}</span>}
          <button type="button" className={css.saveBtn} onClick={() => void submit()} disabled={busy || name.trim() === ''}>
            {t('panel.addSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
