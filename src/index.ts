/**
 * dsh-prompt-templates host half: a pure-TS template store over
 * `node:sqlite` (same schema and database file as the former Python
 * backend child) exposed over web-server routes the browser panel fetches
 * (`/plugins/dsh-prompt-templates/*`). The plugin owns the store, the
 * routes, and the settings namespace (panel default-open + placement).
 *
 * Route map (JSON bodies, `Cache-Control: no-store`):
 *   GET    /plugins/dsh-prompt-templates/templates        → { items }
 *   POST   /plugins/dsh-prompt-templates/templates        → { template }
 *   GET    /plugins/dsh-prompt-templates/templates/:id    → { template } | 404
 *   PATCH  /plugins/dsh-prompt-templates/templates/:id    → { template } | 404
 *   POST   /plugins/dsh-prompt-templates/templates/:id/make-global → { template } | 404
 *   DELETE /plugins/dsh-prompt-templates/templates/:id    → { deleted }
 *
 * @module dsh-prompt-templates
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import s from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { TemplateRuleError, TemplateStore } from './store.ts'
import type { TemplateView } from './types.ts'

export type * from './types.ts'

export const name = 'prompt-templates'

/** Deployment-varying persistence facts. */
export interface Config {
  /** Optional explicit SQLite database path; defaults to `$DSH_HOME/ext/prompt-templates/db.sqlite3`. */
  readonly dbPath?: string | null
}

export const Config: s<Config> = s.object({
  dbPath: s.string(),
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
    store ??= new TemplateStore(config.dbPath ?? defaultDbPath())
    return store
  }
  ctx.effect(() => () => { store?.close() }, 'prompt-templates: store close')

  // Browser preference namespace (panel default-open and remembered
  // position), optional: without a mounted settings provider the client
  // scope simply reports unavailable.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace('prompt-templates'), s.object({
      defaultOpen: s.boolean().default(false),
      panel: s.object({ x: s.number(), y: s.number() }),
    }))
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
      handler: (req, res) => { void handle(req, res, client) },
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const segments = url.pathname.split('/').filter(part => part !== '')
  // Expect ['plugins', 'dsh-prompt-templates', 'templates', ...rest].
  const rest = segments.slice(3)
  const method = req.method ?? 'GET'
  try {
    // Category tabs live at /plugins/dsh-prompt-templates/categories (their
    // own namespace, not under templates): GET/POST on it, DELETE on
    // /categories/:name?scope&session_id. This MUST be dispatched before
    // the template verbs — a bare rest slice of [] is shared with both.
    if (rest[0] === 'categories') {
      if (rest.length === 1 && method === 'GET') {
        return json(res, 200, { items: client().listCategories() })
      }
      if (rest.length === 1 && method === 'POST') {
        const body = await readJson(req)
        const category = client().createCategory(body as unknown as Parameters<TemplateStore['createCategory']>[0])
        return json(res, 200, { category })
      }
      const catName = rest[1]
      if (catName !== undefined && rest.length === 2 && method === 'DELETE') {
        const deleted = client().deleteCategory(
          decodeURIComponent(catName),
          url.searchParams.get('scope') ?? 'global',
          url.searchParams.get('session_id'),
        )
        return json(res, 200, { deleted })
      }
      return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
    }
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
      const deleted = client().delete(id)
      return json(res, 200, { deleted })
    }
    return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
  } catch (error) {
    if (error instanceof TemplateRuleError) {
      return json(res, 400, errorBody('rule-violation', error.message))
    }
    const message = error instanceof Error ? error.message : String(error)
    return json(res, 500, errorBody('store-error', message))
  }
}

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
        reject(error)
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

