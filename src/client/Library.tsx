/**
 * The template library: the search bar, category tabs, row list, inline
 * forms, and footer shared by BOTH surfaces — the floating shell.overlay
 * panel and the right-sidebar tab body. This component owns the list state
 * (rows, categories, query, active tab, in-place edit) and loads on mount;
 * each host surface decides placement around it. The delivery target is
 * passed in as `sessionId` (the overlay reads it from its composer-entry
 * attachment; the sidebar tab reads it straight from its standard props).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconEditOutlineRegular, IconGlobeOutlineRegular, IconPlusOutlineRegular, IconQueueOutlineRegular, IconSendOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CategoryView, InjectionStatusView, TemplateInjectMode, TemplateView } from '../types.ts'
import type { TemplateLibraryFace } from './slots.ts'
import { filterTemplateRows, searchableTemplateRows } from './filter.ts'
import { GITHUB_REPOSITORY_URL, PLUGIN_VERSION, templateCountLabel } from './meta.ts'
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
  /** Flip the row's auto-inject switch (rows without an interval route to the edit form). */
  onToggleInject: (template: TemplateView) => void
  sortable: boolean
  onDragStart: (id: string) => void
  onDropOn: (id: string) => void
  t: (key: PromptTemplateKey) => string
}

function TemplateRow({ template, onInsert, onSend, onInterject, onEdit, onDelete, onMakeGlobal, onToggleInject, sortable, onDragStart, onDropOn, t }: RowProps) {
  const injectTitle = template.inject_enabled && template.inject_every !== null
    ? `${t('panel.inject')} · ${template.inject_every}${template.mode === 'visible' ? ' · ' + t('panel.modeVisible') : ''}`
    : t('panel.inject')
  return (
    <div
      className={css.row}
      data-prompt-template
      onMouseDown={(e) => { e.preventDefault() }}
      draggable={sortable}
      onDragStart={() => { if (sortable) onDragStart(template.id) }}
      onDragOver={(e) => { if (sortable) e.preventDefault() }}
      onDrop={(e) => { if (sortable) { e.preventDefault(); e.stopPropagation(); onDropOn(template.id) } }}
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
        className={template.inject_enabled ? css.injectBtnActive : css.injectBtn}
        onClick={() => { onToggleInject(template) }}
        aria-label={t('panel.inject')}
        aria-pressed={template.inject_enabled}
        title={injectTitle}
      >
        ⟳{template.inject_enabled && template.inject_every !== null ? template.inject_every : ''}
      </button>
      <button
        type="button"
        className={css.interjectBtn}
        onClick={() => { onInterject(template.content) }}
        aria-label={t('panel.interject')}
        title={t('panel.interject')}
      >
        <IconQueueOutlineRegular size={12} />
      </button>
      <button
        type="button"
        className={css.sendBtn}
        onClick={() => { onSend(template.content) }}
        aria-label={t('panel.sendNow')}
        title={t('panel.sendNow')}
      >
        <IconSendOutlineRegular size={12} />
      </button>
      {onMakeGlobal !== undefined && (
        <button
          type="button"
          className={css.globalBtn}
          onClick={() => { onMakeGlobal(template.id) }}
          aria-label={t('panel.makeGlobal')}
          title={t('panel.makeGlobal')}
        >
          <IconGlobeOutlineRegular size={12} />
        </button>
      )}
      <button
        type="button"
        className={css.editBtn}
        onClick={() => { onEdit(template.id) }}
        aria-label={t('panel.edit')}
        title={t('panel.edit')}
      >
        <IconEditOutlineRegular size={12} />
      </button>
      <button
        type="button"
        className={css.deleteBtn}
        onClick={() => { onDelete(template.id) }}
        aria-label={t('panel.delete')}
      >
        <IconTrashOutlineRegular size={12} />
      </button>
    </div>
  )
}

