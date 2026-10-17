/**
 * Composer entry button: toggles the quick prompt panel. Registered into
 * conversation.input.right (the tool row, before the send button). The
 * session-scoped inject face carries the toggle verb, which routes through
 * ctx.promptPanel to the panel's store. The standard kit delivers this
 * composer's sessionId as a prop; the button attaches the panel to that
 * session whenever its composer becomes the visible one — on mount, on
 * session change, and at click — so inserts and sends land in the
 * conversation the user is looking at, even right after a switch.
 */
import { useEffect } from 'react'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptPanelToggleFace } from './slots.ts'
import css from './PanelButton.module.css'

/** Full props of the composer entry. */
export type PanelButtonProps =
  PropsRuntime<'conversation.input.right'>
  & PromptPanelToggleFace
  & PropsLocale<'promptTemplates'>
  & {
    /**
     * Session identity of this composer (session-scope standard prop,
     * declared locally because the ui-session type augmentation is not in
     * this package's compile-time graph; the runtime always provides it).
     */
    sessionId?: string | undefined
  }

/**
 * The composer tool-row button.
 * @param props - runtime kit (the composer's sessionId), the toggle + attach verbs, and the locale seat.
 */
export function PanelButton({ toggle, attachSession, sessionId, t }: PanelButtonProps) {
  // Keep the panel's delivery target glued to this composer: the effect
  // fires when this composer becomes the visible one (mount or session
  // swap), not only at click time — otherwise switching sessions leaves
  // the panel pointing at the previous conversation whose input scope may
  // be gone, and send/insert would silently drop.
  useEffect(() => {
    if (sessionId !== undefined) attachSession(sessionId)
  }, [sessionId, attachSession])
  return (
    <button
      type="button"
      className={css.button}
      onClick={() => {
        if (sessionId !== undefined) attachSession(sessionId)
        toggle()
      }}
      aria-label={t('panel.open')}
      aria-pressed="false"
      title={t('panel.title')}
    >
      <span className={css.glyph}>▤</span>
    </button>
  )
}
