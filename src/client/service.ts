/**
 * PromptPanelController: the cross-entry panel face behind ctx.promptPanel.
 * The open state lives in the shell.overlay entry's panel store; this
 * service exposes the transitions other entries trigger (the composer
 * button's toggle) and the insert handoff (the panel requests an insert,
 * this controller writes the session draft through the conversation input
 * resolver). Writes stay inside the store's declared action set, delivered
 * as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { createPromptPanelStore } from './store.ts'

/**
 * The live insertion span the input face hands out: a [start, end) range in
 * the draft's text coordinates plus the draft revision it was captured
 * against. A stale revision (or a locked admission transaction) makes
 * `insertText` decline instead of applying at the wrong place.
 */
export interface InsertionSpan {
  start: number
  end: number
  draftRev: number
}

/** The panel store's bound action set (framework-baked, draft params peeled). */
export type PromptPanelActions = BoundActions<ReturnType<typeof createPromptPanelStore>>

/** The outward prompt-panel face (`ctx.promptPanel`). */
export interface IPromptPanel {
  /** Flip the panel open/closed. */
  toggle(): void
  /**
   * Record the session whose composer entry was clicked — the panel's
   * delivery target for insert/send/interject and session-scoped templates.
   * The session-scoped composer entry calls this at click time, replacing
   * the pre-0.2.0 `SessionListState.current` lookup (the 0.2.0 session list
   * has no selection field; `ids[0]` is merely the newest list row).
   */
  setTargetSession(sessionId: SessionId): void
  /** The delivery target: the composer that last opened the panel. */
  targetSession(): SessionId | undefined
  /** Monotonic counter bumping on every target change (useSyncExternalStore snapshot). */
  targetVersion(): number
  /** Delivery-target change subscription (drives the open panel's re-render). */
  subscribeTarget(notify: () => void): () => void
  /** Insert one template's content into a session's composer draft at the caret. */
  insert(sessionId: SessionId, content: string): void
  /** Submit one template's content immediately, preserving the user's draft. */
  interject(sessionId: SessionId, content: string): void
  /** Fill the draft with one template's content and submit it immediately. */
  send(sessionId: SessionId, content: string): void
  /**
   * Apply the settings-driven default open, at most once per store lifetime
   * and never after any user interaction with the panel.
   */
  openOnce(): void
}

/**
 * Cross-entry panel face (ctx.promptPanel).
 */
export class PromptPanelController implements IPromptPanel {
  #actions: PromptPanelActions | undefined
  #sessions: ISessions | undefined
  #conversation: ClientContext['conversation'] | undefined
  #pendingAutoOpen = false
  /** Session whose composer entry last opened the panel (delivery target). */
  #targetSession: SessionId | undefined
  /** Bumped every time the delivery target changes; drives the open panel's re-render. */
  #targetVersion = 0
  #targetListeners = new Set<() => void>()

  /**
   * Adopt the shell.overlay entry's bound store actions. Called from that
   * registration's inject hook; a re-register overwrites the stale set. A
   * default-open that arrived before the entry's first render is applied
   * here, once wiring exists.
   * @param actions - bound actions of the panel store instance.
   */
  attach(actions: PromptPanelActions): void {
    this.#actions = actions
    if (this.#pendingAutoOpen) {
      this.#pendingAutoOpen = false
      actions.openOnce()
    }
  }

  /**
   * Bind the session-scope resolution services needed for inserts.
   * @param deps - sessions and conversation services from the plugin closure.
   */
  bind(deps: {
    sessions: ISessions
    conversation: ClientContext['conversation']
  }): void {
    this.#sessions = deps.sessions
    this.#conversation = deps.conversation
  }

  /** Flip the panel open/closed. */
  toggle(): void {
    this.#require().toggle()
  }

