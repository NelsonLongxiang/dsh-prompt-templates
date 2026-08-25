import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { databaseSha256, exportDatabase, ImportBlockedError, importDatabase, searchTemplates } from './database.ts'
import { canonicalJson, diffSnapshots, mergeSnapshots, parseSnapshot, type DataSnapshot, type MergeStrategy } from './model.ts'

interface Envelope {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: { code: string; message: string; resolution?: string; retry?: boolean }
  readonly request_id: string
  readonly meta: { duration_ms: number }
}

const HELP = `dsh-prompt-templates — deterministic prompt-template database sync

Usage:
  dsh-prompt-templates export --db <path> --out <json> [--scope all|global|session] [--session-id <id>] [--output human|json]
  dsh-prompt-templates diff <left.json> <right.json> [--output human|json] [--json] [--fail-on-diff]
  dsh-prompt-templates merge <base.json> <incoming.json> --strategy newer|keep-base|keep-incoming --out <json> [--allow-name-conflicts] [--output human|json]
  dsh-prompt-templates import --db <path> --in <json> [--apply --expect-db-sha256 <sha> --confirm-summary-hash <sha>] [--backup-out <path>] [--max-changes <n>] [--output human|json]
  dsh-prompt-templates db-sha256 --db <path> [--output human|json]
  dsh-prompt-templates search --db <path> [--query <text>] [--category <name>] [--session-id <id>] [--limit <n>] [--output human|json]

Import is dry-run by default. --apply requires --expect-db-sha256 and creates a SQLite backup before one atomic transaction.
Search is read-only: globals always searchable; session-private rows only with --session-id (never other sessions).
`

