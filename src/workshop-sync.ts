/** Opt-in host-owned workshop updater. Git uses argv, bounded noninteractive subprocesses, never shell/reset/stash. */
import { spawn } from 'node:child_process'
import { realpath, readFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { devNull } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { TemplateStore } from './store.ts'

export interface WorkshopSyncConfig { enabled: boolean; repository: string; intervalMinutes: number; timeoutMs: number }
export const DEFAULT_WORKSHOP_SYNC: WorkshopSyncConfig = { enabled: false, repository: '', intervalMinutes: 30, timeoutMs: 30000 }
export class SyncFailure extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code } }
export type { WorkshopSyncResult } from './types.ts'
import type { WorkshopSyncResult, WorkshopSyncEntry as SyncEntry } from './types.ts'
export type GitRunner = (cwd: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>
/** Errors are stable codes only: stdout/stderr/remote URLs/credentials never enter logs or API responses. */
export function createGitRunner(spawnGit = spawn): GitRunner { return (cwd, args, timeoutMs, signal) => new Promise((done, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  let timedOut = false, tooLarge = false, output = '', bytes = 0, credentialFailure = false
  const decoder = new StringDecoder('utf8')
  const child = spawnGit('git', ['-c', 'core.hooksPath=' + devNull, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.ext.allow=never', '-c', 'core.askPass=', '-c', 'credential.interactive=false', '-c', 'core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes', ...args], {
    cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' },
  })
  // Stop only the subprocess tree we spawned. Never kill the DSH host or unrelated agents.
  let terminating = false
  const terminate = () => {
    if (terminating) return
    terminating = true
    if (child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill('SIGKILL') })
        killer.on('exit', code => { if (code !== 0 && child.exitCode === null) child.kill('SIGKILL') })
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    } else child.kill('SIGKILL')
  }
  const timer = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
  const abort = () => { terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 8 * 1024 * 1024) { tooLarge = true; terminate() } else output += decoder.write(data) })
  // Classify only, never retain diagnostics that can contain remote userinfo or tokens.
  child.stderr.on('data', (data: Buffer) => { if (/authentication|credential|could not read (username|password)|permission denied|terminal prompts disabled|host key verification failed/i.test(data.toString('utf8'))) credentialFailure = true })
  child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new SyncFailure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git-missing' : 'git-start-failed')) })
  child.on('close', code => {
    clearTimeout(timer); signal?.removeEventListener('abort', abort)
    if (signal?.aborted) reject(new SyncFailure('cancelled'))
    else if (timedOut) reject(new SyncFailure('git-timeout'))
    else if (tooLarge) reject(new SyncFailure('git-output-limit'))
    else if (code !== 0) reject(new SyncFailure(credentialFailure ? 'git-credentials' : 'git-failed'))
    else done(output + decoder.end())
  })
}) }
export const runGit = createGitRunner()