  /**
   * Record the panel's delivery target. Called by the session-scoped
   * composer entry when its session becomes the visible one (mount or
   * session change) and again at click time, so the target always follows
   * the conversation the user is looking at — switching sessions must not
   * leave the panel pointed at a detached composer whose scope (and
   * send/insert path) has gone away.
   */
  setTargetSession(sessionId: SessionId): void {
    if (this.#targetSession === sessionId) return
    this.#targetSession = sessionId
    this.#targetVersion += 1
    for (const notify of this.#targetListeners) notify()
  }

  /** The session whose composer last opened the panel, if any. */
  targetSession(): SessionId | undefined {
    return this.#targetSession
  }

  /** Monotonic change counter of the delivery target (snapshot for useSyncExternalStore). */
  targetVersion(): number {
    return this.#targetVersion
  }

  /** Subscribe to delivery-target changes; returns the unsubscribe function. */
  subscribeTarget(notify: () => void): () => void {
    this.#targetListeners.add(notify)
    return () => { this.#targetListeners.delete(notify) }
  }

  /**
   * Apply the settings-driven default open, at most once per store lifetime
   * and never after any user interaction with the panel. Before the entry's
   * first render the request parks as pending and attach() replays it.
   */
  openOnce(): void {
    if (this.#actions === undefined) {
      this.#pendingAutoOpen = true
      return
    }
    this.#actions.openOnce()
  }

  /**
   * Insert one template's content into a session's composer draft at the
   * live caret position (selection, when a range is selected, is replaced).
   * The caret path goes through the input face's provide-channel pair —
   * capture the caret span with its draft revision, then apply through the
   * face so the editor lands it as one undoable edit. The pair declines on
   * a stale revision or a locked admission transaction (submitting /
   * adjudicating), and older runtimes without the channel simply lack the
   * member; both fall back to an end-append over the draft snapshot (empty
   * draft takes the content verbatim, non-empty joins with a newline).
   * @param sessionId - target session.
   * @param content - template content.
   */
  insert(sessionId: SessionId, content: string): void {
    const input = this.#inputOf(sessionId)
    if (input === undefined) return
    const actions = input.actions
    if (actions !== undefined) {
      try {
        const span = actions.captureInsertion()
        if (span !== undefined && actions.insertText(content, span)) return
      } catch {
        // The channel is best-effort; the append path below always works.
      }
    }
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft === '' ? content : `${draft}\n${content}`)
  }

  /**
   * Interject one template: steer it into the running agent turn. With
   * steer mode the content interrupts the current turn at its next step
   * (the same delivery as Cmd/Ctrl+Enter插话发送), rather than queuing
   * after it. The user's own draft is left untouched.
   * @param sessionId - target session.
   * @param content - template content.
   */
  interject(sessionId: SessionId, content: string): void {
    const input = this.#inputOf(sessionId)
    if (input === undefined) return
    input.setDraft(content)
    input.submit('steer')
  }

  /**
   * Fill the draft with one template's content and submit it immediately —
   * the same transaction as typing the text and pressing send.
   * @param sessionId - target session.
   * @param content - template content.
   */
  send(sessionId: SessionId, content: string): void {
    const input = this.#inputOf(sessionId)
    if (input === undefined) return
    input.setDraft(content)
    input.submit()
  }

  /** Resolve a session's input facade, or undefined when out of reach. */
  #inputOf(sessionId: SessionId): {
    setDraft(text: string): void
    submit(mode?: 'queue' | 'steer'): void
    state: { getSnapshot(): { draft: string, phase: string }, subscribe(fn: () => void): () => void }
    /**
     * The stable provide-channel action face (0.2.0 input shell): the
     * revision-guarded caret insertion pair. Optional so older runtimes
     * (textarea composers) keep working through the append fallback.
     */
    actions?: {
      captureInsertion(): InsertionSpan
      insertText(text: string, span: InsertionSpan): boolean
    }
  } | undefined {
    const sessions = this.#sessions
    const conversation = this.#conversation
    if (sessions === undefined || conversation === undefined) return undefined
    const actx = sessions.scope(sessionId)
    if (actx === undefined) return undefined
    return conversation.input.for(actx)
  }

  #require(): PromptPanelActions {
    if (this.#actions === undefined) {
      throw new Error('prompt-panel: panel actions not wired (shell.overlay entry not mounted)')
    }
    return this.#actions
  }
}
