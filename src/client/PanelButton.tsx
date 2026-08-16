/**
 * Composer entry button: toggles the quick prompt panel. Registered into
 * conversation.input.right (the tool row, before the send button). The
 * session-scoped inject face carries the toggle verb, which routes through
 * ctx.promptPanel to the panel's store.
 */
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptPanelToggleFace } from './slots.ts'
import css from './PanelButton.module.css'

/** Full props of the composer entry. */
export type PanelButtonProps =
  PropsRuntime<'conversation.input.right'>
  & PromptPanelToggleFace
  & PropsLocale<'promptTemplates'>

/**
 * The composer tool-row button.
 * @param props - runtime kit (includes the InputZone owner share), the toggle verb, and the locale seat.
 */
export function PanelButton({ toggle, t }: PanelButtonProps) {
  return (
    <button
      type="button"
      className={css.button}
      onClick={toggle}
      aria-label={t('panel.open')}
      aria-pressed="false"
      title={t('panel.title')}
    >
      <span className={css.glyph}>▤</span>
    </button>
  )
}