export interface WorkshopCard { id: string; name: string; content: string; category: string | null; description?: string; position: number; mode: 'inject' | 'visible' }
export interface WorkshopPayload { path: string; main: boolean; cards: WorkshopCard[]; categories: string[] }
/** The share envelope is reused, but schedule/consent fields in a repository are never authority. */
export function parseWorkshopPayload(text: string, path: string): WorkshopPayload {
  const data = JSON.parse(text) as Record<string, unknown>
  if (data?.format !== 'dsh-prompt-templates' || data.version !== 1 || data.kind !== 'templates' || !Array.isArray(data.templates) || data.templates.length > 2000) throw new SyncFailure('invalid-payload')
  const categories: string[] = []
  if (data.categories !== undefined) {
    if (!Array.isArray(data.categories)) throw new SyncFailure('invalid-payload')
    for (const raw of data.categories) {
      if (!raw || raw.scope !== 'global' || raw.session_id != null || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128) throw new SyncFailure('invalid-payload')
      categories.push(raw.name)
    }
  }
  const names = new Set<string>(), ids = new Set<string>()
  const cards = data.templates.map((raw: unknown): WorkshopCard => {
    const row = raw as Record<string, unknown>
    if (!row || row.scope !== 'global' || row.session_id != null || typeof row.id !== 'string' || !row.id || row.id.length > 128 || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 128 || typeof row.content !== 'string' || !row.content || row.content.length > 100000 || (row.category != null && (typeof row.category !== 'string' || !row.category.trim() || row.category.length > 128))) throw new SyncFailure('invalid-payload')
    if (names.has(row.name) || ids.has(row.id)) throw new SyncFailure('ambiguous-payload')
    names.add(row.name); ids.add(row.id)
    return { id: row.id, name: row.name, content: row.content, category: row.category as string | null ?? null, position: Number.isSafeInteger(row.position) && Number(row.position) >= 0 ? Number(row.position) : 0, mode: row.mode === 'inject' ? 'inject' : 'visible', ...(typeof row.description === 'string' && row.description.length <= 512 ? { description: row.description } : {}) }
  })
  return { path, main: path === 'assets/injection-templates.json', cards, categories }
}
const cardKey = (card: WorkshopCard) => JSON.stringify([card.id, card.name, card.category])
export type CardHistory = Map<string, Set<string>>
export function collectCardHistory(payloads: readonly WorkshopPayload[]): CardHistory {
  const history: CardHistory = new Map()
  for (const p of payloads) for (const card of p.cards) { const key = cardKey(card); const texts = history.get(key) ?? new Set(); texts.add(card.content); history.set(key, texts) }
  return history
}
/** One SQLite transaction, re-reading current rows inside it. Human text and all delivery consent stay untouched. */
export function applyWorkshopCards(store: TemplateStore, payloads: readonly WorkshopPayload[], history: CardHistory): Pick<WorkshopSyncResult, 'added' | 'updated' | 'skipped'> {
  return store.transaction(() => {
    const result: Pick<WorkshopSyncResult,'added'|'updated'|'skipped'> = { added: [], updated: [], skipped: [] }
    const main = payloads.filter(p => p.main)
    for (const p of main) for (const name of p.categories) if (!store.listCategories().some(c => c.scope === 'global' && c.name === name)) store.createCategory({ name, scope: 'global' })
    const used = new Set<string>()
    for (const p of [...main, ...payloads.filter(p => !p.main)]) for (const card of p.cards) {
      const entry = { name: card.name, category: card.category }
      if (used.has(card.name)) throw new SyncFailure('ambiguous-payload')
      used.add(card.name)
      const skip = (reason: string) => result.skipped.push({ ...entry, reason })
      if (card.category && !store.listCategories().some(c => c.scope === 'global' && c.name === card.category)) { skip('category-missing'); continue }
      const matches = store.list().filter(row => row.name === card.name)
      if (matches.some(row => row.scope !== 'global' || row.category !== card.category) || matches.length > 1) { skip('name-conflict'); continue }
      const row = matches[0]
      if (!row) {
        store.create({ name: card.name, content: card.content, scope: 'global', category: card.category, description: card.description ?? null, position: card.position, mode: card.mode, inject_enabled: false, inject_every: null })
        result.added.push(entry); continue
      }
      if (row.content === card.content) { skip('unchanged'); continue }
      if (!history.get(cardKey(card))?.has(row.content)) { skip('human-edited'); continue }
      // Do not bypass S1's owner confirmation gate for active global system sections.
      if (row.system_prompt) { skip('global-confirmation-required'); continue }
      store.update(row.id, { content: card.content })
      result.updated.push(entry)
    }
    return result
  })
}

