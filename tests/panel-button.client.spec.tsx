// @vitest-environment jsdom
// PanelButton behavior: toggles the panel via the injected verb.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PanelButton } from '../src/client/PanelButton.tsx'
import { zh } from '../src/client/locales.ts'

const t: TranslateNS<'promptTemplates'> = makeTranslate(zh, commonZh)

afterEach(cleanup)

describe('PanelButton', () => {
  it('renders a toggle button and calls the toggle verb on click', () => {
    const toggle = vi.fn()
    const hooks = {
      useSession: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
      useProjection: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
      useInput: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
      useSessions: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
      useWorkspaces: (sel: (s: never) => unknown) => (sel as (s: Record<string, never>) => unknown)({}),
    }
    const props = {
      toggle,
      session: {},
      input: {},
      sessionId: 'sess-1',
      inputActions: {},
      ...hooks,
      t,
    } as unknown as Parameters<typeof PanelButton>[0]
    render(<PanelButton {...props} />)
    const button = screen.getByRole('button', { name: '打开提示词面板' })
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
