/** Child-process fixture for phase-c-isolation.test.ts; not a live DSH/model run. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_EVENT_INJECT_CONFIG, observeToolResult, prepareEventReminders } from '../src/event-inject.ts'
import { TemplateStore } from '../src/store.ts'

const [stage, dbPath, logPath] = process.argv.slice(2)
if (!['seed', 'prepare', 'log', 'reconcile'].includes(stage) || !dbPath || !logPath) throw new Error('invalid fixture arguments')
const store = new TemplateStore(dbPath)
const config = { ...DEFAULT_EVENT_INJECT_CONFIG, enabled: true }
const session = 'cross-process-fixture'
if (stage === 'seed') {
  store.events.updatePolicy('repeated-failure', { enabled: true })
  for (const id of ['a', 'b']) observeToolResult(store.events, config, {
    callId: id, name: 'bash', arguments: { command: 'synthetic-failure' },
    agent: { session: { header: { id: session } } },
  }, { isError: true, error: { info: { code: 'FIXTURE' } } })
}
const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []
let messages = []
if (stage !== 'seed') messages = prepareEventReminders(store.events, config, session,
  stage === 'prepare' ? 1 : 2, 2, () => log, { scanned: 0, keys: new Set() })
if (stage === 'log') {
  for (const message of messages) log.push({ type: 'user/message', data: { source: message.source } })
  writeFileSync(logPath, JSON.stringify(log))
}
console.log(JSON.stringify({ messages: messages.length, episodes: store.events.episodes(session), outbox: store.events.outbox(session) }))
// Intentionally exit before store.close(): the next worker must recover the
// committed SQLite state/WAL rather than inheriting this process's objects.
process.exit(0)
