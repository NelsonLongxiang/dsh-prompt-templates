/**
 * Event-triggered reminders, observation half (pure): turn one final tool
 * outcome into redacted, hashed features. Nothing here touches the host or
 * storage, so the extraction can be replayed offline and tested exhaustively.
 *
 * What is kept: the tool name, two fingerprints (the shared "preparation"
 * part of the arguments and the task-specific "target" part), a structured
 * outcome class, and a short redacted summary for audit and reminder text.
 * What is never kept: raw arguments, output content, environment values,
 * tokens or passwords.
 *
 * @module dsh-prompt-templates/event-features
 */

import { createHash } from 'node:crypto'

/** Maximum length of the redacted summary kept per observation. */
export const SUMMARY_MAX = 160

/** Features extracted from one tool outcome. */
export interface ObservationFeatures {
  readonly toolName: string
  /** Hash of the shared preparation prefix; empty when the call carries none. */
  readonly stableFingerprint: string
  /** Hash of the task-specific remainder of the arguments. */
  readonly targetFingerprint: string
  /** `ok`, `error:<code>` or `error:unknown`; from structured fields only. */
  readonly outcome: string
  /** Structured exit code when the tool reports one in `meta`, else null. */
  readonly exitCode: number | null
  /** Short redacted summary for audit views and reminder text. */
  readonly summary: string
}

/** Structural slice of a final tool outcome the extractor reads. */
export interface ToolOutcomeProbe {
  readonly isError: boolean
  readonly error?: { readonly info?: { readonly code?: unknown } } | undefined
  readonly meta?: unknown
}

/** Short stable hash (hex) of a canonical string. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// Path separators are excluded so long interpreter paths stay readable.
const LONG_OPAQUE = /[A-Za-z0-9+_-]{32,}={0,2}/g
const BEARER = /\b(bearer|basic)\s+\S+/gi
const URL_CREDENTIALS = /(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g
const FLAG_SECRET = /(--?[\w-]*(?:token|secret|password|passwd|api[-_]?key|auth)[\w-]*)(=|\s+)(\S+)/gi
// An already-elided value (`NAME=…`) is left as is.
const ASSIGN_SECRET = /\b([\w.-]*(?:token|secret|password|passwd|api[-_]?key|auth)[\w.-]*)=(?!…(?:\s|$))(\S+)/gi

/**
 * Mask secrets in free text: bearer/basic credentials, credentials inside
 * URLs, secret-named flags and assignments, and long opaque strings. Errs
 * toward over-masking; the summary is for humans, not for replay.
 */
export function redact(text: string): string {
  return text
    .replace(BEARER, (_m, scheme: string) => `${scheme} ‹redacted›`)
    .replace(URL_CREDENTIALS, '$1‹redacted›@')
    .replace(FLAG_SECRET, (_m, flag: string, sep: string) => `${flag}${sep}‹redacted›`)
    .replace(ASSIGN_SECRET, (_m, name: string) => `${name}=‹redacted›`)
    .replace(LONG_OPAQUE, '‹redacted›')
}

/** Truncate to SUMMARY_MAX characters with an ellipsis. */
function clip(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`
}

/** Split a shell command into whitespace tokens, keeping quoted spans intact. */
export function shellTokens(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command.trim()) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const ABSOLUTE_PATH = /^(?:["']?)(?:\/|[A-Za-z]:[\\/]|\\\\)/

/**
 * Split a shell command into its shared preparation prefix and the task part.
 * The prefix is: leading `NAME=value` assignments, then — only when it is an
 * absolute path — the interpreter, then the option flags that directly follow
 * it. A command with neither assignments nor an absolute interpreter has no
 * preparation prefix (an ordinary `git status` is not "manual preparation").
 */
export function splitShellPreparation(command: string): { prefix: string[], task: string[] } {
  const tokens = shellTokens(command)
  let index = 0
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? '')) index += 1
  const assignments = index
  const interpreter = tokens[index]
  if (interpreter !== undefined && ABSOLUTE_PATH.test(interpreter)) {
    index += 1
    while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) index += 1
  } else if (assignments === 0) {
    return { prefix: [], task: tokens }
  }
  return { prefix: tokens.slice(0, index), task: tokens.slice(index) }
}

/** Summary form of a preparation prefix: assignment values are never shown. */
function prefixSummary(prefix: readonly string[]): string {
  return prefix.map(token => ENV_ASSIGNMENT.test(token) ? `${token.slice(0, token.indexOf('='))}=…` : token).join(' ')
}

/** The shell command carried by a call's arguments, when there is one. */
export function shellCommandOf(args: unknown): string | null {
  if (typeof args === 'string') return null
  if (args === null || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.every(part => typeof part === 'string') && value.length > 0) return value.join(' ')
  }
  return null
}

/** Canonical JSON with sorted keys, so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Outcome class from structured fields only — never from output text. */
export function outcomeClass(result: ToolOutcomeProbe): string {
  if (!result.isError) return 'ok'
  const code = result.error?.info?.code
  return typeof code === 'string' && code !== '' ? `error:${code}` : 'error:unknown'
}

/** Structured exit code when `meta` carries one (`exitCode` number), else null. */
export function exitCodeOf(meta: unknown): number | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = (meta as Record<string, unknown>)['exitCode']
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** Extract the redacted features of one final tool outcome. */
export function extractFeatures(toolName: string, args: unknown, result: ToolOutcomeProbe): ObservationFeatures {
  const outcome = outcomeClass(result)
  const exitCode = exitCodeOf(result.meta)
  const command = shellCommandOf(args)
  if (command !== null) {
    const { prefix, task } = splitShellPreparation(command)
    const taskText = task.join(' ')
    const shown = prefix.length > 0 ? `${prefixSummary(prefix)} ${taskText}` : taskText
    return {
      toolName,
      stableFingerprint: prefix.length > 0 ? fingerprint(`${toolName}\u0000${prefix.join(' ')}`) : '',
      targetFingerprint: fingerprint(`${toolName}\u0000${taskText}`),
      outcome,
      exitCode,
      summary: clip(redact(shown.trim())),
    }
  }
  const canonical = canonicalJson(args ?? null)
  return {
    toolName,
    stableFingerprint: '',
    targetFingerprint: fingerprint(`${toolName}\u0000${canonical}`),
    outcome,
    exitCode,
    summary: clip(redact(`${toolName} ${canonical}`)),
  }
}
