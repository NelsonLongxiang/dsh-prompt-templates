declare const __PROMPT_TEMPLATES_VERSION__: string

/** Canonical public source repository for the panel's metadata link. */
export const GITHUB_REPOSITORY_URL = 'https://github.com/NelsonLongXiang/dsh-prompt-templates'

/** Build-injected package version; `dev` only exists in unbundled unit tests. */
export const PLUGIN_VERSION = typeof __PROMPT_TEMPLATES_VERSION__ === 'string'
  ? __PROMPT_TEMPLATES_VERSION__
  : 'dev'

/** Header count: current-tab size when idle, matched/searchable when searching. */
export function templateCountLabel(matched: number, searchable: number, searching: boolean): string {
  return searching ? `${matched}/${searchable}` : String(matched)
}
