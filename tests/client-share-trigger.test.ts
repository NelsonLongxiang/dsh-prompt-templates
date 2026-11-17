/** Drive the actual share handlers without DOM dependencies. Native mouse focus is checked separately in the browser fixture. */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { TemplateLibraryFace } from '../src/client/slots.ts'
import type { TemplateView } from '../src/types.ts'

register('./dsh-contract-loader.mjs', import.meta.url)
const { TemplateLibrary } = await import('../src/client/Library.tsx')

const baseTemplate: TemplateView = {
  id: 'one', name: 'synthetic', content: 'safe', scope: 'global', session_id: null,
  description: null, position: 0, category: null, inject_enabled: false, inject_every: null,
  mode: 'inject', created_at: '2026-01-01', updated_at: '2026-01-01',
}

type Tree = ReactElement<{ children?: ReactNode; onClick?: (event: unknown) => void; 'aria-label'?: string }>
function elements(node: unknown): Tree[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement(node)) return []
  const element = node as Tree
  return [element, ...elements(element.props.children)]
}

for (const kind of ['template', 'category'] as const) {
  test(kind + ' share remembers the clicked trigger even when another input retains focus', async () => {
    const template: TemplateView = { ...baseTemplate, category: kind === 'category' ? 'synthetic category' : null }
    const oldGlobals = new Map(['document', 'navigator', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    let triggerFocus = 0
    let oldInputFocus = 0
    class Target {
      isConnected = true
      focus() { oldInputFocus += 1 }
    }
    const previous = new Target()
    const trigger = new Target()
    trigger.focus = () => { triggerFocus += 1 }
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Target })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: previous, body: null, hasFocus: () => true } })
    const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } } }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    const dispatcher = internals.ReactCurrentDispatcher
    const before = dispatcher.current
    const slots: unknown[] = []
    let index = 0
    dispatcher.current = {
      useState(initial: unknown) {
        const key = index++
        if (!(key in slots)) slots[key] = key === 0 ? [template] : typeof initial === 'function' ? initial() : initial
        return [slots[key], (value: unknown) => { slots[key] = typeof value === 'function' ? value(slots[key]) : value }]
      },
      useRef(initial: unknown) { const key = index++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key] },
      useCallback(callback: unknown) { return callback },
      useEffect() {},
    }
    const noop = async () => ({ ok: true as const, value: undefined })
    const face: TemplateLibraryFace = {
      refresh: async () => [template], refreshCategories: async () => [{ name: 'synthetic category', scope: 'global', session_id: null }],
      createCategory: noop, removeCategory: noop, create: noop, update: noop, remove: noop, makeGlobal: noop,
      insert() {}, send() {}, interject() {}, injectStatus: async () => null, injectionHistory: async () => [],
      eventPolicies: async () => ({ items: [], enabled: false }), updateEventPolicy: noop, eventEpisodes: async () => [],
    }
    const render = () => { index = 0; return TemplateLibrary({ sessionId: 'synthetic', face, t: key => key }) }
    try {
      let tree = render()
      if (kind === 'category') {
        // The second state is the category list; effects are deliberately not run.
        slots[1] = [{ name: 'synthetic category', scope: 'global', session_id: null }]
        tree = render()
      }
      let button: Tree | undefined
      if (kind === 'template') {
        const row = elements(tree).find(element => typeof element.type === 'function' && element.type.name === 'TemplateRow')
        assert.ok(row)
        const rowTree = (row.type as (props: unknown) => ReactNode)(row.props)
        button = elements(rowTree).find(element => element.props['aria-label'] === 'panel.share')
      } else {
        button = elements(tree).find(element => element.props['aria-label'] === 'panel.shareCategory')
      }
      assert.ok(button?.props.onClick)
      button.props.onClick({ currentTarget: trigger })
      // Current implementation's copy API resolves asynchronously before manual state is shown.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      const close = elements(render()).find(element => element.type === 'button' && element.props.children === 'panel.shareDismiss')
      assert.ok(close?.props.onClick)
      close.props.onClick({ currentTarget: new Target() })
      assert.equal(triggerFocus, 1, 'dismissal must focus the clicked share trigger')
      assert.equal(oldInputFocus, 0, 'the previous input is not the share trigger')
    } finally {
      dispatcher.current = before
      for (const [key, descriptor] of oldGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
}
