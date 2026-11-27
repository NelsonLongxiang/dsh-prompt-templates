/**
 * dsh-prompt-templates host half: a pure-TS template store over
 * `node:sqlite` (same schema and database file as the former Python
 * backend child) exposed over web-server routes the browser panel fetches
 * (`/plugins/dsh-prompt-templates/*`). The plugin owns the store, the
 * routes, the settings namespace (panel default-open + placement), and the
 * scheduled auto-injection listener that re-surfaces inject-enabled
 * templates every N rounds.
 *
 * Route map (JSON bodies, `Cache-Control: no-store`):
 *   GET    /plugins/dsh-prompt-templates/templates        → { items }
 *   POST   /plugins/dsh-prompt-templates/templates        → { template }
 *   GET    /plugins/dsh-prompt-templates/templates/:id    → { template } | 404
 *   PATCH  /plugins/dsh-prompt-templates/templates/:id    → { template } | 404
 *   POST   /plugins/dsh-prompt-templates/templates/:id/make-global → { template } | 404
 *   DELETE /plugins/dsh-prompt-templates/templates/:id    → { deleted }
 *   GET    /plugins/dsh-prompt-templates/inject-status?session_id=… → { status, history }
 *   GET    /plugins/dsh-prompt-templates/event-policies             → { items }
 *   PATCH  /plugins/dsh-prompt-templates/event-policies/master      → { config }
 *   PATCH  /plugins/dsh-prompt-templates/event-policies/:rule_id    → { policy } | 404
 *   GET    /plugins/dsh-prompt-templates/event-episodes?session_id=… → { items, outbox } (each item carries `handoff`)
 *   PATCH  /plugins/dsh-prompt-templates/event-episodes/:id         → { episode } | 404 (evidence_refs required)
 *   GET    /plugins/dsh-prompt-templates/library[?session_id=]      → { items, schema } (read-only card library, v9; with session_id: that session's own templates)
 *   POST   /plugins/dsh-prompt-templates/library/import             → { plan } (versioned pack; dry run unless apply: true)
 *   GET    /plugins/dsh-prompt-templates/interventions?session_id=&since=&source=&limit= → { items, schema } (read-only, v9)
 *   POST   /plugins/dsh-prompt-templates/interventions/manual       → { intervention } (the panel's insert/send/interject)
 *   GET    /plugins/dsh-prompt-templates/lessons?session_id=        → { items, log, schema } (read-only, v11; no lesson text)
 *   PATCH  /plugins/dsh-prompt-templates/lessons/:template_id       { pinned } → { id, pinned } (the owner pins; phase 2)
 *   GET    /plugins/dsh-prompt-templates/version                    → { name, version, schema, loaded_at, features } (B5b; read-only)
 *   POST   /plugins/dsh-prompt-templates/lessons/:template_id/verdict { verdict, ref } → { id, round, verdict, ref } (B3b; owner only, never closes a round)
 *   PATCH  /plugins/dsh-prompt-templates/lesson-types/:name?session_id= { approved } → { name, status } (the owner decides a proposed type)
 *
 * @module dsh-prompt-templates
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import s from '@deepseek-ai/schemastery'
// Type-only: dsh-settings's declaration merging puts `ctx.settings` on
// Context (alpha.3 removed the runtime settingsNamespace helper, but the
// type mount stays — an empty type import keeps it without pulling the
// deleted helper).
import type { } from '@deepseek-ai/dsh-settings'
import { DEFAULT_SYSTEM_PROMPT, registerSystemPrompt, type SystemPromptConfig } from './system-prompt.ts'
import { DEFAULT_EVENT_INJECT_CONFIG, registerEventInject } from './event-inject.ts'
import { EventRuleError } from './event-store.ts'
import type { EventPolicyUpdate } from './event-store.ts'
import { registerAutoInject } from './inject.ts'
import type { InjectionStatusView } from './inject.ts'
import { DEFAULT_INJECT_MAX_EVERY, SCHEMA_VERSION, ConfirmGlobalError, TemplateRuleError, TemplateStore } from './store.ts'
import { INTERVENTION_SOURCES, MANUAL_METHODS, contentDigest, type InterventionSource, type ManualMethod } from './interventions.ts'
import { registerCast, type PromptTemplatesService } from './cast.ts'
import { registerEvidenceReady } from './evidence-ready.ts'
import { registerSelfCheck } from './self-check.ts'
import { BUILTIN_LESSON_TYPES, DEFAULT_LESSONS_CONFIG, attachVerdict, decideLessonType, lessonChurn, lessonsOf, openCardRound, pinLesson, registerLessons, type LessonsConfig } from './lessons.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-prompt-templates' service for other plugins (observer phase 2). */
    promptTemplates: PromptTemplatesService
  }
}
import type { InjectionHistoryEntry, TemplateView } from './types.ts'

