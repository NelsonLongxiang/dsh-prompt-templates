/**
 * dsh-prompt-templates host half: spawns the Python backend child through
 * the subprocess seam and exposes template CRUD over web-server routes the
 * browser panel fetches (`/plugins/dsh-prompt-templates/*`). The Python
 * child owns all durable state; this plugin owns the child process, the
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
import { PythonBridge, PythonBridgeError } from '@jf/dsh-python-bridge'
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { TemplateView } from './types.ts'

export type * from './types.ts'

export const name = 'prompt-templates'

/** Spawns the Python child; the web-server route registration waits for it lazily. */
export const inject = ['subprocess']

/** Deployment-varying spawn facts for the Python backend child. */
export interface Config {
  /** Complete argv; `argv[0]` is the executable running the backend `serve`. */
  readonly command: string[]
  /** Absolute working directory for the child. */
  readonly cwd?: string | null
  /** Grace (ms) for the stdin-EOF quiesce before terminate escalation. */
  readonly eofGraceMs?: number | null
  /** Optional explicit database path forwarded as `--db`. */
  readonly dbPath?: string | null
}

export const Config: s<Config> = s.object({
  command: s.array(s.string()).required(),
  cwd: s.string(),
  eofGraceMs: s.number(),
  dbPath: s.string(),
})

/** Default grace for the child's EOF-driven quiesce. */
export const DEFAULT_EOF_GRACE_MS = 6_000

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

/** Business error envelope shared with the browser face. */
export interface TemplateError {
  readonly code: string
  readonly message: string
}

/**
 * Host plugin body: lazily register the web routes once the web server and
 * this plugin's subprocess seam are both live; headless profiles without a
 * web server never block boot.
 * @param ctx - Host context carrying the subprocess seam.
 * @param config - validated spawn facts for the Python backend.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = {
    command: [...config.command],
    cwd: config.cwd ?? process.cwd(),
    eofGraceMs: resolveEofGrace(config.eofGraceMs ?? DEFAULT_EOF_GRACE_MS),
    dbPath: config.dbPath ?? undefined,
  }
  let bridge: PythonBridge | undefined
  const client = (): PythonBridge => {
    if (bridge === undefined) {
      bridge = new PythonBridge({
        argv: resolved.dbPath === undefined
          ? [...resolved.command]
          : [...resolved.command, '--db', resolved.dbPath],
        cwd: resolved.cwd,
        eofGraceMs: resolved.eofGraceMs,
        spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => ctx.subprocess.spawn(spec),
      })
    }
    return bridge
  }
  ctx.effect(() => () => { void bridge?.dispose() }, 'prompt-templates: python bridge teardown')

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

/** Dispatch one API request against the Python child. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  client: () => PythonBridge,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const segments = url.pathname.split('/').filter(part => part !== '')
  // Expect ['plugins', 'dsh-prompt-templates', 'templates', ...rest].
  const rest = segments.slice(3)
  const method = req.method ?? 'GET'
  try {
    if (rest.length === 0 && method === 'GET') {
      const items = await client().call<readonly TemplateView[]>('templates/list', {})
      return json(res, 200, { items })
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readJson(req)
      const template = await client().call<TemplateView>('templates/create', body)
      return json(res, 200, { template })
    }
    const id = rest[0]
    if (id === undefined) return json(res, 400, errorBody('bad-request', 'missing template id'))
    if (rest.length === 1 && method === 'GET') {
      const template = await client().call<TemplateView | null>('templates/get', { id })
      if (template === null) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 1 && method === 'PATCH') {
      const body = await readJson(req)
      const template = await client().call<TemplateView | null>('templates/update', { id, ...body })
      if (template === null) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 2 && rest[1] === 'make-global' && method === 'POST') {
      const template = await client().call<TemplateView | null>('templates/make_global', { id })
      if (template === null) return json(res, 404, notFound(id))
      return json(res, 200, { template })
    }
    if (rest.length === 1 && method === 'DELETE') {
      const deleted = await client().call<boolean>('templates/delete', { id })
      return json(res, 200, { deleted })
    }
    return json(res, 405, errorBody('method-not-allowed', `${method} ${url.pathname}`))
  } catch (error) {
    if (error instanceof PythonBridgeError) {
      return json(res, 502, errorBody(`python:${String(error.code)}`, error.message))
    }
    const message = error instanceof Error ? error.message : String(error)
    return json(res, 500, errorBody('bridge-error', message))
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

/** Bounded by Node's timer delay ceiling (subprocess `graceMs` contract). */
function resolveEofGrace(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(
      `prompt-templates: eofGraceMs must be a positive finite ms, got ${String(value)}`,
    )
  }
  return value
}
