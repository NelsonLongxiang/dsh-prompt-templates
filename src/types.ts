/**
 * Wire payload types shared by the host routes and the browser API. Field
 * names are snake_case end to end: the type is the protocol and no field
 * mapping can drift.
 * @module dsh-prompt-templates/types
 */

/** Scope partition of one template: global or private to one session. */
export type PromptScope = 'global' | 'session'

/** Canonical template record as stored by the backend. */
export interface TemplateView {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly scope: PromptScope
  /** Owning session id; `null` for a global template. */
  readonly session_id: string | null
  readonly description: string | null
  readonly position: number
  /** Category name; `null` = one of the default tabs (全局/会话模板). */
  readonly category: string | null
  /** Auto-inject switch: the host injects this template every N rounds. */
  readonly inject_enabled: boolean
  /** Injection interval in rounds; `null` when never configured. */
  readonly inject_every: number | null
  /** ISO timestamp without timezone, as emitted by the backend. */
  readonly created_at: string
  readonly updated_at: string
}

/** A user-created category tab. Default tabs (全局/会话模板) are implicit. */
export interface CategoryView {
  readonly name: string
  readonly scope: PromptScope
  /** Owning session id; `null` for a global category. */
  readonly session_id: string | null
}

/** Create payload; the backend validates scope/session consistency. */
export interface TemplateCreateRequest {
  readonly name: string
  readonly content: string
  readonly scope?: PromptScope
  readonly session_id?: string | null
  readonly description?: string | null
  readonly position?: number
  readonly category?: string | null
  readonly inject_enabled?: boolean
  readonly inject_every?: number | null
}

/** Update payload; every field optional. */
export interface TemplateUpdateRequest {
  readonly name?: string
  readonly content?: string
  readonly description?: string | null
  readonly position?: number
  readonly category?: string | null
  readonly inject_enabled?: boolean
  readonly inject_every?: number | null
}

/** Category create payload. */
export interface CategoryCreateRequest {
  readonly name: string
  readonly scope?: PromptScope
  readonly session_id?: string | null
}

/**
 * Client-facing summary of a session's latest scheduled injection, polled by
 * the panel/tab toolbar badge (`⟳N`). Lives here (not in inject.ts) because
 * the client bundles type-import it and must not pull the host-only module
 * graph (node:sqlite, dsh-agent) into the browser tsconfig project.
 */
export interface InjectionStatusView {
  /** The boundary turn the latest injection landed on (1-based, durable). */
  readonly turn: number
  /** Wall-clock epoch milliseconds of the injection. */
  readonly at: number
  /** Template names carried by that injection, in injection order. */
  readonly templates: readonly string[]
}