export type * from './types.ts'

export const name = 'prompt-templates'

/** Deployment-varying persistence facts. */
export interface Config {
  /** Optional explicit SQLite database path; defaults to `$DSH_HOME/ext/prompt-templates/db.sqlite3`. */
  readonly dbPath?: string | null
  /** Scheduled-injection master switch; `false` keeps the listener pass-through. */
  readonly injectEnabled?: boolean
  /** Auto-add Atelier session self-assessment once; never overwrites user settings. */
  readonly evolutionAssessmentEnabled?: boolean
  /** Upper bound accepted for a template's inject interval (`inject_every`). */
  readonly injectMaxEvery?: number
  /** Event-triggered reminders; off by default and independent of `injectEnabled`. */
  readonly eventInject?: {
    readonly enabled?: boolean
    readonly maxPerTurn?: number
    readonly maxChars?: number
    readonly maxAttempts?: number
    readonly observationWindow?: number
    readonly ignoreTools?: string[]
  }
  /** Observer phase 2: other plugins may cast a card into a session (only a recognized caller); off by default. */
  readonly cast?: { readonly enabled?: boolean }
  /** Observer phase 2: the wrap-up self-check and its two tools; on by default (owner decision 2026-11-21), `enabled: false` turns it off. */
  readonly selfCheck?: { readonly enabled?: boolean }
  /** 体会 (docs/spec-lesson-inject.md): digest prompts, lesson_write and situational recall; on by default (owner decision 2026-11-21), `enabled: false` turns it off. */
  readonly systemPrompt?: Partial<SystemPromptConfig> | Volatile<Partial<SystemPromptConfig>>
  readonly lessons?: Partial<LessonsConfig>
}

export const Config: s<Config> = s.object({
  dbPath: s.string(),
  injectEnabled: s.boolean().default(true),
  evolutionAssessmentEnabled: s.boolean().default(true),
  injectMaxEvery: s.number().default(DEFAULT_INJECT_MAX_EVERY),
  systemPrompt: s.object({
    enabled: s.boolean().default(false),
    lessonDepth: s.natural().min(0).max(20).default(0),
    maxChars: s.natural().min(500).max(20000).default(4000),
    order: s.natural().min(200).max(10199).default(9000),
  }).default({}).volatile(),
  eventInject: s.object({
    enabled: s.boolean().default(DEFAULT_EVENT_INJECT_CONFIG.enabled),
    maxPerTurn: s.natural().min(1).default(DEFAULT_EVENT_INJECT_CONFIG.maxPerTurn),
    maxChars: s.natural().min(80).default(DEFAULT_EVENT_INJECT_CONFIG.maxChars),
    maxAttempts: s.natural().min(1).default(DEFAULT_EVENT_INJECT_CONFIG.maxAttempts),
    observationWindow: s.natural().min(10).default(DEFAULT_EVENT_INJECT_CONFIG.observationWindow),
    ignoreTools: s.array(s.string()).default([]),
  }).default({}),
  cast: s.object({ enabled: s.boolean().default(false) }).default({}),
  selfCheck: s.object({ enabled: s.boolean().default(true) }).default({}),
  lessons: s.object({
    enabled: s.boolean().default(DEFAULT_LESSONS_CONFIG.enabled),
    mode: s.union(['inject', 'visible'] as const).default(DEFAULT_LESSONS_CONFIG.mode),
    maxPerSession: s.natural().min(1).max(100).default(DEFAULT_LESSONS_CONFIG.maxPerSession),
    digestCooldownTurns: s.natural().min(1).default(DEFAULT_LESSONS_CONFIG.digestCooldownTurns),
    recallCooldownTurns: s.natural().min(1).default(DEFAULT_LESSONS_CONFIG.recallCooldownTurns),
    maxRecallChars: s.natural().min(40).max(600).default(DEFAULT_LESSONS_CONFIG.maxRecallChars),
    maxPinned: s.natural().min(1).max(10).default(DEFAULT_LESSONS_CONFIG.maxPinned),
  }).default({}),
})

