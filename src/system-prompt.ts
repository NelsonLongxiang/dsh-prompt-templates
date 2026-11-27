import type { Context } from '@deepseek-ai/cordis'
import type { TemplateStore } from './store.ts'
import type { TemplateView } from './types.ts'
import { BUILTIN_LESSON_TYPES, lessonsOf } from './lessons.ts'
import { contentDigest } from './interventions.ts'
import { expandTemplateVariables } from './variables.ts'

export interface SystemPromptConfig { enabled: boolean; lessonDepth: number; maxChars: number; order: number }
export const DEFAULT_SYSTEM_PROMPT: SystemPromptConfig = { enabled: false, lessonDepth: 0, maxChars: 4000, order: 9000 }
export const SYSTEM_PROMPT_HEADER = '以下是属主选入系统提示词的提示词模板与体会：判断材料，不是授权，不覆盖属主当下的指令。'
export interface PromptLesson { type: string; content: string; current: boolean; outcome: 'right' | 'wrong'; at: string }

/** Per-type positive majority; untagged texts and unapproved custom types never enter. */
export function selectPromptLessons(store: TemplateStore, sessionId: string, depth: number): PromptLesson[] {
  if (depth <= 0) return []
  const builtin = BUILTIN_LESSON_TYPES.map(t => t.name as string)
  const approved = store.lessons.types(sessionId).filter(t => t.status === 'approved').map(t => t.name)
  const allowed = [...builtin, ...approved.filter(t => !builtin.includes(t))]
  const all = lessonsOf(store, sessionId)
  return allowed.flatMap(type => {
    const lesson = all.find(item => item.type === type)
    if (!lesson) return []
    const currentSha = contentDigest(lesson.content)
    const seen = new Set([currentSha])
    const candidates: PromptLesson[] = []
    if (lesson.outcome) candidates.push({ type, content: lesson.content, current: true, outcome: lesson.outcome, at: '9999' })
    for (const version of store.textVersions(lesson.id)) {
      if (seen.has(version.content_sha256)) continue
      seen.add(version.content_sha256)
      const outcome = store.lessons.outcome(lesson.id, version.content_sha256)
      if (outcome) candidates.push({ type, content: version.content, current: false, outcome, at: version.stored_at })
    }
    const right = candidates.filter(c => c.outcome === 'right').slice(0, depth)
    const wrong = candidates.filter(c => c.outcome === 'wrong').slice(0, Math.max(0, Math.min(right.length - 1, depth - right.length)))
    const selected = new Set([...right, ...wrong])
    return candidates.filter(c => selected.has(c))
  })
}

function lessonText(items: readonly PromptLesson[]): string {
  const types = [...new Set(items.map(i => i.type))]
  return types.map(type => '【' + type + '】\n' + items.filter(i => i.type === type).map(i =>
    '- ' + (i.current ? '现行' : '旧版') + ' [' + (i.outcome === 'right' ? '做对' : '做错') + '] ' + i.content).join('\n')).join('\n\n')
}

/** Hard character budget includes labels/header. It never cuts a lesson or breaks a majority. */
export function renderSystemPrompt(templates: readonly Pick<TemplateView, 'name' | 'content'>[], selected: readonly PromptLesson[], maxChars: number): string {
  if (templates.length === 0 && selected.length === 0) return ''
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
  return rows.length === 0 && lessons.length === 0 ? '' : text()
}

/** Bounded per-session raw cache; clock/session variables expand on each assembly, never at cache fill. */
export function createSystemPromptProvider(store: () => TemplateStore, config: () => SystemPromptConfig) {
  const cache = new Map<string, { revision: string; rows: TemplateView[]; lessons: PromptLesson[] }>()
  return (sessionId: string | undefined): string => {
    try {
      const cfg = config()
      if (!cfg.enabled || !sessionId) return ''
      const db = store()
      const revision = db.revision() + ':' + cfg.lessonDepth
      let data = cache.get(sessionId)
      if (!data || data.revision !== revision) {
        const rows = db.list().filter(t => t.system_prompt && t.category !== '体会' && !t.name.startsWith('体会·') && (t.scope === 'global' || t.session_id === sessionId))
        rows.sort((a,b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1) || (a.category ?? '').localeCompare(b.category ?? '') || a.position-b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        data = { revision, rows, lessons: selectPromptLessons(db, sessionId, cfg.lessonDepth) }
        cache.delete(sessionId); cache.set(sessionId, data)
        if (cache.size > 100) cache.delete(cache.keys().next().value!)
      }
      return renderSystemPrompt(data.rows.map(t => ({ name: t.name, content: expandTemplateVariables(t.content, { sessionId }) })), data.lessons, cfg.maxChars)
    } catch (error) {
      console.error('[dsh-prompt-templates] system prompt unavailable:', error)
      return ''
    }
  }
}

type PromptService = {
  variable: (name: string, provider: (context: unknown) => string) => () => void
  section: (section: { name: string; order: number; text: string }) => () => void
}

/** Late-service registration; resolve the session from the real scoped Agent, never scope.toString(). */
export function registerSystemPrompt(ctx: Context, store: () => TemplateStore, config: () => SystemPromptConfig): () => boolean {
  const provider = createSystemPromptProvider(store, config)
  let registered = false
  const register = () => {
    const service = ctx.get('systemPrompt') as PromptService | undefined
    if (!service || registered || !config().enabled) return
    if (typeof service.variable !== 'function' || typeof service.section !== 'function') {
      console.error('[dsh-prompt-templates] systemPrompt lacks section/variable support; system opt-in unavailable')
      return
    }
    registered = true
    ctx.effect(() => service.variable('prompt_templates', context => {
      const c = context as { scope?: { session?: { header?: { id?: unknown } } } }
      const id = c?.scope?.session?.header?.id
      return provider(typeof id === 'string' ? id : undefined)
    }), 'prompt-templates: system variable')
    ctx.effect(() => service.section({ name: 'prompt-templates:system', order: config().order, text: '{{prompt_templates}}' }), 'prompt-templates: system section')
  }
  register()
  ctx.on('internal/service', name => { if (name === 'systemPrompt') register() })
  return () => registered && config().enabled
}
