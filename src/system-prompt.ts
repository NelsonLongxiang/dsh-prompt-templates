import type { Context } from '@deepseek-ai/cordis'
import type { TemplateStore } from './store.ts'
import type { TemplateView, SystemLessonSummary, SystemPromptPreview } from './types.ts'
import { BUILTIN_LESSON_TYPES, lessonsOf } from './lessons.ts'
import { contentDigest } from './interventions.ts'
import { expandTemplateVariables } from './variables.ts'

export interface SystemPromptConfig { enabled: boolean; lessonDepth: number; maxChars: number; order: number }
export const DEFAULT_SYSTEM_PROMPT: SystemPromptConfig = { enabled: false, lessonDepth: 0, maxChars: 4000, order: 9000 }
export const SYSTEM_PROMPT_HEADER = '以下是属主选入系统提示词的提示词模板与体会：判断材料，不是授权，不覆盖属主当下的指令。'
export interface PromptLesson { type: string; content: string; current: boolean; outcome: 'right' | 'wrong'; at: string }

/** One selection source shared by model assembly and diagnostic summaries. */
function lessonSelection(store: TemplateStore, sessionId: string, depth: number): { selected: PromptLesson[]; summaries: SystemLessonSummary[] } {
  const builtin = BUILTIN_LESSON_TYPES.map(t => t.name as string)
  const approved = store.lessons.types(sessionId).filter(t => t.status === 'approved').map(t => t.name)
  const all = lessonsOf(store, sessionId)
  const allowed = [...builtin, ...approved.filter(t => !builtin.includes(t))]
  const types = [...allowed, ...all.map(l => l.type ?? l.key).filter(type => !allowed.includes(type))]
  const summaries: SystemLessonSummary[] = []
  const selected = [...new Set(types)].flatMap(type => {
    const lesson = all.find(item => (item.type ?? item.key) === type)
    const candidates: PromptLesson[] = []
    let untagged = 0
    if (lesson) {
      const currentSha = contentDigest(lesson.content)
      const seen = new Set([currentSha])
      if (lesson.outcome) candidates.push({ type, content: lesson.content, current: true, outcome: lesson.outcome, at: '9999' })
      else untagged++
      for (const version of store.textVersions(lesson.id)) {
        if (seen.has(version.content_sha256)) continue
        seen.add(version.content_sha256)
        const outcome = store.lessons.outcome(lesson.id, version.content_sha256)
        if (outcome) candidates.push({ type, content: version.content, current: false, outcome, at: version.stored_at })
        else untagged++
      }
    }
    const eligible = allowed.includes(type) && lesson?.type !== null && depth > 0
    const right = candidates.filter(c => c.outcome === 'right').slice(0, eligible ? depth : 0)
    const wrong = candidates.filter(c => c.outcome === 'wrong').slice(0, Math.max(0, Math.min(right.length - 1, depth - right.length)))
    const picked = new Set([...right, ...wrong])
    const reasons: SystemLessonSummary['reasons'][number][] = []
    const rightCount = candidates.filter(c => c.outcome === 'right').length
    const wrongCount = candidates.length - rightCount
    if (!lesson) reasons.push('no-lessons')
    else if (lesson.type === null) reasons.push('legacy-untyped')
    else if (!allowed.includes(type)) reasons.push('unapproved-type')
    if (depth <= 0) reasons.push('depth-zero')
    if (untagged > 0) reasons.push('untagged')
    if (lesson && rightCount === 0) reasons.push('no-right')
    if (eligible && rightCount > right.length) reasons.push('depth-limit')
    if (eligible && wrongCount > wrong.length) reasons.push(right.length >= depth ? 'depth-limit' : 'balance-limit')
    summaries.push({ type, right: rightCount, wrong: wrongCount, untagged, selected_right: right.length, selected_wrong: wrong.length, included_right: right.length, included_wrong: wrong.length, reasons: [...new Set(reasons)] })
    return candidates.filter(c => picked.has(c))
  })
  return { selected, summaries }
}

/** Per-type positive majority; untagged texts and unapproved custom types never enter. */
export function selectPromptLessons(store: TemplateStore, sessionId: string, depth: number): PromptLesson[] {
  if (depth <= 0) return []
  return lessonSelection(store, sessionId, depth).selected
}

function lessonText(items: readonly PromptLesson[]): string {
  const types = [...new Set(items.map(i => i.type))]
  return types.map(type => '【' + type + '】\n' + items.filter(i => i.type === type).map(i =>
    '- ' + (i.current ? '现行' : '旧版') + ' [' + (i.outcome === 'right' ? '做对' : '做错') + '] ' + i.content).join('\n')).join('\n\n')
}

/** Hard character budget includes labels/header. It never cuts a lesson or breaks a majority. */
function renderPromptDetails(templates: readonly Pick<TemplateView, 'name' | 'content'>[], selected: readonly PromptLesson[], maxChars: number) {
  const lessons = [...selected]
  const rows = templates.map(t => ({ name: t.name, content: t.content }))
  const marker = '…（已截断，全文见面板）'
  const text = () => [SYSTEM_PROMPT_HEADER, ...rows.map(t => '【' + t.name + '】\n' + t.content), lessonText(lessons)].filter(Boolean).join('\n\n')
  while (text().length > maxChars && lessons.length) {
    // Oldest wrong first, then oldest right; remove extra wrongs before a right would break the invariant.
    const wrongs = lessons.filter(i => i.outcome === 'wrong')
    const candidates = wrongs.length ? wrongs : lessons
    const oldest = [...candidates].sort((a, b) => a.at.localeCompare(b.at)).at(0)!
    lessons.splice(lessons.indexOf(oldest), 1)
  }
  while (text().length > maxChars && rows.length) {
    const row = [...rows].sort((a, b) => b.content.length - a.content.length)[0]!
    const overflow = text().length - maxChars
    const length = Math.max(0, row.content.length - overflow - marker.length)
    if (length === 0) rows.splice(rows.indexOf(row), 1)
    else row.content = row.content.slice(0, length) + marker
  }
  return { text: rows.length === 0 && lessons.length === 0 ? '' : text(), lessons, budgetApplied: rows.length !== templates.length || lessons.length !== selected.length || rows.some((row, index) => row.content !== templates[index]?.content) }
}