/** The template inline form: creation (with scope + category pickers) and in-place edit. */
function TemplateForm({ initial, allowScope, sessionId, categories, t, submitLabel, onSubmit, onDone, onCancel }: {
  initial?: { name: string; content: string; scope?: 'global' | 'session'; category?: string | null; injectEnabled?: boolean; injectEvery?: number | null; mode?: TemplateInjectMode }
  allowScope: boolean
  sessionId: string | null
  categories: readonly CategoryView[]
  t: (key: PromptTemplateKey) => string
  submitLabel: string
  onSubmit: (name: string, content: string, scope: 'global' | 'session', category: string | null, injectEnabled: boolean, injectEvery: number | null, mode: TemplateInjectMode) => Promise<boolean>
  onDone: () => void
  /** Abort without saving: exit the edit state / collapse the create form. */
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  // Edit seeds BOTH pickers with the row's stored facts, so opening a
  // category tab's edit form pre-selects that category (and the matching
  // scope) instead of resetting to 全局/无分类.
  const [scope, setScope] = useState<'global' | 'session'>(initial?.scope ?? 'global')
  const [category, setCategory] = useState<string | null>(initial?.category ?? null)
  // Auto-inject facts: the interval edits as text so a half-typed value never
  // silently rounds; it is parsed (and rejected) on submit only.
  const [injectOn, setInjectOn] = useState(initial?.injectEnabled ?? false)
  const [injectEvery, setInjectEvery] = useState(initial?.injectEvery != null ? String(initial.injectEvery) : '5')
  const [mode, setMode] = useState<TemplateInjectMode>(initial?.mode ?? 'inject')
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
    let every: number | null = null
    if (injectOn) {
      const parsed = Number(injectEvery)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError(t('panel.error'))
        return
      }
      every = parsed
    }
    setBusy(true)
    setError(null)
    const ok = await onSubmit(trimmedName, trimmedContent, scope, category, injectOn, every, mode)
    setBusy(false)
    if (!ok) {
      setError(t('panel.error'))
      return
    }
    onDone()
  }, [name, content, scope, category, injectOn, injectEvery, mode, allowScope, sessionId, onSubmit, t, onDone])

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
      <div className={css.injectRow}>
        <label className={css.injectLabel}>
          <input
            type="checkbox"
            checked={injectOn}
            onChange={(e) => { setInjectOn(e.target.checked) }}
          />
          {t('panel.inject')}
        </label>
        {injectOn && (
          <label className={css.injectLabel}>
            <input
              className={css.injectEveryInput}
              type="number"
              min={1}
              step={1}
              value={injectEvery}
              onChange={(e) => { setInjectEvery(e.target.value) }}
              aria-label={t('panel.injectEvery')}
            />
            {t('panel.injectEvery')}
          </label>
        )}
        {injectOn && (
          <label className={css.injectLabel} title={t('panel.modeHint')}>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value as TemplateInjectMode) }}
              aria-label={t('panel.modeLabel')}
            >
              <option value="inject">{t('panel.modeInject')}</option>
              <option value="visible">{t('panel.modeVisible')}</option>
            </select>
          </label>
        )}
      </div>
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
          {onCancel !== undefined && (
            <button type="button" className={css.cancelBtn} onClick={onCancel} disabled={busy}>
              {t('panel.addCancel')}
            </button>
          )}
          <button type="button" className={css.saveBtn} onClick={() => void submit()} disabled={busy || name.trim() === '' || content.trim() === ''}>
            {submitLabel}
          </button>
        </div>
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

/** Optional title-row takeover by the host surface: the floating panel
 * turns the row into its drag handle (pointer capture + move + release +
 * double-click-to-reset) and appends its close button. */
export interface LibraryHeaderProps {
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove?: (event: React.PointerEvent<HTMLElement>) => void
  onPointerUp?: (event: React.PointerEvent<HTMLElement>) => void
  onDoubleClick?: () => void
  /** Tooltip for the drag handle (the floating panel's hint copy). */
  hint?: string
}

/** Props of the shared library body. */
export interface TemplateLibraryProps {
  /** Delivery target for insert/send/interject and the session partition. */
  sessionId: string | null
  /** The CRUD + delivery verbs (a subset of the panel face). */
  face: TemplateLibraryFace
  t: (key: PromptTemplateKey) => string
  /** Title-row drag-handle wiring for the floating panel host. */
  header?: LibraryHeaderProps
  /** Optional trailing controls in the title row (the floating panel's close button). */
  headerExtra?: React.ReactNode
}

/**
 * The shared template library: toolbar (title + row count), live search,
 * category tabs, the row list with inline edit/create forms, and the
 * footer. Loads everything on mount; the parent decides placement and
 * lifetime (the overlay mounts it only while open, the sidebar tab mounts
 * it for the tab's lifetime).
 * @param props - target session, shared verbs, locale, optional title-row takeover.
 */
