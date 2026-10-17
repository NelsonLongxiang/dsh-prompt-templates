/**
 * The prompt-templates right-sidebar tab body: the shared template library
 * mounted into the 'sidebar.right.pane.tab' slot. The slot is
 * session-scoped, so the runtime kit hands the standard sessionId prop
 * directly — the delivery target is whichever session the sidebar is
 * viewing, no composer attachment needed. The tab chrome (icon row entry,
 * selection state) comes from the tab registration in tab.ts.
 */
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-session standard-props merge (sessionId on
// session-scoped slot components). The base package declares
// SessionStandardProps empty; each owning adapter merges its members.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TemplateLibraryFace } from './slots.ts'
import { TemplateLibrary } from './Library.tsx'
import css from './Panel.module.css'

/** Full props of the sidebar tab body entry. */
export type PromptTabProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & TemplateLibraryFace
  & PropsLocale<'promptTemplates'>

/**
 * The prompt-templates sidebar tab body.
 * @param props - runtime kit (carries sessionId), injected face members, locale.
 */
export function PromptTab(props: PromptTabProps) {
  const {
    sessionId, refresh, refreshCategories, createCategory, removeCategory,
    create, update, remove, makeGlobal,
    insert, send, interject, t,
  } = props
  return (
    <div className={css.tabBody} data-prompt-tab>
      <TemplateLibrary
        sessionId={sessionId}
        face={{ refresh, refreshCategories, createCategory, removeCategory, create, update, remove, makeGlobal, insert, send, interject }}
        t={t}
      />
    </div>
  )
}
