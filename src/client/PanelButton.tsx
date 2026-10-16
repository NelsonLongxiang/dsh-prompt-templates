/**
 * Composer entry button: toggles the quick prompt panel. Registered into
 * conversation.input.right (the tool row, before the send button). The
 * session-scoped inject face carries the toggle verb, which routes through
 * ctx.promptPanel to the panel's store. The standard kit delivers this
 * composer's sessionId as a prop; the click attaches the panel to that
 * session first, so inserts and sends land in the conversation the user
 * is typing into — never some unrelated top-of-list session.
 */
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
