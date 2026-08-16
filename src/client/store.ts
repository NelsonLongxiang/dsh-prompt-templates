/**
 * Panel store owned by the shell.overlay entry: the open flag plus the
 * ever-opened marker. The composer button reaches the same state through
 * ctx.promptPanel (the controller holds the entry's bound actions); inserts
 * go through the controller's session-input path, never this store. The
 * ever-opened marker lets the settings-driven default-open apply exactly
 * once: any manual toggle or open marks the panel user-owned, so a late
 * settings load can never reopen what the user closed.
 *
 * Module level exports the factory only (de-facto singleton prohibition —
 * see ui-layout's store).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Panel state: open flag plus the one-shot default-open marker. */
type PromptPanelState = { open: boolean; everOpened: boolean }

/**
 * Complete write set for the panel.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createPromptPanelStore(): EngineStoreHandle<PromptPanelState, PromptPanelActions> {
  const handle = defineStore({
    init: (): PromptPanelState => ({ open: false, everOpened: false }),
    actions: {
      toggle: (d) => {
        d.everOpened = true
        d.open = !d.open
      },
      open: (d) => {
        d.everOpened = true
        d.open = true
      },
      close: (d) => {
        d.everOpened = true
        d.open = false
      },
      // One-shot settings-driven default open: a no-op once the user has
      // ever touched the panel (either direction).
      openOnce: (d) => {
        if (d.everOpened) return
        d.everOpened = true
        d.open = true
      },
    },
  })
  return handle
}

/** Action type of the panel store (the exported annotation twin). */
export type PromptPanelActions = {
  toggle: (draft: PromptPanelState) => void
  open: (draft: PromptPanelState) => void
  close: (draft: PromptPanelState) => void
  openOnce: (draft: PromptPanelState) => void
}