/** Structural slice of the web-server service (route registration only). */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const

/**
 * B5b (owner 2026-11-21): the version of the server code the host actually loaded, read from the package that holds
 * it (`src/` and `lib/` both sit one level below the package root). `unknown` when the manifest cannot be read.
 */
export function loadedPackage(manifestUrl: URL = new URL('../package.json', import.meta.url)): { name: string; version: string } {
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { name?: unknown; version?: unknown }
    return {
      name: typeof manifest.name === 'string' ? manifest.name : 'unknown',
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    }
  } catch {
    return { name: 'unknown', version: 'unknown' }
  }
}

/** What GET /version reports: the loaded server version, when it was applied, and which features are on. */
export interface RuntimeView {
  readonly name: string
  readonly version: string
  readonly schema: number
  readonly loaded_at: string
  readonly features: { readonly inject: boolean; readonly lessons: boolean; readonly selfCheck: boolean; readonly cast: boolean; readonly eventInject: boolean }
}

/** Resolve the default database path under `$DSH_HOME` (default `~/.dsh`). */
function defaultDbPath(): string {
  const home = process.env['DSH_HOME'] ?? `${process.getBuiltinModule('node:os').homedir()}/.dsh`
  return `${home.replaceAll('\\', '/')}/ext/prompt-templates/db.sqlite3`
}

/** Business error envelope shared with the browser face. */
export interface TemplateError {
  readonly code: string
  readonly message: string
}

/**
 * Host plugin body: own the template store, register the settings
 * namespace, and lazily register the web routes once a web server is live;
 * headless profiles without a web server never block boot.
 * @param ctx - Host context.
 * @param config - persistence facts.
 */