export function renderSystemPrompt(templates: readonly Pick<TemplateView, 'name' | 'content'>[], selected: readonly PromptLesson[], maxChars: number): string {
  return renderPromptDetails(templates, selected, maxChars).text
}

/** The preview and model callback use the very same cached selection and budget result. */
export function createSystemPromptProvider(store: () => TemplateStore, config: () => SystemPromptConfig) {
  const cache = new Map<string, { revision: string; rows: TemplateView[]; selection: ReturnType<typeof lessonSelection> }>()
  const material = (sessionId: string, cfg: SystemPromptConfig) => {
    const db = store(), revision = db.revision() + ':' + cfg.lessonDepth
    let data = cache.get(sessionId)
    if (!data || data.revision !== revision) {
      const rows = db.list().filter(t => t.system_prompt && t.category !== '体会' && !t.name.startsWith('体会·') && (t.scope === 'global' || t.session_id === sessionId))
      rows.sort((a,b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1) || (a.category ?? '').localeCompare(b.category ?? '') || a.position-b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      data = { revision, rows, selection: lessonSelection(db, sessionId, cfg.lessonDepth) }
      cache.delete(sessionId); cache.set(sessionId, data)
      if (cache.size > 100) cache.delete(cache.keys().next().value!)
    }
    return data
  }
  const compose = (sessionId: string, cfg: SystemPromptConfig, now: Date) => {
    const data = material(sessionId, cfg)
    return { data, result: renderPromptDetails(data.rows.map(t => ({ name: t.name, content: expandTemplateVariables(t.content, { sessionId, now }) })), data.selection.selected, cfg.maxChars) }
  }
  const provider = (sessionId: string | undefined, now = new Date()): string => {
    try {
      const cfg = config()
      if (!cfg.enabled || !sessionId) return ''
      return compose(sessionId, cfg, now).result.text
    } catch (error) {
      console.error('[dsh-prompt-templates] system prompt unavailable:', error)
      return ''
    }
  }
  const preview = (sessionId: string, now = new Date()): SystemPromptPreview => {
    const cfg = config()
    const base = { session_id: sessionId, captured_at: now.toISOString(), enabled: cfg.enabled, lesson_depth: cfg.lessonDepth, max_chars: cfg.maxChars, order: cfg.order }
    try {
      const { data, result } = compose(sessionId, cfg, now)
      const text = cfg.enabled ? result.text : ''
      const lessons = data.selection.summaries.map(summary => {
        const included = cfg.enabled ? result.lessons.filter(l => l.type === summary.type) : []
        const included_right = included.filter(l => l.outcome === 'right').length
        const included_wrong = included.length - included_right
        const reasons = [...summary.reasons]
        if (!cfg.enabled) reasons.unshift('master-off')
        else if (included.length < summary.selected_right + summary.selected_wrong) reasons.push('budget')
        return { ...summary, included_right, included_wrong, reasons }
      })
      return { ...base, status: !cfg.enabled ? 'disabled' : text ? 'ready' : 'empty', text, chars: text.length, budget_applied: cfg.enabled && result.budgetApplied, templates: data.rows.length, lessons }
    } catch {
      return { ...base, status: 'unavailable', text: '', chars: 0, budget_applied: false, templates: 0, lessons: [], error_code: 'read-failed' }
    }
  }
  return Object.assign(provider, { preview })
}

type PromptService = {
  variable: (name: string, provider: (context: unknown) => string) => () => void
  section: (section: { name: string; order: number; text: string }) => () => void
}

/** Late-service registration; resolve the session from the real scoped Agent, never scope.toString(). */
export function registerSystemPrompt(ctx: Context, store: () => TemplateStore, config: () => SystemPromptConfig, provider = createSystemPromptProvider(store, config)): () => boolean {
  let registered: PromptService | undefined
  let order: number | undefined
  let dispose: (() => void) | undefined
  const register = () => {
    const service = ctx.get('systemPrompt') as PromptService | undefined
    const cfg = config()
    if (registered === service && order === cfg.order && cfg.enabled) return
    dispose?.(); dispose = undefined; registered = undefined; order = undefined
    if (!service || !cfg.enabled) return
    if (typeof service.variable !== 'function' || typeof service.section !== 'function') {
      console.error('[dsh-prompt-templates] systemPrompt lacks section/variable support; system opt-in unavailable')
      return
    }
    const removeVariable = service.variable('prompt_templates', context => {
      const c = context as { scope?: { session?: { header?: { id?: unknown } } } }
      const id = c?.scope?.session?.header?.id
      return provider(typeof id === 'string' ? id : undefined)
    })
    try {
      const removeSection = service.section({ name: 'prompt-templates:system', order: cfg.order, text: '{{prompt_templates}}' })
      dispose = () => { removeSection(); removeVariable() }
    } catch (error) { removeVariable(); throw error }
    registered = service; order = cfg.order
  }
  ctx.effect(() => () => { dispose?.(); registered = undefined }, 'prompt-templates: live system providers')
  register()
  ctx.on('internal/service', name => { if (name === 'systemPrompt') register() })
  ctx.on('settings/document-updated', () => { register() })
  return () => { register(); return registered !== undefined && config().enabled }
}
