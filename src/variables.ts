/**
 * Template-variable expansion, shared by the host scheduled-injection path
 * and the composer delivery verbs (insert / send / interject). Client-safe:
 * no host-only imports, so the browser tsconfig project bundles it too.
 *
 * Semantics: a variable expands ONLY when its value is available in the
 * delivery context; unavailable and unknown placeholders stay literal, so
 * the user sees what did not resolve instead of a silent deletion. Storage
 * always keeps the raw template — expansion is a delivery-time concern.
 * @module dsh-prompt-templates/variables
 */

/** Variable names the expander understands (the advertised set). */
export const TEMPLATE_VARIABLES = ['date', 'time', 'datetime', 'weekday', 'session', 'turn'] as const

/** The placeholder namespace: a double-brace name with optional inner spacing. */
const PATTERN = /\{\{\s*(date|time|datetime|weekday|session|turn)\s*\}\}/g

/** What one delivery can tell the expander; every field optional. */
export interface VariableContext {
  /** The instant clock variables render from; defaults to now. */
  readonly now?: Date
  /** The session the delivery targets, when known. */
  readonly sessionId?: string
  /** The boundary turn, when the delivery is a scheduled injection. */
  readonly turn?: number
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Expand every resolvable placeholder in the content; the rest passes through. */
export function expandTemplateVariables(content: string, context: VariableContext): string {
  const now = context.now ?? new Date()
  const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
  const clock = pad(now.getHours()) + ':' + pad(now.getMinutes())
  return content.replace(PATTERN, (match, name: string) => {
    switch (name) {
      case 'date': return date
      case 'time': return clock
      case 'datetime': return date + ' ' + clock
      case 'weekday': return WEEKDAYS[now.getDay()] ?? match
      case 'session': return context.sessionId ?? match
      case 'turn': return context.turn !== undefined ? String(context.turn) : match
      default: return match
    }
  })
}