export function apply(ctx: Context, config: Config): void {
  let store: TemplateStore | undefined
  const client = (): TemplateStore => {
    store ??= new TemplateStore(config.dbPath ?? defaultDbPath(), {
      injectMaxEvery: config.injectMaxEvery ?? DEFAULT_INJECT_MAX_EVERY,
    })
    return store
  }
  ctx.effect(() => () => { store?.close() }, 'prompt-templates: store close')

  // Scheduled auto-injection rides the agent loop's pre-step waterfall and
  // shares the route's store; it needs no web server, so headless profiles
  // inject too. The handle feeds the inject-status route (panel badge).
  const inject = registerAutoInject(ctx, {
    enabled: config.injectEnabled ?? true,
    evolutionAssessmentEnabled: config.evolutionAssessmentEnabled ?? true,
    // Workshop cards open a card round (lesson or stated no-entry) when lessons are on (owner 2026-11-21, option A).
    onWorkshopCards: (sessionId, turn, cards, options) => lessonsConfig.enabled ? openCardRound(client(), sessionId, turn, cards, options) : null,
  }, client)
  // Event-triggered reminders: a separate observer + pre-step consumer,
  // inert unless the deployment AND a rule policy turn them on.
  const eventInjectConfig = { ...DEFAULT_EVENT_INJECT_CONFIG, ...config.eventInject }
  // Observer phase 2 (PT-3): the service other plugins read (library, a session's templates, the log) and the cast,
  // which only a recognized caller may use and only while cast.enabled is on.
  registerCast(ctx, client, () => config.cast?.enabled === true, () => config.selfCheck?.enabled !== false)
  // Observer phase 2 (PT-4): the wrap-up self-check, on unless selfCheck.enabled is false (owner decision 2026-11-21).
  registerSelfCheck(ctx, client, () => config.selfCheck?.enabled !== false)
  // 体会 (docs/spec-lesson-inject.md, phase 1): on unless lessons.enabled is false (owner decision 2026-11-21).
  const lessonsConfig: LessonsConfig = { ...DEFAULT_LESSONS_CONFIG, ...config.lessons }
  const systemConfig = (): SystemPromptConfig => {
    const value = config.systemPrompt
    return { ...DEFAULT_SYSTEM_PROMPT, ...(value && 'get' in value ? value.get() : value) }
  }
  const systemReady = registerSystemPrompt(ctx, client, systemConfig)
  registerLessons(ctx, client, () => lessonsConfig, () => systemReady() && systemConfig().lessonDepth > 0)
  registerEventInject(ctx, eventInjectConfig, () => client().events, () => client().interventions)
  // #81: evidence-ready reminders at the next actionable step; off with casting (cast.enabled).
  registerEvidenceReady(ctx, () => client().evidence, () => config.cast?.enabled === true, () => client().interventions)

  // B5b: host-side evidence of what is loaded — read once when the host applies the plugin.
  const loaded = { ...loadedPackage(), loaded_at: new Date().toISOString() }
  const runtime = (): RuntimeView => ({
    ...loaded, schema: SCHEMA_VERSION,
    features: {
      inject: config.injectEnabled ?? true,
      lessons: lessonsConfig.enabled,
      selfCheck: config.selfCheck?.enabled !== false,
      cast: config.cast?.enabled === true,
      eventInject: client().events.masterEnabled(eventInjectConfig.enabled),
    },
  })

  let routesRegistered = false
  const registerRoutes = (): void => {
    if (routesRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    if (webServer === undefined) return
    routesRegistered = true

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-prompt-templates',
      handler: (req, res) => { void handle(req, res, client, inject.status, inject.history, () => client().events.masterEnabled(eventInjectConfig.enabled), () => lessonsConfig, runtime, () => {
        try {
          const registry = ctx.get('agents') as { list?: () => Array<{ status?: string }> } | undefined
          const agents = registry?.list?.()
          return agents ? { running: agents.filter(a => a.status === 'running').length, live: agents.length } : { running: null, live: null }
        } catch { return { running: null, live: null } }
      }) },
    }), 'prompt-templates: api routes')
  }
  registerRoutes()
  ctx.on('internal/service', (serviceName: string) => {
    if (WEB_SERVER_KEYS.includes(serviceName as (typeof WEB_SERVER_KEYS)[number])) {
      registerRoutes()
    }
  })
}

