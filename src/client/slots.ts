/**
 * Injected faces of the prompt-templates entries. The panel slot
 * ('shell.overlay') is root-scoped, so its inject factory receives no
 * session id — the component reads the current session through the standard
 * kit. The composer entry ('conversation.input.right') is session-scoped and
 * carries the panel toggle.
 */

import type { TemplateActionResult } from './api.ts'
import type { TemplateView } from '../types.ts'

/** One template row the panel renders (the backend record). */
export type { TemplateView }

export type { TemplateActionResult }

/** Persisted panel placement in viewport pixels. */
export interface PanelPosition {
  readonly x: number
  readonly y: number
}

/** The panel's injected business face: CRUD verbs + refresh + insert + placement. */
export interface PromptPanelFace {
  /** Load the full template set (global + every session's); the component groups rows. */
  refresh: () => Promise<TemplateView[]>
  /** Create one template. */
  create: (request: {
    name: string
    content: string
    scope: 'global' | 'session'
    session_id: string | null
  }) => Promise<TemplateActionResult>
  /** Patch one template by id (name/content/description). */
  update: (id: string, request: {
    name?: string
    content?: string
    description?: string | null
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
  /** Append the content to the session's composer draft. */
  insert: (sessionId: string, content: string) => void
  /** Fill the draft and submit it immediately (same as pressing send). */
  send: (sessionId: string, content: string) => void
}

/** The composer entry's injected face: toggle the panel. */
export interface PromptPanelToggleFace {
  /** Flip the panel open/closed. */
  toggle: () => void
}