export function TemplateLibrary({ sessionId, face, t, header, headerExtra }: TemplateLibraryProps) {
  const { refresh, refreshCategories, createCategory, removeCategory, create, update, remove, makeGlobal, insert, send, interject, injectStatus } = face
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
  // Row-toggle failures surface above the list until the next good write.
  const [rowError, setRowError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const items = await refresh()
    setTemplates(items)
  }, [refresh])

  const loadCategories = useCallback(async () => {
    setCategories(await refreshCategories())
  }, [refreshCategories])

  useEffect(() => {
    void load()
    void loadCategories()
  }, [load, loadCategories])

  // Toolbar badge `⟳N`: the target session's latest scheduled injection,
  // polled every 30s (and re-read whenever the target changes). null hides
  // the badge — the route is memory-only, so polling stays O(1).
  const [injected, setInjected] = useState<InjectionStatusView | null>(null)
  const pollStatus = useCallback(async () => {
    if (sessionId === null) {
      setInjected(null)
      return
    }
    setInjected(await injectStatus(sessionId))
  }, [injectStatus, sessionId])
  useEffect(() => {
    void pollStatus()
    const timer = setInterval(() => { void pollStatus() }, 30_000)
    return () => { clearInterval(timer) }
  }, [pollStatus])

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

  // Flip one row's auto-inject switch. First-time setup (no interval yet)
  // routes into the edit form, where the interval gets typed and confirmed.
  // A failed toggle surfaces the envelope error next to the list instead of
  // failing silently — the switch only flips after a confirmed write.
  const handleToggleInject = useCallback(async (template: TemplateView) => {
    if (!template.inject_enabled && template.inject_every === null) {
      setEditingId(template.id)
      return
    }
    const result = await update(template.id, { inject_enabled: !template.inject_enabled })
    if (result.ok) {
      setRowError(null)
      void load()
    } else {
      setRowError(result.error.message)
    }
  }, [update, load])

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

  // With no query the active tab owns the list. A query searches across every
  // category, but never leaks another session's private templates.
  const needle = query.trim().toLowerCase()
  const tabRows = filterTemplateRows(templates, query, effectiveTab, activeCategory, sessionId)
  const searchableCount = searchableTemplateRows(templates, sessionId).length
  const countLabel = templateCountLabel(tabRows.length, searchableCount, needle !== '')

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
          initial={{ name: row.name, content: row.content, scope: row.scope, category: row.category, injectEnabled: row.inject_enabled, injectEvery: row.inject_every, mode: row.mode }}
          allowScope={false}
          sessionId={sessionId}
          categories={visibleCategories}
          t={t}
          submitLabel={t('panel.addSave')}
          onSubmit={async (name, content, _scope, category, injectEnabled, injectEvery, mode) => {
            // Disabling keeps the stored interval: only enabling sends a new one.
            const result = await update(row.id, {
              name,
              content,
              category,
              inject_enabled: injectEnabled,
              ...(injectEnabled ? { inject_every: injectEvery, mode } : {}),
            })
            return result.ok
          }}
          onDone={() => { setEditingId(null); void load() }}
          onCancel={() => { setEditingId(null) }}
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
          onToggleInject={(tpl) => { void handleToggleInject(tpl) }}
          sortable={needle === ''}
          onDragStart={(id) => { dragRowRef.current = id }}
          onDropOn={(id) => { handleRowDrop(id) }}
          t={t}
        />
      )
  )

  return (
    <div className={css.library} data-prompt-library>
      <div
        className={header !== undefined ? `${css.toolbar} ${css.toolbarDraggable}` : css.toolbar}
        title={header?.hint}
        onPointerDown={header?.onPointerDown}
        onPointerMove={header?.onPointerMove}
        onPointerUp={header?.onPointerUp}
        onDoubleClick={header?.onDoubleClick}
      >
        <span className={css.titleGroup}>
          <span className={css.title}>{t('panel.title')}</span>
          <span className={css.countBadge} data-template-count title={needle !== '' ? t('panel.searchCount') : t('panel.tabCount')}>
            {countLabel}
          </span>
          {injected !== null && (
            <span
              className={css.injectBadge}
              data-prompt-injected
              title={`${t('panel.injectedAt')} ${injected.turn} · ${new Date(injected.at).toLocaleTimeString()} · ${injected.templates.join(', ')}`}
              aria-label={t('panel.injectedAt')}
            >
              ⟳{injected.turn}
            </span>
          )}
        </span>
        {headerExtra}
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
          <IconPlusOutlineRegular size={10} />
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
        {/* Row-toggle failures surface here, above the list, until the next
            successful write clears them. */}
        {rowError !== null && (
          <div className={css.error} role="alert" data-prompt-row-error>{t('panel.error')} · {rowError}</div>
        )}
        {/* Empty states: the whole library is empty, or the active tab (with
            or without a search needle) holds no rows — both show the empty
            copy instead of a silently missing list area. */}
        {tabRows.length === 0 && !showAdd && !showCatForm && (
          <div className={css.empty}>{needle !== '' ? t('panel.noMatch') : t('panel.empty')}</div>
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
            onSubmit={async (name, content, scope, category, injectEnabled, injectEvery, mode) => {
              const result = await create({
                name,
                content,
                scope,
                session_id: scope === 'session' ? sessionId : null,
                category,
                inject_enabled: injectEnabled,
                inject_every: injectEvery,
                mode,
              })
              return result.ok
            }}
            onDone={() => { setShowAdd(false); void load() }}
            onCancel={() => { setShowAdd(false) }}
          />
        )}
      </div>
      <div className={css.footer}>
        <span className={css.meta}>
          <span data-plugin-version>v{PLUGIN_VERSION}</span>
          <a
            className={css.githubLink}
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={t('panel.github')}
          >
            GitHub ↗
          </a>
        </span>
        <button type="button" className={css.addBtn} onClick={() => { setShowAdd(v => !v) }}>
          <IconPlusOutlineRegular size={12} /> {t('panel.add')}
        </button>
      </div>
    </div>
  )
}