/** Dispatch one API request against the template store. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  client: () => TemplateStore,
  injectStatus: (sessionId: string) => InjectionStatusView | null,
  injectHistory: (sessionId: string) => readonly InjectionHistoryEntry[],
  eventInjectEnabled: () => boolean,
  lessonsConfig: () => LessonsConfig = () => DEFAULT_LESSONS_CONFIG,
  runtime?: () => RuntimeView,
  systemImpact?: () => { running: number | null; live: number | null },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const segments = url.pathname.split('/').filter(part => part !== '')
  // Route namespace: `/plugins/dsh-prompt-templates/<resource>/...`.
  // `templates` and `categories` are both segments[2]; their operation
  // remainder starts at index 3. Dispatching categories from rest[0] made
  // its root URL (`/categories`) indistinguishable from `/templates`.
  const resource = segments[2]
  const rest = segments.slice(3)
  const method = req.method ?? 'GET'
  try {
    if (resource === 'system-impact' && rest.length === 0) {
      if (method !== 'GET') return json(res, 405, errorBody('method-not-allowed', method))
      return json(res, 200, systemImpact?.() ?? { running: null, live: null })
    }
    // B5b: which server version the host loaded, when, and which features are on. Read-only.
    if (resource === 'version' && rest.length === 0) {
      if (method !== 'GET') return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
      if (runtime === undefined) return json(res, 404, errorBody('not-found', 'no runtime view'))
      return json(res, 200, runtime())
    }
    // Category tabs: GET/POST /categories, DELETE /categories/:name?scope&session_id.
    if (resource === 'categories') {
      if (rest.length === 0 && method === 'GET') {
        return json(res, 200, { items: client().listCategories(url.searchParams.get('session_id') ?? undefined) })
      }
      if (rest.length === 0 && method === 'POST') {
        const body = await readJson(req)
        const category = client().createCategory(body as unknown as Parameters<TemplateStore['createCategory']>[0])
        return json(res, 200, { category })
      }
      const catName = rest[0]
      if (catName !== undefined && rest.length === 1 && method === 'DELETE') {
        const deleted = client().deleteCategory(
          decodeURIComponent(catName),
          url.searchParams.get('scope') ?? 'global',
          url.searchParams.get('session_id'),
        )
        return json(res, 200, { deleted })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    // Scheduled-injection status: memory-only, never rescans the log, and is
    // session-scoped — an unknown session is a plain null, not an error.
    // Observer phase 1 (v9): the read-only library and intervention faces. `schema` lets a reader (the a2a observer) tell
    // whether this plugin is new enough; phase 2 offers the same shapes as a service to other plugins.
    if (resource === 'library') {
      if (rest.length === 0 && method === 'GET') {
        // `?session_id=` narrows to that session's own templates (scope session), e.g. its own self-check cards (#888).
        const sessionId = url.searchParams.get('session_id')
        const items = client().library()
        return json(res, 200, { schema: SCHEMA_VERSION, items: sessionId === null ? items : items.filter(card => card.scope === 'session' && card.session_id === sessionId) })
      }
      if (rest[0] === 'import' && rest.length === 1 && method === 'POST') {
        const body = await readJson(req)
        try {
          return json(res, 200, { plan: client().importLibraryPack(body['pack'], body['apply'] === true) })
        } catch (error) {
          if (error instanceof TemplateRuleError) return json(res, 400, errorBody('bad-request', error.message))
          throw error
        }
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    // PT-4: one session's wrap-up self-check log (read-only): injections, conclusions, orphans, hints.
    if (resource === 'self-checks') {
      if (rest.length === 0 && method === 'GET') {
        const sessionId = url.searchParams.get('session_id')
        if (sessionId === null || sessionId === '') return json(res, 400, errorBody('bad-request', 'missing session_id'))
        return json(res, 200, { schema: SCHEMA_VERSION, items: client().selfChecks.list(sessionId, Number(url.searchParams.get('limit') ?? 100)) })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    // 体会 (v11): one session's lessons and what the plugin did, read-only. No lesson text: the panel shows it as templates.
    if (resource === 'lessons') {
      if (rest.length === 0 && method === 'GET') {
        const sessionId = url.searchParams.get('session_id')
        if (sessionId === null || sessionId === '') return json(res, 400, errorBody('bad-request', 'missing session_id'))
        const store = client()
        const items = lessonsOf(store, sessionId).map(lesson => {
          const cue = store.lessons.cue(lesson.id)
          return { id: lesson.id, key: lesson.key, type: lesson.type, index: lesson.index, version: lesson.version, content_sha256: contentDigest(lesson.content),
            origin: cue?.origin ?? null, pinned: cue?.pinned === 1, recall_count: cue?.recall_count ?? 0, last_recalled_turn: cue?.last_recalled_turn ?? null,
            rounds: store.lessons.rounds(lesson.id), churn: lessonChurn(store, lesson.id), recurrence: store.lessons.recurrence(lesson.id), evidence: store.lessons.evidence(lesson.id, contentDigest(lesson.content)) ?? null, verdicts: store.lessons.verdicts(lesson.id),
            outcome: lesson.outcome, latest_evidence: store.lessons.latestKeep(lesson.id) ?? store.lessons.evidence(lesson.id, contentDigest(lesson.content)) ?? null }
        })
        const types = [...BUILTIN_LESSON_TYPES.map(t => ({ name: t.name, description: t.description, builtin: true, status: 'approved' })),
          ...store.lessons.types(sessionId).map(t => ({ name: t.name, description: t.description, builtin: false, status: t.status, proposed_at: t.proposed_at, decided_at: t.decided_at }))]
        return json(res, 200, { schema: SCHEMA_VERSION, items, types, cards: store.lessons.cardStats(sessionId), log: store.lessons.log(sessionId, Number(url.searchParams.get('limit') ?? 100)) })
      }
      // Phase 2: the owner pins a lesson; it is loaded at the session's next start, resume or compaction.
      const lessonId = rest[0]
      if (lessonId !== undefined && rest.length === 1 && method === 'PATCH') {
        const body = await readJson(req)
        if (typeof body['pinned'] !== 'boolean') return json(res, 400, errorBody('bad-request', 'pinned must be true or false'))
        const result = pinLesson(client(), decodeURIComponent(lessonId), body['pinned'], lessonsConfig().maxPinned)
        if (!result.ok) return json(res, result.code === 'not-found' ? 404 : 409, errorBody(result.code, result.error))
        return json(res, 200, { id: result.id, pinned: result.pinned })
      }
      // B3b: the owner attaches an external verdict (review, CI, receipt) to the lesson's latest round. Recorded only.
      if (lessonId !== undefined && rest.length === 2 && rest[1] === 'verdict' && method === 'POST') {
        const body = await readJson(req)
        const result = attachVerdict(client(), decodeURIComponent(lessonId), body['verdict'], body['ref'])
        if (!result.ok) return json(res, result.code === 'not-found' ? 404 : 400, errorBody(result.code, result.error))
        return json(res, 200, result)
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    // A session proposes its own lesson type with lesson_type_propose; only the owner approves or rejects it here.
    if (resource === 'lesson-types') {
      const name = rest[0]
      if (name !== undefined && rest.length === 1 && method === 'PATCH') {
        const sessionId = url.searchParams.get('session_id')
        if (sessionId === null || sessionId === '') return json(res, 400, errorBody('bad-request', 'missing session_id'))
        const body = await readJson(req)
        if (typeof body['approved'] !== 'boolean') return json(res, 400, errorBody('bad-request', 'approved must be true or false'))
        const result = decideLessonType(client(), sessionId, decodeURIComponent(name), body['approved'])
        if (!result.ok) return json(res, 404, errorBody(result.code, result.error))
        return json(res, 200, { name: decodeURIComponent(name), status: body['approved'] ? 'approved' : 'rejected' })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    if (resource === 'interventions') {
      if (rest.length === 0 && method === 'GET') {
        const sessionId = url.searchParams.get('session_id') ?? undefined
        const since = url.searchParams.get('since') ?? undefined
        const source = url.searchParams.get('source') ?? undefined
        const limit = url.searchParams.get('limit')
        if (source !== undefined && !INTERVENTION_SOURCES.includes(source as InterventionSource)) return json(res, 400, errorBody('bad-request', 'source must be schedule, event, manual or plugin'))
        if (since !== undefined && Number.isNaN(Date.parse(since))) return json(res, 400, errorBody('bad-request', 'since must be an ISO time'))
        const items = client().interventions.list({ ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}), ...(since !== undefined ? { since: new Date(since).toISOString() } : {}),
          ...(source !== undefined ? { source: source as InterventionSource } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) })
        return json(res, 200, { schema: SCHEMA_VERSION, items })
      }
      // The panel records what a person sent by hand: the host cannot see the composer, so the panel says so. The host
      // looks the template up and stores its identity and a digest, never the text.
      if (rest[0] === 'manual' && rest.length === 1 && method === 'POST') {
        const body = await readJson(req)
        const sessionId = body['session_id'], templateId = body['template_id'], how = body['method'], sent = body['content']
        if (typeof sessionId !== 'string' || sessionId === '' || typeof templateId !== 'string' || !MANUAL_METHODS.includes(how as ManualMethod)) {
          return json(res, 400, errorBody('bad-request', 'session_id, template_id and method (insert, send or interject) are required'))
        }
        const template = client().get(templateId)
        if (template === undefined) return json(res, 404, notFound(templateId))
        // `content` is the expanded text the panel sent; its digest is stored, not the text. Without it, the template's own.
        const intervention = client().interventions.record({ session_id: sessionId, source: 'manual', method: how as ManualMethod, caller: null, template_id: template.id, template_name: template.name,
          template_version: template.version ?? null, content_sha256: contentDigest(typeof sent === 'string' ? sent : template.content), turn: null, step: null })
        return json(res, 200, { intervention })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    if (resource === 'inject-status') {
      if (method !== 'GET') return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
      const sessionId = url.searchParams.get('session_id')
      if (sessionId === null || sessionId === '') return json(res, 400, errorBody('bad-request', 'missing session_id'))
      return json(res, 200, { status: injectStatus(sessionId), history: injectHistory(sessionId) })
    }
    // Event-reminder audit surface: policies and per-session episodes. A
    // resolution must carry evidence references; self-reports are refused.
    if (resource === 'event-policies') {
      // The config block carries the deployment master switch so the panel
      // can show the feature's deployment state alongside the rule toggles.
      if (rest.length === 0 && method === 'GET') {
        return json(res, 200, { items: client().events.policies(), config: { enabled: eventInjectEnabled() } })
      }
      // The master switch is panel-owned state (seeded from deployment
      // config on first read); flipping it takes effect without a restart.
      if (rest[0] === 'master' && rest.length === 1 && method === 'PATCH') {
        const body = await readJson(req)
        const enabled = client().events.setMasterEnabled(body['enabled'] === true)
        return json(res, 200, { config: { enabled } })
      }
      const ruleId = rest[0]
      if (ruleId !== undefined && rest.length === 1 && method === 'PATCH') {
        const body = await readJson(req)
        const policy = client().events.updatePolicy(decodeURIComponent(ruleId), body as EventPolicyUpdate)
        if (policy === undefined) return json(res, 404, errorBody('not-found', `event rule ${ruleId} not found`))
        return json(res, 200, { policy })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    if (resource === 'event-episodes') {
      if (rest.length === 0 && method === 'GET') {
        const sessionId = url.searchParams.get('session_id')
        if (sessionId === null || sessionId === '') return json(res, 400, errorBody('bad-request', 'missing session_id'))
        const events = client().events
        // `handoff`: where the episode stands once reminding has run out (none / due / pending / sent / failed).
        return json(res, 200, { items: events.episodes(sessionId).map(episode => ({ ...episode, handoff: events.handoffState(episode) })), outbox: events.outbox(sessionId) })
      }
      const episodeId = rest[0]
      if (episodeId !== undefined && rest.length === 1 && method === 'PATCH') {
        const body = await readJson(req)
        const episode = client().events.resolveEpisode(decodeURIComponent(episodeId), body['state'], body['evidence_refs'], body['note'])
        if (episode === undefined) return json(res, 404, errorBody('not-found', `episode ${episodeId} not found`))
        return json(res, 200, { episode })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
    if (resource !== 'templates') return json(res, 404, errorBody('not-found', url.pathname))
    if (rest.length === 0 && method === 'GET') {
      const items = client().list()
      return json(res, 200, { items })
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readJson(req)
      const template = client().create(body as unknown as Parameters<TemplateStore['create']>[0])
      return json(res, 200, { template })
    }
    const id = rest[0]
    if (id === undefined) return json(res, 400, errorBody('bad-request', 'missing template id'))
    if (rest.length === 1 && method === 'GET') {
      const template = client().get(id)
      if (template === undefined) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 1 && method === 'PATCH') {
      const body = await readJson(req)
      const template = client().update(id, body as unknown as Parameters<TemplateStore['update']>[1])
      if (template === undefined) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 2 && rest[1] === 'make-global' && method === 'POST') {
      const template = client().makeGlobal(id)
      if (template === undefined) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 1 && method === 'DELETE') {
      const body = await readJson(req)
      const deleted = client().delete(id, body['confirm_global'] === true)
      return json(res, 200, { deleted })
    }
    return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
  } catch (error) {
    if (error instanceof ConfirmGlobalError) return json(res, 409, errorBody('confirm-global', error.message))
    if (error instanceof TemplateRuleError || error instanceof EventRuleError) {
      return json(res, 400, errorBody('rule-violation', error.message))
    }
    if (error instanceof MalformedBodyError) {
      return json(res, 400, errorBody('bad-request', error.message))
    }
    const message = error instanceof Error ? error.message : String(error)
    return json(res, 500, errorBody('store-error', message))
  }
}

/** A request body that failed JSON parsing: the client's fault, so 400. */
class MalformedBodyError extends Error {}

/** Read and parse one JSON request body. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reject(new MalformedBodyError(`malformed JSON body: ${message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response with no-store caching. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** The not-found envelope for one template id. */
function notFound(id: string): unknown {
  return errorBody('not-found', `template ${id} not found`)
}

/** The business error envelope. */
function errorBody(code: string, message: string): unknown {
  return { error: { code, message } }
}

export { TemplateStore, TemplateRuleError } from './store.ts'
export type { TemplateRow } from './store.ts'
