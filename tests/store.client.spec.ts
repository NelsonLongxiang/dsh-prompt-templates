// PromptPanelStore unit account: init shape and the complete write set,
// including the one-shot settings-driven openOnce.

import { describe, expect, it } from 'vitest'
import { createPromptPanelStore } from '../src/client/store.ts'

describe('createPromptPanelStore', () => {
  it('starts closed and untouched', () => {
    const { store } = createPromptPanelStore().create()
    expect(store.getSnapshot()).toEqual({ open: false, everOpened: false })
  })

  it('toggle flips the open flag and marks the panel user-owned', () => {
    const { store, actions } = createPromptPanelStore().create()
    actions.toggle()
    expect(store.getSnapshot()).toEqual({ open: true, everOpened: true })
    actions.toggle()
    expect(store.getSnapshot()).toEqual({ open: false, everOpened: true })
  })

  it('open and close are idempotent directional writes', () => {
    const { store, actions } = createPromptPanelStore().create()
    actions.open()
    actions.open()
    expect(store.getSnapshot().open).toBe(true)
    actions.close()
    actions.close()
    expect(store.getSnapshot().open).toBe(false)
  })

  it('openOnce opens an untouched panel exactly once', () => {
    const { store, actions } = createPromptPanelStore().create()
    actions.openOnce()
    expect(store.getSnapshot()).toEqual({ open: true, everOpened: true })
    actions.close()
    // A second settings-driven open must not reopen a user-closed panel.
    actions.openOnce()
    expect(store.getSnapshot().open).toBe(false)
  })

  it('openOnce is a no-op after any manual interaction', () => {
    const { store, actions } = createPromptPanelStore().create()
    actions.toggle()
    actions.toggle()
    expect(store.getSnapshot()).toEqual({ open: false, everOpened: true })
    actions.openOnce()
    expect(store.getSnapshot().open).toBe(false)
  })
})
