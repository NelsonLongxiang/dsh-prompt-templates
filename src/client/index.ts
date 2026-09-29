/**
 * Quick prompt templates plugin, browser half: the shell.overlay panel and
 * the composer entry that toggles it and inserts template content into the
 * draft. Data flows through the host's `/plugins/dsh-prompt-templates`
 * HTTP routes; panel transitions and inserts route through ctx.promptPanel
 * (the controller holds the panel entry's bound store actions). The panel
 * face is created ONCE per apply — a per-render face object would mint
 * fresh `refresh` identities on every inject evaluation, invalidating the
 * panel's load callback and re-running its effect in a loop. The
 * settings-driven default-open rides the promptTemplates settings
 * namespace (absent when the host exposes no settings document — the panel
 * then just starts closed).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-layout SlotMap merge (shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-conversation SlotMap merge (conversation.input.right) and the input resolver.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the UI renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TemplateView } from '../types.ts'
import {
  listTemplates,
  listCategories,
  createCategory,
  deleteCategory,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  makeTemplateGlobal,
} from './api.ts'
import { PromptPanel } from './Panel.tsx'
import { PanelButton } from './PanelButton.tsx'
import { createPromptPanelPrefsStore, createPromptPanelStore } from './store.ts'

import { PromptPanelController, type IPromptPanel } from './service.ts'
import type { PromptPanelActions } from './service.ts'
import type { PromptPanelFace, PromptPanelToggleFace, PanelPosition } from './slots.ts'
import { en, zh, type PromptTemplateKey } from './locales.ts'

export { PromptPanel } from './Panel.tsx'
export { PanelButton } from './PanelButton.tsx'
export { PromptPanelController } from './service.ts'
export type { PromptPanelProps } from './Panel.tsx'
export type { PanelButtonProps } from './PanelButton.tsx'
export type { PromptPanelFace, PromptPanelToggleFace } from './slots.ts'
export type { IPromptPanel } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-entry panel face: toggle + insert + settings-driven default open. */
    promptPanel: IPromptPanel
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The quick-prompt panel and composer entry copy. */
    promptTemplates: PromptTemplateKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'promptTemplates'

/** Required services: slots, sessions, locale, conversation, and settings scope. */
export const inject = ['slots', 'sessions', 'locale', 'conversation']

/** The promptTemplates settings section (registered host-side; optional). */
/**
 * Client plugin body: the shell.overlay panel owns the store; the controller
 * bridges its actions to the composer entry and performs inserts.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-prompt-templates: dictionaries')

  const controller = new PromptPanelController()
  controller.bind({ sessions: ctx.sessions, conversation: ctx.conversation })
  ctx.effect(() => ctx.reflect.provide('promptPanel', controller), 'ui-prompt-templates: panel service')


  // The panel's business face, created exactly once: the `refresh` identity
  // feeds the panel's load-effect dependency array, so a fresh object per
  // inject evaluation would loop the effect. refresh pulls EVERYTHING and
  // the component groups rows — a server-side session_id filter would hide
  // the global rows (their session_id is NULL and never matches).
  // Persisted prefs binding, filled by the overlay seat's inject (the seat
  // owns the store instance; the face reads through these closures).
  let prefsActions: { setPosition: (x: number, y: number) => void; resetPosition: () => void } | undefined
  let prefsSnapshot: (() => { panel: { x: number; y: number } | null }) | undefined

  const panelFace: PromptPanelFace = {
    refresh: listTemplates,
    refreshCategories: listCategories,
    createCategory: (request) => {
      return createCategory(request)
    },
    removeCategory: (name, scope, sessionId) => {
      return deleteCategory(name, scope, sessionId)
    },
    create: (request) => {
      return createTemplate(request)
    },
    update: (id: string, request: { name?: string; content?: string; description?: string | null }) => {
      return updateTemplate(id, request)
    },
    remove: (id: string) => {
      return deleteTemplate(id)
    },
    makeGlobal: (id: string) => {
      return makeTemplateGlobal(id)
    },
    insert: (sessionId: string, content: string) => {
      controller.insert(sessionId as SessionId, content)
    },
    send: (sessionId: string, content: string) => {
      controller.send(sessionId as SessionId, content)
    },
    interject: (sessionId: string, content: string) => {
      controller.interject(sessionId as SessionId, content)
    },
    panelPosition: (): PanelPosition | null => prefsSnapshot?.().panel ?? null,
    savePanelPosition: (position: PanelPosition) => {
      prefsActions?.setPosition(position.x, position.y)
    },
    resetPanelPosition: () => {
      prefsActions?.resetPosition()
    },
  }


  // The shell.overlay entry: root scope, owns the panel store; the inject
  // hook hands the bound actions to the controller and the shared face.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'prompt-templates',
    order: 10,
    locale: NS,
    store: createPromptPanelStore,
    inject: (actions: PromptPanelActions, store?): PromptPanelFace => {
      // attach is a side effect on the controller; the face is the data verbs.
      controller.attach(actions)
      if (store !== undefined) {
        const s = store as unknown as { actions: { setPosition: (x: number, y: number) => void; resetPosition: () => void }; getSnapshot: () => { panel: { x: number; y: number } | null } }
        prefsActions = s.actions
        prefsSnapshot = () => s.getSnapshot()
      }
      return panelFace
    },
  }, PromptPanel))

  // The composer entry: session scope, toggles the panel via the controller.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'prompt-templates',
    order: 10,
    locale: NS,
    inject: (): PromptPanelToggleFace => ({
      toggle: () => { controller.toggle() },
    }),
  }, PanelButton))
}
