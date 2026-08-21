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
}

/** Update payload; every field optional. */
export interface TemplateUpdateRequest {
  readonly name?: string
  readonly content?: string
  readonly description?: string | null
  readonly position?: number
  readonly category?: string | null
}

/** Category create payload. */
export interface CategoryCreateRequest {
  readonly name: string
  readonly scope?: PromptScope
  readonly session_id?: string | null
}
