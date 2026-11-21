/**
 * Register model tools once the host's `tools` service is ready.
 *
 * The plugin does not declare `inject: ['tools']` (this cordis has no optional
 * inject, so declaring it would keep the whole plugin — template library
 * included — from loading on a host without tools). Reading `ctx.get('tools')`
 * at apply time instead returned `undefined` on a real host whenever the tools
 * service was not active yet, and the tools were silently never registered
 * (#43). `ctx.inject` runs the callback when the service becomes available and
 * disposes the registration with it.
 */
import type { Context } from '@deepseek-ai/cordis'

export interface ToolRegistry { register: (tool: unknown) => unknown }

/**
 * Every tool must declare `output: { schema, render }` — the real ToolRuntime rejects a definition
 * without it (TypeError inside the inject fiber, swallowed by the host console; found on a real host,
 * 2026-11-21, probe tmp/probe-register.mjs). This wrapper adds a permissive object schema and a
 * JSON card renderer, matching how dsh-open-a2a-net declares its tools.
 */
export function withOutput(definition: { name: string, [key: string]: unknown }): { name: string, [key: string]: unknown } {
  return {
    ...definition,
    output: definition.output ?? {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  }
}

/**
 * The model-facing parameter schema. A raw `tools.register()` hands `parameters` to the model verbatim — only
 * `defineTool()` compiles the per-property `{ name: { type, required } }` shorthand — so a registered tool must
 * carry a real JSON Schema object root. The shorthand left the model with no `text` property: on a real host
 * `lesson_write` arrived as `{}` three times and as `{ lesson }` once (#50).
 */
export function objectParameters(properties: Record<string, Record<string, unknown>>, required: readonly string[]): {
  type: 'object', properties: Record<string, Record<string, unknown>>, required: string[], additionalProperties: false
} {
  for (const name of required) if (!(name in properties)) throw new Error(`required parameter ${name} is not declared`)
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

export function registerWhenToolsReady(ctx: Context, label: string, register: (tools: ToolRegistry) => void): void {
  const provided = (ctx.get as (name: string, strict?: boolean) => unknown)('tools', false)
  if (provided === undefined) console.info(`[dsh-prompt-templates] ${label}: tools service not provided yet; tools register when it is`)
  ctx.inject(['tools'], (sub: Context) => {
    const tools = (sub as unknown as { tools?: Partial<ToolRegistry> }).tools
    if (typeof tools?.register !== 'function') {
      console.error(`[dsh-prompt-templates] ${label}: tools service has no register(); tools not registered`)
      return
    }
    register(tools as ToolRegistry)
  })
}
