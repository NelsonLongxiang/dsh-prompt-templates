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
import { IconCopyOutlineRegular, IconDownloadOutlineRegular, IconEditOutlineRegular, IconGlobeOutlineRegular, IconPlusOutlineRegular, IconQueueOutlineRegular, IconSendOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CategoryView, InjectionHistoryEntry, InjectionStatusView, TemplateInjectMode, TemplateView } from '../types.ts'
import type { EventEpisodeWire, EventPolicyWire } from './api.ts'
import { decideLessonType, listCardStats, listLessonPins, listPendingLessonTypes, recordManualIntervention, setLessonPinned, type CardStatWire, type LessonPinWire, type PendingLessonTypeWire } from './api.ts'
import type { TemplateLibraryFace } from './slots.ts'
import { filterTemplateRows, searchableTemplateRows } from './filter.ts'
import { buildSharePayload, parseSharePayload, planShareImport } from './share.ts'
import { startLibraryRefresh } from './refresh.ts'
import { copyShareText } from './clipboard.ts'
import type { ShareCopyResult } from './clipboard.ts'
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
  onInsert: (template: TemplateView) => void
  onSend: (template: TemplateView) => void
  onInterject: (template: TemplateView) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  /** Copy the row as a one-template clipboard share payload. */
  onShare: (template: TemplateView, trigger: HTMLButtonElement) => void
  onMakeGlobal?: (id: string) => void
  /** Present only for the session's own lessons (体会): the owner pins them. */
  pin?: { readonly pinned: boolean; readonly onToggle: () => void; readonly rounds?: { readonly opened: number; readonly closed: number; readonly missed: number } }
  /** Present for a workshop card injected in this session: its card-round yield. */
  cardYield?: CardStatWire
  /** Flip the row's auto-inject switch (rows without an interval route to the edit form). */
  onToggleInject: (template: TemplateView) => void
  sortable: boolean
  onDragStart: (id: string) => void
  onDropOn: (id: string) => void
  t: (key: PromptTemplateKey) => string
}

