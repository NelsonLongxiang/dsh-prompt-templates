/**
 * Stage one of the prompt-templates sidebar tab: what the type IS.
 *
 * A page type — it claims no address (no `patterns`): it opens by kind via
 * the guide page's entry box or the tab strip's '+' picker. Stage two (the
 * keyed 'sidebar.right.pane.tab' body registration) lives in
 * client/index.ts and lands the PromptTab component under the same `id`.
 *
 * Pure data with a type-only dependency on the sidebar package, so this
 * module carries zero runtime imports and unit tests load it bare.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this plugin owns — the name openTab and the guide dispatch by. */
export const PROMPT_TEMPLATES_KIND = 'promptTemplates'

/**
 * This implementation's identity in the tab system, and the key its body
 * registers under in the 'sidebar.right.pane.tab' seat (a package name is
 * the natural value, exactly as the builtin files tab does).
 */
export const PROMPT_TEMPLATES_ID = '@nelsonlongxiang/dsh-prompt-templates'

/** Guide entry identity within this provider. */
const GUIDE_ENTRY_ID = 'prompt-templates'

/** The dictionary keys this definition reads (narrow union so the locale
 * plugin's namespace-bound translate is assignable — its parameter is the
 * full PromptTemplateKey union, contravariantly compatible with this one). */
export type PromptTabLocaleKey = 'tab.title' | 'tab.guideTitle' | 'tab.guideDescription'

/**
 * The prompt-templates type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call
 *   (a language change needs no re-registration).
 * @returns the definition to register.
 */
export function promptTemplatesTabDefinition(t: (key: PromptTabLocaleKey) => string): SidebarRightTabDefinition {
  return {
    id: PROMPT_TEMPLATES_ID,
    kind: PROMPT_TEMPLATES_KIND,
    // A page type: no patterns, opened by kind, recognizes no address.
    // Omitted priority defaults to 'extension' — correct for a type from
    // outside the product, and the band that outranks builtin viewers.
    title: () => t('tab.title'),
    guide: [{
      id: GUIDE_ENTRY_ID,
      order: 20,
      title: () => t('tab.guideTitle'),
      description: () => t('tab.guideDescription'),
    }],
  }
}
