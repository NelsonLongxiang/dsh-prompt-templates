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
import type { ClientContext, SessionId, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { createPromptPanelStore } from './store.ts'

/**
 * Locate the composer textarea for one draft. The input machine publishes
 * no caret, so the caret can only be read from the DOM: of every textarea
 * on the page, the one whose value equals the draft snapshot is the
 * composer (the panel's own form fields never hold the draft). Falls back
 * to null when no match exists (detached DOM, session switched mid-click).
 */
function composerTextarea(draft: string): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  for (const el of Array.from(document.querySelectorAll('textarea'))) {
    if (el.value === draft) return el
  }
  return null
}

/** The panel store's bound action set (framework-baked, draft params peeled). */
export type PromptPanelActions = BoundActions<ReturnType<typeof createPromptPanelStore>>

/** The outward prompt-panel face (`ctx.promptPanel`). */
export interface IPromptPanel {
  /** Flip the panel open/closed. */
  toggle(): void
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
   * The caret lives only in the DOM textarea — the input machine publishes
   * no caret — so the composer textarea is located by matching its value
   * against the draft snapshot; when no textarea is found the content falls
   * back to an end-append (empty draft takes it verbatim, non-empty joins
   * with a newline).
   * @param sessionId - target session.
   * @param content - template content.
   */
  insert(sessionId: SessionId, content: string): void {
    const input = this.#inputOf(sessionId)
    if (input === undefined) return
    const draft = input.state.getSnapshot().draft
    const textarea = composerTextarea(draft)
    if (textarea === null) {
      input.setDraft(draft === '' ? content : `${draft}\n${content}`)
      return
    }
    const start = textarea.selectionStart ?? draft.length
    const end = textarea.selectionEnd ?? start
    const next = `${draft.slice(0, start)}${content}${draft.slice(end)}`
    const caret = start + content.length
    input.setDraft(next)
    // Return focus and land the caret after the inserted text; the panel
    // rows preventDefault on mousedown, so the textarea never lost focus.
    textarea.focus()
    textarea.setSelectionRange(caret, caret)
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
