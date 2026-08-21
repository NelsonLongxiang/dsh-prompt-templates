/**
 * Injected faces of the prompt-templates entries. The panel slot
 * ('shell.overlay') is root-scoped, so its inject factory receives no
 * session id — the component reads the current session through the standard
 * kit. The composer entry ('conversation.input.right') is session-scoped and
 * carries the panel toggle.
 */

import type { TemplateActionResult } from './api.ts'
import type { CategoryView, TemplateView } from '../types.ts'

/** One template row the panel renders (the backend record). */
export type { TemplateView }

export type { TemplateActionResult, CategoryView }

/** Persisted panel placement in viewport pixels. */
export interface PanelPosition {
  readonly x: number
  readonly y: number
}

/** The panel's injected business face: CRUD verbs + refresh + insert + placement. */
export interface PromptPanelFace {
  /** Load the full template set (global + every session's); the component groups rows. */
  refresh: () => Promise<TemplateView[]>
  /** Load every user category tab (global + all sessions'). */
  refreshCategories: () => Promise<CategoryView[]>
  /** Create one category tab (global, or owned by the given session). */
  createCategory: (request: {
    name: string
    scope: 'global' | 'session'
    session_id: string | null
  }) => Promise<TemplateActionResult>
  /** Delete one category tab; its templates fall back to the default tab. */
  removeCategory: (name: string, scope: 'global' | 'session', sessionId: string | null) => Promise<TemplateActionResult>
  /** Create one template. */
  create: (request: {
    name: string
    content: string
    scope: 'global' | 'session'
    session_id: string | null
    category?: string | null
  }) => Promise<TemplateActionResult>
  /** Patch one template by id (name/content/description/position/category). */
  update: (id: string, request: {
    name?: string
    content?: string
    description?: string | null
    position?: number
    category?: string | null
  }) => Promise<TemplateActionResult>
  /** Delete one template by id. */
  remove: (id: string) => Promise<TemplateActionResult>
  /** Promote one session template to the global partition. */
  makeGlobal: (id: string) => Promise<TemplateActionResult>
  /** The persisted panel placement; null = the right-anchored default. */
  panelPosition: () => PanelPosition | null
  /** Persist the dragged placement (write-through to the settings document). */
  savePanelPosition: (position: PanelPosition) => void
  /** Forget the placement and return to the right-anchored default. */
  resetPanelPosition: () => void
  /** Insert the content at the session composer's caret position. */
  insert: (sessionId: string, content: string) => void
  /** Fill the draft and submit it immediately (same as pressing send). */
  send: (sessionId: string, content: string) => void
  /** Submit the content immediately while preserving the user's draft (interject). */
  interject: (sessionId: string, content: string) => void
}

/** The composer entry's injected face: toggle the panel. */
export interface PromptPanelToggleFace {
  /** Flip the panel open/closed. */
  toggle: () => void
}
