/**
 * Injected faces of the prompt-templates entries. The panel slot
 * ('shell.overlay') is root-scoped, so its inject factory receives no
 * session id — the delivery target arrives from the composer entry: the
 * session-scoped 'conversation.input.right' button reports its sessionId
 * whenever its composer becomes the visible one (mount, session change,
 * and click), and the panel reads it back through the face. The composer
 * entry carries the panel toggle plus that target attachment.
 */

import type { TemplateActionResult } from './api.ts'
import type { CategoryView, InjectionStatusView, TemplateView } from '../types.ts'

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
    inject_enabled?: boolean
    inject_every?: number | null
  }) => Promise<TemplateActionResult>
  /** Patch one template by id (name/content/description/position/category/inject facts). */
  update: (id: string, request: {
    name?: string
    content?: string
    description?: string | null
    position?: number
    category?: string | null
    inject_enabled?: boolean
    inject_every?: number | null
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
  /**
   * The session whose composer entry opened the panel — the delivery target
   * for insert/send/interject and the scope of session-scoped templates.
   * Null before any composer has attached (session tabs stay disabled).
   */
  targetSession: () => string | null
  /**
   * Monotonic counter that bumps on every target change — the snapshot for
   * useSyncExternalStore. The open panel subscribes so a session switch
   * re-renders it with the fresh target (otherwise its handlers keep the
   * previous render's sessionId closure and send lands nowhere).
   */
  targetVersion: () => number
  /** Delivery-target change subscription; returns the unsubscribe function. */
  subscribeTarget: (notify: () => void) => () => void
  /**
   * Poll the attached session's latest scheduled injection (null when none
   * since boot). Feeds the toolbar badge `⟳N`; deliberately a face verb so
   * both surfaces (overlay + tab) share one implementation.
   */
  injectStatus: (sessionId: string) => Promise<InjectionStatusView | null>
}

/** The composer entry's injected face: toggle the panel. */
export interface PromptPanelToggleFace {
  /** Flip the panel open/closed. */
  toggle: () => void
  /**
   * Attach the panel to one composer's session. The session-scoped button
   * calls this with its standard-kit sessionId prop whenever its composer
   * becomes the visible one — on mount, on session change, and again at
   * click time — so the delivery target follows the conversation the user
   * is looking at instead of freezing on the session that happened to
   * click first.
   */
  attachSession: (sessionId: string) => void
}

/**
 * The library verbs shared by both surfaces — the floating panel and the
 * right-sidebar tab body: the panel face minus the overlay-only placement
 * knobs and the overlay's target attachment. Each surface resolves its own
 * delivery target (the overlay reads the composer attachment, the tab reads
 * its standard session-scoped props) and hands the library this face.
 */
export type TemplateLibraryFace = Pick<
  PromptPanelFace,
  | 'refresh' | 'refreshCategories' | 'createCategory' | 'removeCategory'
  | 'create' | 'update' | 'remove' | 'makeGlobal'
  | 'insert' | 'send' | 'interject' | 'injectStatus'
>