export async function run(argv: readonly string[]): Promise<number> {
  const started = performance.now()
  const requestId = randomUUID()
  let jsonOutput = argv.includes('--json') || valueAfter(argv, '--output') === 'json'
  try {
    const command = argv[0]
    if (command === undefined || command === '--help' || command === '-h' || argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP)
      return 0
    }
    let data: unknown
    let exit = 0
    switch (command) {
      case 'export': {
        const db = required(argv, '--db')
        const out = required(argv, '--out')
        const scopeValue = valueAfter(argv, '--scope') ?? 'all'
        if (!['all', 'global', 'session'].includes(scopeValue)) throw new UsageError('--scope must be all, global, or session')
        const snapshot = exportDatabase(db, {
          ...(scopeValue !== 'all' ? { scope: scopeValue as 'global' | 'session' } : {}),
          ...(valueAfter(argv, '--session-id') !== undefined ? { sessionId: valueAfter(argv, '--session-id') } : {}),
        })
        writeFileSync(resolve(out), canonicalJson(snapshot), 'utf8')
        data = { out: resolve(out), templates: snapshot.templates.length, categories: snapshot.categories.length, data_sha256: snapshot.data_sha256 }
        break
      }
      case 'diff': {
        const leftPath = positional(argv, 1, 'left snapshot')
        const rightPath = positional(argv, 2, 'right snapshot')
        const result = diffSnapshots(readSnapshot(leftPath), readSnapshot(rightPath))
        data = result
        if (!result.identical && argv.includes('--fail-on-diff')) exit = 1
        break
      }
      case 'merge': {
        const basePath = positional(argv, 1, 'base snapshot')
        const incomingPath = positional(argv, 2, 'incoming snapshot')
        const strategy = required(argv, '--strategy') as MergeStrategy
        if (!['newer', 'keep-base', 'keep-incoming'].includes(strategy)) throw new UsageError('--strategy must be newer, keep-base, or keep-incoming')
        const out = required(argv, '--out')
        const result = mergeSnapshots(readSnapshot(basePath), readSnapshot(incomingPath), strategy, argv.includes('--allow-name-conflicts'))
        if (result.snapshot === undefined) { data = result; exit = 1 }
        else {
          writeFileSync(resolve(out), canonicalJson(result.snapshot), 'utf8')
          data = { out: resolve(out), data_sha256: result.snapshot.data_sha256, ...result.summary }
        }
        break
      }
      case 'import': {
        const db = required(argv, '--db')
        const input = readSnapshot(required(argv, '--in'))
        const maxRaw = valueAfter(argv, '--max-changes') ?? '100'
        const maxChanges = Number(maxRaw)
        if (!Number.isSafeInteger(maxChanges) || maxChanges < 0) throw new UsageError('--max-changes must be a non-negative integer')
        const result = await importDatabase(db, input, {
          apply: argv.includes('--apply'),
          maxChanges,
          ...(valueAfter(argv, '--expect-db-sha256') !== undefined ? { expectedDbSha256: valueAfter(argv, '--expect-db-sha256') } : {}),
          ...(valueAfter(argv, '--confirm-summary-hash') !== undefined ? { confirmedSummarySha256: valueAfter(argv, '--confirm-summary-hash') } : {}),
          ...(valueAfter(argv, '--backup-out') !== undefined ? { backupOut: valueAfter(argv, '--backup-out') } : {}),
        })
        data = result
        break
      }
      case 'db-sha256': data = { sha256: databaseSha256(required(argv, '--db')) }; break
      case 'search': {
        const db = required(argv, '--db')
        const limitRaw = valueAfter(argv, '--limit') ?? '20'
        const limit = Number(limitRaw)
        if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer')
        const sessionId = valueAfter(argv, '--session-id')
        if (sessionId === '') throw new UsageError('--session-id must be non-empty')
        data = searchTemplates(db, {
          limit,
          ...(valueAfter(argv, '--query') !== undefined ? { query: valueAfter(argv, '--query') } : {}),
          ...(valueAfter(argv, '--category') !== undefined ? { category: valueAfter(argv, '--category') } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
        break
      }
      default: throw new UsageError(`unknown command: ${command}`)
    }
    output(jsonOutput, { success: exit === 0, data, request_id: requestId, meta: { duration_ms: Math.round(performance.now() - started) } }, data)
    return exit
  } catch (error) {
    const usage = error instanceof UsageError
    const blocked = error instanceof ImportBlockedError
    const message = error instanceof Error ? error.message : String(error)
    const envelope: Envelope = { success: false, error: { code: usage ? 'INVALID_ARGUMENT' : blocked ? 'BLOCKED' : 'OPERATION_FAILED', message, resolution: usage ? 'Run with --help for usage.' : 'Review the input paths, schema, hashes, and database state.', retry: false }, request_id: requestId, meta: { duration_ms: Math.round(performance.now() - started) } }
    if (jsonOutput) process.stdout.write(`${JSON.stringify(envelope)}\n`)
    else process.stderr.write(`error: ${message}\n`)
    return blocked ? 1 : 2
  }
}

function output(json: boolean, envelope: Envelope, human: unknown): void {
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${humanText(human)}\n`)
}
function humanText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'identical' in value) {
    const diff = value as ReturnType<typeof diffSnapshots>
    return diff.identical
      ? 'No differences.'
      : `Differences: templates only-left=${diff.templates.only_left.length}, only-right=${diff.templates.only_right.length}, changed=${diff.templates.changed.length}, name-conflicts=${diff.templates.name_conflicts.length}; categories only-left=${diff.categories.only_left.length}, only-right=${diff.categories.only_right.length}`
  }
  return JSON.stringify(value, null, 2)
}
function readSnapshot(path: string): DataSnapshot { return parseSnapshot(JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown) }
function required(argv: readonly string[], name: string): string {
  const value = valueAfter(argv, name)
  if (value === undefined) throw new UsageError(`missing ${name}`)
  return value
}
function positional(argv: readonly string[], index: number, label: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('-')) throw new UsageError(`missing ${label}`)
  return value
}
function valueAfter(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(arg => arg.startsWith(`${name}=`))
  if (inline !== undefined) {
    const value = inline.slice(name.length + 1)
    if (value === '') throw new UsageError(`missing value for ${name}`)
    return value
  }
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${name}`)
  return value
}
class UsageError extends Error {}
