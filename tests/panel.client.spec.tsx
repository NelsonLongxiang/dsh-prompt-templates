// @vitest-environment jsdom
// PromptPanel behavior: lists global and session templates, inserts on click,
// deletes, and adds through the inline form — driven purely through props.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PromptPanel } from '../src/client/Panel.tsx'
import { createPromptPanelStore } from '../src/client/store.ts'
import type { PromptPanelFace } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'
import type { PromptTemplateView } from '@deepseek-ai/dsh-prompt-templates/types'

const t: TranslateNS<'promptTemplates'> = makeTranslate(zh, commonZh)

afterEach(cleanup)

function makeTemplate(over: Partial<PromptTemplateView> = {}): PromptTemplateView {
  return {
    id: 't1',
    name: 'review',
    content: 'Review this diff',
    scope: 'global',
    session_id: null,
    description: null,
    position: 0,
    created_at: '2026-08-14T09:44:53',
    updated_at: '2026-08-14T09:44:53',
    ...over,
  }
}

function makeFace(over: Partial<PromptPanelFace> = {}): PromptPanelFace {
  return {
    refresh: vi.fn(async () => []),
    create: vi.fn(async () => ({ ok: true as const, value: undefined })),
    update: vi.fn(async () => ({ ok: true as const, value: undefined })),
    remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
    makeGlobal: vi.fn(async () => ({ ok: true as const, value: undefined })),
    insert: vi.fn(),
    panelPosition: () => null,
    savePanelPosition: () => {},
    resetPanelPosition: () => {},
    send: vi.fn(),
    ...over,
  }
}

/** The framework hooks the panel reads, extracted from the component's own props type. */
type PanelProps = Parameters<typeof PromptPanel>[0]

type PlacementOverrides = {
  panelPosition?: () => { x: number; y: number } | null
  savePanelPosition?: (p: { x: number; y: number }) => void
  resetPanelPosition?: () => void
  send?: (sessionId: string, content: string) => void
}

function makeProps(
  state: { open: boolean },
  current: string | undefined,
  actions: unknown,
  face: PromptPanelFace,
  placement: PlacementOverrides = {},
): PanelProps {
  const hooks = {
    useStore: (sel: (s: never) => unknown) => (sel as (s: { open: boolean }) => unknown)(state),
    useSessions: (sel: (s: never) => unknown) => (sel as (s: { current: string | undefined }) => unknown)({ current }),
    useWorkspaces: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
  }
  return {
    actions,
    refresh: face.refresh,
    create: face.create,
    update: face.update,
    remove: face.remove,
    makeGlobal: face.makeGlobal,
    insert: face.insert,
    send: placement.send ?? (() => {}),
    panelPosition: placement.panelPosition ?? (() => null),
    savePanelPosition: placement.savePanelPosition ?? (() => {}),
    resetPanelPosition: placement.resetPanelPosition ?? (() => {}),
    ...hooks,
    t,
  } as unknown as PanelProps
}

async function renderOpen(face: PromptPanelFace, current = 'sess-1', placement: PlacementOverrides = {}) {
  const handle = createPromptPanelStore()
  const { store, actions } = handle.create()
  actions.open()
  const view = render(<PromptPanel {...makeProps(store.getSnapshot(), current, actions, face, placement)} />)
  // The open-triggered load is async: settle the refresh before assertions.
  await act(async () => { await Promise.resolve() })
  return { store, actions, ...view }
}