const activeRepositories = new Set<string>()
const sha = (text: string) => { const value = text.trim(); if (!/^[a-f0-9]{40,64}$/.test(value)) throw new SyncFailure('invalid-git-response'); return value }
const payloadPaths = (text: string) => text.split('\0').filter(p => /^assets\/injection-templates[^/]*\.json$/.test(p)).sort()
/** Per-run snapshots come from pinned Git objects, never a linked/untracked JSON file on disk. */
export async function syncWorkshop(config: WorkshopSyncConfig, store: () => TemplateStore, git: GitRunner = runGit, signal?: AbortSignal): Promise<WorkshopSyncResult> {
  const result: WorkshopSyncResult = { started_at: new Date().toISOString(), finished_at: null, commit: null, status: config.enabled ? 'running' : 'disabled', added: [], updated: [], skipped: [], error: null }
  if (!config.enabled) { result.finished_at = new Date().toISOString(); return result }
  let root: string | undefined
  let ownsLock = false
  try {
    if (!config.repository.trim()) throw new SyncFailure('repository-required')
    root = await realpath(resolve(config.repository))
    if (/^(deepseek-harness|dsh)$/i.test(basename(root)) || /[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh(?:[\\/]|$)/i.test(root)) throw new SyncFailure('implementation-checkout-forbidden')
    let manifest: { name?: string } | null = null
    try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: string } } catch { /* skills may not be packages */ }
    if (manifest?.name === '@deepseek-ai/dsh' || manifest?.name === 'deepseek-harness') throw new SyncFailure('implementation-checkout-forbidden')
    if (activeRepositories.has(root)) { result.status = 'skipped'; result.error = 'already-running'; return result }
    activeRepositories.add(root); ownsLock = true
    const end = Date.now() + Math.max(1000, Math.min(120000, config.timeoutMs))
    const run = (args: readonly string[]) => { if (signal?.aborted) throw new SyncFailure('cancelled'); const remaining = end - Date.now(); if (remaining <= 0) throw new SyncFailure('sync-timeout'); return git(root!, args, remaining, signal) }
    const top = await realpath((await run(['rev-parse','--show-toplevel'])).trim())
    if (top !== root) throw new SyncFailure('repository-root-required')
    // Never target a DSH implementation checkout or a non-skill repository by accident.
    const tracked = payloadPaths(await run(['ls-tree','-r','--name-only','-z','HEAD','--','assets']))
    if (!tracked.includes('assets/injection-templates.json')) throw new SyncFailure('main-payload-missing')
    if ((await run(['ls-tree','--name-only','HEAD','--','apps/web','packages/agent','packages/dsh-agent'])).trim()) throw new SyncFailure('implementation-checkout-forbidden')
    if ((await run(['status','--porcelain=v1','--untracked-files=all'])).trim()) { result.status = 'skipped'; result.error = 'dirty-worktree'; return result }
    const branch = (await run(['branch','--show-current'])).trim()
    if (!branch) { result.status = 'skipped'; result.error = 'non-default-branch'; return result }
    const remoteHead = await run(['ls-remote','--symref','origin','HEAD'])
    const defaultBranch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(remoteHead)?.[1]
    if (!defaultBranch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(defaultBranch)) throw new SyncFailure('default-branch-unavailable')
    if (branch !== defaultBranch) { result.status = 'skipped'; result.error = 'non-default-branch'; return result }
    const before = sha(await run(['rev-parse','HEAD'])); result.commit = before
    await run(['fetch','--no-tags','--no-recurse-submodules','origin','+refs/heads/' + defaultBranch + ':refs/remotes/origin/' + defaultBranch])
    const target = sha(await run(['rev-parse','refs/remotes/origin/' + defaultBranch]))
    if (before !== target) {
      try { await run(['merge-base','--is-ancestor',before,target]) } catch (error) { if (!(error instanceof SyncFailure) || error.code !== 'git-failed') throw error; result.status = 'skipped'; result.error = 'not-fast-forward'; return result }
      if ((await run(['status','--porcelain=v1','--untracked-files=all'])).trim() || sha(await run(['rev-parse','HEAD'])) !== before || (await run(['symbolic-ref','--short','HEAD'])).trim() !== branch) throw new SyncFailure('repository-changed')
      await run(['merge','--ff-only','--no-edit','--no-overwrite-ignore',target])
    }
    result.commit = sha(await run(['rev-parse','HEAD']))
    if (result.commit !== target || (await run(['status','--porcelain=v1','--untracked-files=all'])).trim()) throw new SyncFailure('repository-changed')
    const paths = payloadPaths(await run(['ls-tree','-r','--name-only','-z',result.commit,'--','assets']))
    if (!paths.includes('assets/injection-templates.json')) throw new SyncFailure('main-payload-missing')
    if (paths.length > 24) throw new SyncFailure('payload-limit')
    const current: WorkshopPayload[] = [], historical: WorkshopPayload[] = []
    let payloadBytes = 0
    const readPayload = async (ref: string, path: string) => {
      const text = await run(['show',ref + ':' + path]); payloadBytes += Buffer.byteLength(text, 'utf8')
      if (payloadBytes > 16 * 1024 * 1024) throw new SyncFailure('history-size-limit')
      return parseWorkshopPayload(text, path)
    }
    for (const path of paths) {
      if (!(await run(['ls-tree',result.commit,'--',path])).startsWith('100644 blob ')) throw new SyncFailure('payload-not-regular')
      current.push(await readPayload(result.commit, path))
      const revisions = (await run(['rev-list','--max-count=201',result.commit,'--',path])).trim().split(/\r?\n/).filter(Boolean)
      if (revisions.length > 200) throw new SyncFailure('history-limit')
      for (const revision of revisions) {
        const ref = sha(revision)
        try { historical.push(await readPayload(ref, path)) } catch (error) {
          // Missing/old incompatible history is not a proof of ownership. Stop rather than overwrite with incomplete provenance.
          throw new SyncFailure(error instanceof SyncFailure ? error.code : 'invalid-history')
        }
      }
    }
    if (signal?.aborted) throw new SyncFailure('cancelled')
    Object.assign(result, applyWorkshopCards(store(), current, collectCardHistory([...current,...historical])))
    result.status = 'ok'
  } catch (error) { result.status = 'error'; result.error = error instanceof SyncFailure ? error.code : 'sync-failed' }
  finally { if (root && ownsLock) activeRepositories.delete(root); result.finished_at = new Date().toISOString() }
  return result
}
