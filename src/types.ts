/**
 * Wire payload types shared by the host routes and the browser API. Field
 * names match the Python side's Pydantic models verbatim (snake_case): the
 * type is the protocol and no field mapping can drift.
 * @module dsh-prompt-templates/types
 */

/** Scope partition of one template: global or private to one session. */
export type PromptScope = 'global' | 'session'

/** Canonical template record as stored by the Python backend. */
export interface TemplateView {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly scope: PromptScope
  /** Owning session id; `null` for a global template. */
  readonly session_id: string | null
  readonly description: string | null
  readonly position: number
  /** ISO timestamp without timezone, as emitted by the backend. */
  readonly created_at: string
  readonly updated_at: string
}

/** Create payload; the backend validates scope/session consistency. */
export interface TemplateCreateRequest {
  readonly name: string
  readonly content: string
  readonly scope?: PromptScope
  readonly session_id?: string | null
  readonly description?: string | null
  readonly position?: number
}

/** Update payload; every field optional. */
export interface TemplateUpdateRequest {
  readonly name?: string
  readonly content?: string
  readonly description?: string | null
  readonly position?: number
}