describe('PromptPanel', () => {
  it('renders nothing while closed', () => {
    const handle = createPromptPanelStore()
    const { store, actions } = handle.create()
    const face = makeFace()
    const { container } = render(<PromptPanel {...makeProps(store.getSnapshot(), undefined, actions, face)} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists global and session templates in separate groups', async () => {
    const face = makeFace({
      refresh: vi.fn(async () => [
        makeTemplate({ id: 'g1', name: 'global', scope: 'global', session_id: null }),
        makeTemplate({ id: 's1', name: 'session', scope: 'session', session_id: 'sess-1' }),
      ]),
    })
    await renderOpen(face)
    expect(screen.getByText('global')).toBeTruthy()
    expect(screen.getByText('session')).toBeTruthy()
    expect(screen.getByText('全局模板')).toBeTruthy()
    expect(screen.getByText('会话模板')).toBeTruthy()
  })

  it('inserts a template into the current session on click', async () => {
    const insert = vi.fn()
    const face = makeFace({
      refresh: vi.fn(async () => [makeTemplate()]),
      insert,
    })
    await renderOpen(face)
    fireEvent.click(screen.getByText('review'))
    expect(insert).toHaveBeenCalledWith('sess-1', 'Review this diff')
  })

  it('a session row promotes to global through the make-global action; a global row offers none', async () => {
    const makeGlobal = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const refresh = vi.fn(async () => [
      makeTemplate({ id: 'g1', name: 'global', scope: 'global', session_id: null }),
      makeTemplate({ id: 's1', name: 'session', scope: 'session', session_id: 'sess-1' }),
    ])
    const face = makeFace({ refresh, makeGlobal })
    await renderOpen(face)
    // Only the session-scoped row renders the make-global button.
    fireEvent.click(screen.getByRole('button', { name: '设为全局' }))
    await act(async () => { await Promise.resolve() })
    expect(makeGlobal).toHaveBeenCalledWith('s1')
    // The promoted row reloads into the global group.
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('deletes a template and reloads', async () => {
    const refresh = vi.fn(async () => [makeTemplate()])
    const remove = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const face = makeFace({ refresh, remove })
    await renderOpen(face)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await act(async () => { await Promise.resolve() })
    expect(remove).toHaveBeenCalledWith('t1')
  })

  it('creates a template through the add form', async () => {
    const create = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const face = makeFace({
      refresh: vi.fn(async () => []),
      create,
    })
    await renderOpen(face)
    fireEvent.click(screen.getByText('新增'))
    fireEvent.change(screen.getByPlaceholderText('模板名称'), { target: { value: 'new' } })
    fireEvent.change(screen.getByPlaceholderText('模板内容'), { target: { value: 'body' } })
    fireEvent.click(screen.getByText('保存'))
    await act(async () => { await Promise.resolve() })
    expect(create).toHaveBeenCalledWith({
      name: 'new',
      content: 'body',
      scope: 'global',
      session_id: null,
    })
  })

  it('dragging the header commits the clamped placement on release', async () => {
    const savePanelPosition = vi.fn()
    const face = makeFace({ refresh: vi.fn(async () => []) })
    const { container } = await renderOpen(face, 'sess-1', { savePanelPosition })
    const panel = container.querySelector('[data-prompt-panel]') as HTMLElement
    const header = panel.firstElementChild as HTMLElement

    // jsdom rects are zero: dragging to (320, 120) with a (0,0) start offset
    // clamps x into [0, viewport-width] and y into [0, viewport-height-40].
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 320, clientY: 120 })
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 320, clientY: 120 })
    await act(async () => { await Promise.resolve() })

    expect(savePanelPosition).toHaveBeenCalledTimes(1)
    const saved = savePanelPosition.mock.calls[0]?.[0] as { x: number; y: number }
    expect(saved.x).toBeGreaterThanOrEqual(0)
    expect(saved.y).toBeGreaterThanOrEqual(0)
  })

  it('a persisted placement positions the panel and double-click resets it', async () => {
    const resetPanelPosition = vi.fn()
    const face = makeFace({ refresh: vi.fn(async () => []) })
    const { container } = await renderOpen(face, 'sess-1', {
      panelPosition: () => ({ x: 40, y: 60 }),
      resetPanelPosition,
    })
    const panel = container.querySelector('[data-prompt-panel]') as HTMLElement
    expect(panel.style.left).toBe('40px')
    expect(panel.style.top).toBe('60px')
    const header = panel.firstElementChild as HTMLElement
    fireEvent.dblClick(header)
    expect(resetPanelPosition).toHaveBeenCalledTimes(1)
  })

  it('the row send button sends immediately; clicking the body appends to the draft', async () => {
    const send = vi.fn()
    const insert = vi.fn()
    const face = makeFace({
      refresh: vi.fn(async () => [makeTemplate()]),
      insert,
    })
    await renderOpen(face, 'sess-1', { send })
    // Clicking the template body routes to insert (append semantics).
    fireEvent.click(screen.getByText('review'))
    expect(insert).toHaveBeenCalledWith('sess-1', 'Review this diff')
    expect(send).not.toHaveBeenCalled()
    // The dedicated send button routes to send (immediate submission).
    fireEvent.click(screen.getByRole('button', { name: '直接发送' }))
    expect(send).toHaveBeenCalledWith('sess-1', 'Review this diff')
  })

  it('editing a row opens the prefilled form and saves through update', async () => {
    const update = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const face = makeFace({
      refresh: vi.fn(async () => [makeTemplate()]),
      update,
    })
    await renderOpen(face)
    // Open the in-place editor for the row.
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    // The form renders prefilled with the stored name and content.
    const nameInput = screen.getByLabelText('模板名称') as HTMLInputElement
    const contentInput = screen.getByLabelText('模板内容') as HTMLTextAreaElement
    expect(nameInput.value).toBe('review')
    expect(contentInput.value).toBe('Review this diff')
    fireEvent.change(nameInput, { target: { value: 'review-v2' } })
    fireEvent.change(contentInput, { target: { value: 'Updated body' } })
    fireEvent.click(screen.getByText('保存'))
    await act(async () => { await Promise.resolve() })
    expect(update).toHaveBeenCalledWith('t1', { name: 'review-v2', content: 'Updated body' })
  })
})
