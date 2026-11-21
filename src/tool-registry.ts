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