function TemplateRow({ template, onInsert, onSend, onInterject, onEdit, onDelete, onShare, onMakeGlobal, pin, cardYield, onToggleInject, sortable, onDragStart, onDropOn, t }: RowProps) {
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
        onClick={() => { onInsert(template) }}
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
        onClick={() => { onInterject(template) }}
        aria-label={t('panel.interject')}
        title={t('panel.interject')}
      >
        <IconQueueOutlineRegular size={12} />
      </button>
      <button
        type="button"
        className={css.sendBtn}
        onClick={() => { onSend(template) }}
        aria-label={t('panel.sendNow')}
        title={t('panel.sendNow')}
      >
        <IconSendOutlineRegular size={12} />
      </button>
      <button
        type="button"
        className={css.shareBtn}
        onClick={(event) => { onShare(template, event.currentTarget) }}
        aria-label={t('panel.share')}
        title={t('panel.share')}
      >
        <IconCopyOutlineRegular size={12} />
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
      {pin !== undefined && (
        <button
          type="button"
          className={pin.pinned ? css.injectBtnActive : css.injectBtn}
          onClick={() => { pin.onToggle() }}
          aria-label={pin.pinned ? t('panel.unpin') : t('panel.pin')}
          aria-pressed={pin.pinned}
          title={pin.pinned ? t('panel.unpin') : t('panel.pin')}
        >
          📌
        </button>
      )}
      {cardYield !== undefined && cardYield.injected > 0 && (
        <span
          className={css.injectBadge}
          title={t('panel.cardYield').replace('{injected}', String(cardYield.injected)).replace('{lessons}', String(cardYield.lessons)).replace('{none}', String(cardYield.none)).replace('{missed}', String(cardYield.missed))}
        >
          体会 {cardYield.lessons}/{cardYield.injected}
        </span>
      )}
      {pin?.rounds !== undefined && pin.rounds.opened > 0 && (
        <span
          className={css.injectBadge}
          title={t('panel.rounds').replace('{opened}', String(pin.rounds.opened)).replace('{closed}', String(pin.rounds.closed)).replace('{missed}', String(pin.rounds.missed))}
        >
          RSI {pin.rounds.closed}/{pin.rounds.opened}
        </span>
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
      <div className={css.variablesHint}>{t('panel.variablesHint')}</div>
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
  const { refresh, refreshCategories, createCategory, removeCategory, create, update, remove, makeGlobal, insert, send, interject, injectStatus, injectionHistory, eventPolicies, setEventMaster, updateEventPolicy, eventEpisodes } = face
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

  // Rows the agent writes with its own tools (selfcheck_write, lesson_write) land server-side while this library stays
  // mounted; re-read rows and categories on a timer, on focus and on visibility, and whenever the target session changes.
  useEffect(() => {
    void load()
    void loadCategories()
    return startLibraryRefresh(() => { void load(); void loadCategories() })
  }, [load, loadCategories, sessionId])

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

  // Badge dropdown: the recent-injection history for the target session,
  // fetched on demand (on open, on target change, and whenever a new
  // injection lands while open) so the 30s badge poll stays O(1).
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<readonly InjectionHistoryEntry[]>([])
  const loadHistory = useCallback(async () => {
    if (sessionId === null) {
      setHistory([])
      return
    }
    setHistory(await injectionHistory(sessionId))
  }, [injectionHistory, sessionId])
  useEffect(() => {
    if (historyOpen) void loadHistory()
  }, [historyOpen, loadHistory, injected])
  useEffect(() => { setHistoryOpen(false) }, [sessionId])

  // Event-reminders dropdown (⚙): the stored master switch (panel-owned,
  // seeded once from deployment config) plus per-rule toggles and tunables,
  // and the target session's read-only problem episodes. Loaded on demand
  // so closed state costs nothing; a failed load keeps the banner's fallback.
  const [eventsOpen, setEventsOpen] = useState(false)
  const [policies, setPolicies] = useState<{ items: readonly EventPolicyWire[]; enabled: boolean } | null>(null)
  const [episodes, setEpisodes] = useState<readonly EventEpisodeWire[]>([])
  const loadPolicies = useCallback(async () => {
    setPolicies(await eventPolicies())
  }, [eventPolicies])
  const loadEpisodes = useCallback(async () => {
    if (sessionId === null) {
      setEpisodes([])
      return
    }
    setEpisodes(await eventEpisodes(sessionId))
  }, [eventEpisodes, sessionId])
  useEffect(() => {
    if (eventsOpen) { void loadPolicies(); void loadEpisodes() }
  }, [eventsOpen, loadPolicies, loadEpisodes])
  useEffect(() => { setEventsOpen(false) }, [sessionId])
  // Flip the stored master switch; takes effect immediately, no restart.
  const handleToggleMaster = useCallback(async () => {
    if (policies === null) return
    const result = await setEventMaster(!policies.enabled)
    if (result.ok) void loadPolicies()
    else setRowError(result.error.message)
  }, [policies, setEventMaster, loadPolicies])
  // Flip one rule's enabled switch; the write confirms before the row flips.
  const handleToggleRule = useCallback(async (rule: EventPolicyWire) => {
    const result = await updateEventPolicy(rule.rule_id, { enabled: !rule.enabled })
    if (result.ok) void loadPolicies()
    else setRowError(result.error.message)
  }, [updateEventPolicy, loadPolicies])
  // Commit one tunable (threshold / cooldown) after an explicit blur; an
  // unchanged or unparsable value writes nothing.
  const handleRuleParam = useCallback(async (rule: EventPolicyWire, field: 'threshold' | 'cooldown_turns', raw: string) => {
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value) || value === rule[field]) return
    const result = await updateEventPolicy(rule.rule_id, { [field]: value })
    if (result.ok) void loadPolicies()
    else setRowError(result.error.message)
  }, [updateEventPolicy, loadPolicies])

  // Clipboard sharing: one template per row, one category per tab. The
  // payload carries raw rows (variables stay literal — they re-expand on
  // the receiving instance). Import plans against the loaded rows first,
  // so the same-name overwrite risk is one explicit confirm (owner ruling).
  const [notice, setNotice] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [manualShare, setManualShare] = useState<Extract<ShareCopyResult, { ok: false }> | null>(null)
  const shareField = useRef<HTMLTextAreaElement>(null)
  const shareOpener = useRef<HTMLElement | null>(null)
  const shareRequest = useRef(0)
  useEffect(() => {
    shareRequest.current += 1
    shareOpener.current = null
    setManualShare(null)
    return () => { shareRequest.current += 1 }
  }, [sessionId])
  // 体会 pins (phase 2): only the session's own lessons get the toggle; the host enforces the quota.
  const [lessonPins, setLessonPins] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [lessonRounds, setLessonRounds] = useState<ReadonlyMap<string, LessonPinWire['rounds']>>(new Map())
  const loadLessonPins = useCallback(async () => {
    if (sessionId === null) { setLessonPins(new Map()); setLessonRounds(new Map()); return }
    const items = await listLessonPins(sessionId)
    setLessonPins(new Map(items.map(item => [item.id, item.pinned])))
    setLessonRounds(new Map(items.map(item => [item.id, item.rounds])))
  }, [sessionId])
  useEffect(() => { void loadLessonPins() }, [loadLessonPins, templates])

  // Workshop-card yields in this session (card rounds): shown on the card rows.
  const [cardYields, setCardYields] = useState<ReadonlyMap<string, CardStatWire>>(new Map())
  const loadCardYields = useCallback(async () => {
    setCardYields(new Map(sessionId === null ? [] : (await listCardStats(sessionId)).map(card => [card.template_id, card])))
  }, [sessionId])
  useEffect(() => { void loadCardYields() }, [loadCardYields, templates])

  // Lesson types the session proposed (lesson_type_propose): only the owner approves them, here.
  const [pendingTypes, setPendingTypes] = useState<readonly PendingLessonTypeWire[]>([])
  const loadPendingTypes = useCallback(async () => {
    setPendingTypes(sessionId === null ? [] : await listPendingLessonTypes(sessionId))
  }, [sessionId])
  useEffect(() => { void loadPendingTypes() }, [loadPendingTypes, templates])
  const handleDecideType = useCallback(async (name: string, approved: boolean) => {
    if (sessionId === null) return
    const result = await decideLessonType(sessionId, name, approved)
    if (!result.ok) setNotice(result.error.message)
    await loadPendingTypes()
  }, [sessionId, loadPendingTypes])
  const handleTogglePin = useCallback(async (id: string) => {
    const result = await setLessonPinned(id, lessonPins.get(id) !== true)
    if (!result.ok) setNotice(result.error.code === 'pinned-full' ? t('panel.pinFull') : result.error.message)
    await loadLessonPins()
  }, [lessonPins, loadLessonPins, t])
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => { setNotice(null) }, 3000)
    return () => { clearTimeout(timer) }
  }, [notice])

  const copyPayload = useCallback(async (payload: string, trigger: HTMLButtonElement): Promise<void> => {
    const request = ++shareRequest.current
    // Row mousedown intentionally preserves the composer focus. Safari also
    // need not focus a clicked button, so activeElement is not the trigger.
    shareOpener.current = trigger
    const result = await copyShareText(payload, undefined, () => request === shareRequest.current)
    if (request !== shareRequest.current) return
    if (result.ok) {
      setManualShare(null)
      setNotice(t('panel.shareCopied'))
    } else {
      setManualShare(result)
      setNotice(null)
      setShowImport(false)
      setEventsOpen(false)
      setHistoryOpen(false)
    }
  }, [t])

  useEffect(() => {
    if (manualShare === null) return
    shareField.current?.focus()
    shareField.current?.select()
  }, [manualShare])

  const handleShareTemplate = useCallback((template: TemplateView, trigger: HTMLButtonElement) => {
    return copyPayload(JSON.stringify(buildSharePayload([template])), trigger)
  }, [copyPayload])

  const handleShareCategory = useCallback((cat: CategoryView, trigger: HTMLButtonElement) => {
    const members = templates.filter(row => row.category === cat.name
      && row.scope === cat.scope
      && (cat.scope === 'global' || row.session_id === cat.session_id))
    if (members.length === 0) {
      setNotice(t('panel.shareEmpty'))
      return
    }
    return copyPayload(JSON.stringify(buildSharePayload(members, [cat])), trigger)
  }, [templates, copyPayload, t])

  const handleImport = useCallback(async () => {
    const parsed = parseSharePayload(importText.trim())
    if (!parsed.ok) {
      setRowError(t('panel.importBad') + ' (' + parsed.error + ')')
      return
    }
    const plan = planShareImport(parsed.payload, templates, categories)
    let overwrite = 0
    if (plan.overwrite.length > 0) {
      // Same name + same scope is the overwrite risk: one explicit ask,
      // declining skips those rows (nothing is silently replaced).
      if (window.confirm(t('panel.overwriteRisk') + ' ' + plan.overwrite.length)) overwrite = plan.overwrite.length
    }
    setImportBusy(true)
    for (const cat of plan.missingCategories) {
      await createCategory({ name: cat.name, scope: cat.scope, session_id: cat.session_id })
    }
    let created = 0
    let skipped = 0
    for (const incoming of plan.create) {
      if (incoming.scope === 'session' && sessionId === null) { skipped += 1; continue }
      const result = await create({
        name: incoming.name,
        content: incoming.content,
        scope: incoming.scope,
        session_id: incoming.scope === 'session' ? sessionId : null,
        description: incoming.description,
        category: incoming.category,
        // Import never silently enables scheduled injection — the interval
        // and mode survive so a manual toggle starts it as configured, but
        // the switch itself stays off until the user turns it on.
        inject_enabled: false,
        inject_every: incoming.inject_every,
        mode: incoming.mode,
      })
      if (result.ok) created += 1
    }
    if (overwrite > 0) {
      for (const pair of plan.overwrite) {
        const result = await update(pair.target.id, {
          content: pair.incoming.content,
          description: pair.incoming.description,
          category: pair.incoming.category,
          // Overwrite updates content and placement, never the inject switch:
          // the target's own on/off state survives the sync.
          inject_every: pair.incoming.inject_every,
          mode: pair.incoming.mode,
        })
        if (!result.ok) overwrite -= 1
      }
    }
    if (overwrite === 0 && plan.overwrite.length > 0 && created === 0 && skipped === plan.create.length) {
      // nothing happened at all — keep the form open for inspection
      setImportBusy(false)
      return
    }
    const declined = plan.overwrite.length > 0 && overwrite === 0 ? plan.overwrite.length : 0
    const skippedTotal = skipped + declined
    setImportBusy(false)
    setShowImport(false)
    setImportText('')
    setNotice(t('panel.importDone') + ' ' + created + ' / ' + overwrite + ' / ' + skippedTotal)
    void load()
    void loadCategories()
  }, [importText, templates, categories, sessionId, create, update, createCategory, load, loadCategories, t])

  // Observer phase 1 (v9): each hand-sent template is recorded on the host (identity and digest, never the text).
  const handleInsert = useCallback((template: TemplateView) => {
    if (sessionId === null) return
    insert(sessionId, template.content)
    void recordManualIntervention(sessionId, template.id, 'insert')
  }, [insert, sessionId])

  const handleSend = useCallback((template: TemplateView) => {
    if (sessionId === null) return
    send(sessionId, template.content)
    void recordManualIntervention(sessionId, template.id, 'send')
  }, [send, sessionId])

  const handleInterject = useCallback((template: TemplateView) => {
    if (sessionId === null) return
    interject(sessionId, template.content)
    void recordManualIntervention(sessionId, template.id, 'interject')
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
          onShare={(tpl, trigger) => { void handleShareTemplate(tpl, trigger) }}
          onMakeGlobal={row.scope === 'session' ? (id) => { void handleMakeGlobal(id) } : undefined}
          pin={lessonPins.has(row.id) ? { pinned: lessonPins.get(row.id) === true, onToggle: () => { void handleTogglePin(row.id) }, rounds: lessonRounds.get(row.id) } : undefined}
          cardYield={cardYields.get(row.id)}
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
            <button
              type="button"
              className={`${css.injectBadge} ${css.injectBadgeButton}`}
              data-prompt-injected
              title={`${t('panel.injectedAt')} ${injected.turn} · ${new Date(injected.at).toLocaleTimeString()} · ${injected.templates.join(', ')}`}
              aria-label={t('panel.historyTitle')}
              aria-expanded={historyOpen}
              onClick={() => { setHistoryOpen(open => !open) }}
            >
              ⟳{injected.turn}
            </button>
          )}
          <button
            type="button"
            className={css.importBtn}
            onClick={() => { setShowImport(v => !v) }}
            aria-label={t('panel.import')}
            aria-expanded={showImport}
            title={t('panel.import')}
          >
            <IconDownloadOutlineRegular size={12} />
          </button>
          <button
            type="button"
            className={css.importBtn}
            data-prompt-events-toggle
            onClick={() => { setEventsOpen(open => !open) }}
            aria-label={t('panel.eventsTitle')}
            aria-expanded={eventsOpen}
            title={t('panel.eventsTitle')}
          >
            ⚙
          </button>
        </span>
        {headerExtra}
      </div>
      {notice !== null && <div className={css.notice} role="status">{notice}</div>}
      {manualShare !== null && (
        <section className={css.importForm} data-prompt-share-manual aria-label={t('panel.shareManualTitle')}>
          <div role="status">
            {t(manualShare.failure.kind === 'unavailable' ? 'panel.copyUnavailable'
              : manualShare.failure.kind === 'unfocused' ? 'panel.copyUnfocused'
                : manualShare.failure.kind === 'denied' ? 'panel.copyDenied'
                  : manualShare.failure.kind === 'security' ? 'panel.copySecurity' : 'panel.copyWriteFailed')}
            {manualShare.failure.errorName !== null && ` (${manualShare.failure.errorName})`}
          </div>
          <div>{t('panel.shareManualHint')}</div>
          <textarea
            ref={shareField}
            className={css.contentInput}
            data-prompt-share-json
            rows={5}
            readOnly
            value={manualShare.payload}
            aria-label={t('panel.shareManualTitle')}
            onFocus={(event) => { event.currentTarget.select() }}
          />
          <div className={css.importActions}>
            <button type="button" className={css.saveBtn} onClick={() => { shareField.current?.focus(); shareField.current?.select() }}>
              {t('panel.shareSelectAll')}
            </button>
            <button type="button" className={css.cancelBtn} onClick={() => {
              setManualShare(null)
              const opener = shareOpener.current
              shareOpener.current = null
              if (opener?.isConnected) opener.focus({ preventScroll: true })
            }}>
              {t('panel.shareDismiss')}
            </button>
          </div>
        </section>
      )}
      {showImport && (
        <div className={css.importForm} data-prompt-import>
          <textarea
            className={css.contentInput}
            rows={4}
            value={importText}
            onChange={(e) => { setImportText(e.target.value) }}
            placeholder={t('panel.importPlaceholder')}
            aria-label={t('panel.import')}
          />
          <div className={css.importActions}>
            <button type="button" className={css.saveBtn} onClick={() => { void handleImport() }} disabled={importBusy}>
              {t('panel.importRun')}
            </button>
            <button type="button" className={css.cancelBtn} onClick={() => { setShowImport(false); setImportText('') }} disabled={importBusy}>
              {t('panel.importCancel')}
            </button>
          </div>
        </div>
      )}
      {historyOpen && (
        <div className={css.injectHistory} data-prompt-inject-history role="dialog" aria-label={t('panel.historyTitle')}>
          <div className={css.injectHistoryTitle}>{t('panel.historyTitle')}</div>
          {history.length === 0 && <div className={css.injectHistoryEmpty}>{t('panel.historyEmpty')}</div>}
          {history.map(entry => (
            <div key={`${entry.turn}-${entry.at}`} className={css.injectHistoryItem}>
              <div className={css.injectHistoryHead}>
                ⟳{entry.turn} · {new Date(entry.at).toLocaleTimeString()} · {entry.templates.join(', ')}
              </div>
              <div className={css.injectHistoryContent}>{entry.content}</div>
            </div>
          ))}
        </div>
      )}
      {eventsOpen && (
        <div className={css.eventsPanel} data-prompt-events role="dialog" aria-label={t('panel.eventsTitle')}>
          <div className={css.eventsHead}>{t('panel.eventsTitle')}</div>
          <div className={policies !== null && policies.enabled ? css.eventsBanner : `${css.eventsBanner} ${css.eventsBannerOff}`}>
            <label className={css.eventsRuleHead}>
              <input
                type="checkbox"
                className={css.eventsToggle}
                checked={policies?.enabled === true}
                disabled={policies === null}
                onChange={() => { void handleToggleMaster() }}
              />
              <span>{policies === null ? t('panel.eventsLoadFailed') : policies.enabled ? t('panel.eventsMasterOn') : t('panel.eventsMasterOff')}</span>
            </label>
          </div>
          {(policies?.items ?? []).map(rule => (
            <div key={rule.rule_id} className={css.eventsRule}>
              <label className={css.eventsRuleHead}>
                <input
                  type="checkbox"
                  className={css.eventsToggle}
                  checked={rule.enabled}
                  disabled={policies === null || !policies.enabled}
                  onChange={() => { void handleToggleRule(rule) }}
                />
                <span className={css.eventsRuleName}>
                  {t(rule.rule_id === 'repeated-preparation' ? 'panel.eventsRulePrep' : 'panel.eventsRuleFail')}
                </span>
              </label>
              <div className={css.eventsParams}>
                <label className={css.eventsParam}>
                  {t('panel.eventsThreshold')}
                  <input
                    type="number"
                    min={1}
                    defaultValue={rule.threshold}
                    disabled={!rule.enabled || policies === null || !policies.enabled}
                    onBlur={(event) => { void handleRuleParam(rule, 'threshold', event.target.value) }}
                  />
                </label>
                <label className={css.eventsParam}>
                  {t('panel.eventsCooldown')}
                  <input
                    type="number"
                    min={0}
                    defaultValue={rule.cooldown_turns}
                    disabled={!rule.enabled || policies === null || !policies.enabled}
                    onBlur={(event) => { void handleRuleParam(rule, 'cooldown_turns', event.target.value) }}
                  />
                </label>
              </div>
            </div>
          ))}
          <div className={css.eventsEpisodesTitle}>{t('panel.eventsEpisodes')}</div>
          {episodes.length === 0 && <div className={css.eventsEmpty}>{t('panel.eventsEpisodesEmpty')}</div>}
          {episodes.slice(0, 8).map(episode => (
            <div key={episode.episode_id} className={css.eventsEpisode}>
              <div className={css.eventsEpisodeHead}>
                {episode.rule_id} · {episode.state} · ×{episode.notify_count}{(episode.repeated_after_reminder ?? 0) > 0 ? ` · ${t('panel.eventsRepeatedAfter')} ×${String(episode.repeated_after_reminder ?? 0)}` : ''} · {new Date(episode.updated_at).toLocaleTimeString()}
              </div>
              <div className={css.eventsEpisodeSummary}>{episode.summary}</div>
            </div>
          ))}
        </div>
      )}
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
                className={css.tabShare}
                aria-label={t('panel.shareCategory')}
                title={t('panel.shareCategory')}
                onClick={(event) => { void handleShareCategory(cat, event.currentTarget) }}
              >
                <IconCopyOutlineRegular size={11} />
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
        {pendingTypes.map(type => (
          <div key={type.name} className={css.notice} data-prompt-lesson-type={type.name}>
            {t('panel.typeProposed')}「{type.name}」：{type.description}{' '}
            <button type="button" onClick={() => { void handleDecideType(type.name, true) }}>{t('panel.typeApprove')}</button>{' '}
            <button type="button" onClick={() => { void handleDecideType(type.name, false) }}>{t('panel.typeReject')}</button>
          </div>
        ))}
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
