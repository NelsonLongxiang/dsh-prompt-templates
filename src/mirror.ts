/**
 * The mirror: the agent's last few turn endings set side by side with what came next, so the agent can see its own
 * repetition before acting. A pattern only shows across occurrences; one turn at a time it never does. Rendered into the
 * `{{mirror}}` template variable at delivery. Pure: reads the session's durable events, imports nothing host-only.
 * @module dsh-prompt-templates/mirror
 */

/** Structural slice of a durable session event the mirror reads. */
export interface MirrorEventProbe {
  readonly type: string
  readonly data?: unknown
}

/** How many past turns the mirror shows, and how much of each. */
export const MIRROR_TURNS = 3
const ENDING_CHARS = 120
const REPLY_CHARS = 80

/** Who a user-channel message came from, for the mirror's label; null for injected context that is nobody's reply. */
function speaker(kind: string): string | null {
  if (kind === 'user') return '属主随后'
  if (kind === 'a2a-relay') return '他会话随后'
  if (kind === 'schedule') return '定时任务随后'
  return null
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string, text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
    .join(' ')
}

function oneLine(text: string): string {
  return text.split(/\s+/).filter(word => word !== '').join(' ')
}

interface Turn {
  ending: string
  actions: number
  next: { who: string, text: string } | null
}

/**
 * Render the mirror from a session's events.
 * @param events - the session's durable events, oldest first.
 * @param incoming - the message that opened the turn now being delivered, when it is not yet in the events.
 * @param turns - how many past turns to show.
 * @returns the mirror text, or '' when there is no finished turn yet.
 */
export function renderMirror(events: readonly MirrorEventProbe[], incoming?: { who: string, text: string }, turns: number = MIRROR_TURNS): string {
  const finished: Turn[] = []
  let current: Turn | null = null
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'user/message') {
      const source = data.source as { kind?: unknown } | undefined
      const who = speaker(typeof source?.kind === 'string' ? source.kind : '')
      if (who === null) continue
      // A reply closes the turn it answers and opens the next.
      if (current !== null && current.ending !== '') {
        current.next = { who, text: textOf(data.content) }
        finished.push(current)
      }
      current = { ending: '', actions: 0, next: null }
    } else if (current !== null && event.type === 'assistant/message') {
      const message = data.message as { content?: unknown } | undefined
      const text = textOf(message?.content)
      if (text.trim() !== '') current.ending = text
    } else if (current !== null && event.type === 'tool/call') {
      current.actions += 1
    }
  }
  if (incoming !== undefined && current !== null && current.ending !== '') {
    current.next = incoming
    finished.push(current)
  }
  const shown = finished.slice(-turns)
  if (shown.length === 0) return ''
  const lines = shown.map(turn => {
    const ending = oneLine(turn.ending).slice(-ENDING_CHARS)
    const next = turn.next === null ? '' : `\n  ${turn.next.who}：${oneLine(turn.next.text).slice(0, REPLY_CHARS)}`
    return `· 你收尾（${turn.actions} 个动作）：…${ending}${next}`
  })
  return '镜（最近几轮你的收尾和随后来的话；动手前先看哪里在重复，不必说出来）：\n' + lines.join('\n')
}
