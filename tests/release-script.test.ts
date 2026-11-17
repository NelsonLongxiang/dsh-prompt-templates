/** Offline synthetic repositories, not clones/worktrees: no real registry, tag push or production side effects. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, delimiter, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createTestDirectory } from './temp-dir.mjs'

const project = fileURLToPath(new URL('..', import.meta.url))
const subject = 'synthetic release'
const version = '1.1.0'
const message = 'chore(release): ' + version + ' — ' + subject

function fixture(t: { after(fn: () => void): void }, space = false) {
  const dir = createTestDirectory('release-guard-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, space ? 'project with spaces' : 'project')
  const remote = join(dir, 'remote.git')
  const stubs = join(dir, 'stubs')
  const trace = join(dir, 'commands.jsonl')
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'docs')); mkdirSync(stubs)
  copyFileSync(join(project, 'scripts', 'release.sh'), join(root, 'scripts', 'release.sh'))
  if (existsSync(join(project, 'scripts', 'release-guard.mjs'))) copyFileSync(join(project, 'scripts', 'release-guard.mjs'), join(root, 'scripts', 'release-guard.mjs'))
  writeFileSync(join(root, 'scripts', 'push-master.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ngit push github master\n')
  writeFileSync(join(root, '.gitignore'), '/tmp/\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@nelsonlongxiang/dsh-prompt-templates', version: '1.0.0' }, null, 2) + '\n')
  writeFileSync(join(root, 'docs', 'release-notes-1.0.0.md'), '# baseline\n')
  const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, env: baseEnv, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.error, undefined, r.error?.message)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q', '--initial-branch=master')
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Release Fixture')
  git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgsign', 'false')
  git('add', '.gitignore', 'package.json', 'docs/release-notes-1.0.0.md', 'scripts')
  git('commit', '-qm', 'synthetic baseline')
  const base = git('rev-parse', 'HEAD')
  git('init', '-q', '--bare', remote); git('remote', 'add', 'github', remote); git('push', '-q', 'github', 'master'); git('fetch', '-q', 'github')
  copyFileSync(join(project, 'tests', 'release-stubs.mjs'), join(stubs, 'handler.mjs'))
  for (const tool of ['pnpm', 'npm', 'curl', 'gh', 'sleep']) {
    const content = tool === 'sleep'
      ? '#!/usr/bin/env bash\nif [ "${RELEASE_FIXTURE_CANCEL:-0}" = 1 ]; then kill -TERM "$PPID"; exit 143; fi\nexit 0\n'
      : '#!/usr/bin/env bash\nexec node "$RELEASE_FIXTURE_HANDLER" ' + tool + ' "$@"\n'
    writeFileSync(join(stubs, tool), content, { mode: 0o755 })
  }
  const env = { ...baseEnv, RELEASE_FIXTURE_ROOT: root, RELEASE_FIXTURE_HANDLER: join(stubs, 'handler.mjs'), RELEASE_FIXTURE_TRACE: trace }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const oldPath = env[pathKey] ?? ''
  delete env[pathKey]; env.PATH = stubs + delimiter + oldPath
  const interception = spawnSync('bash', ['-c', 'set -eu; expected=$(cd "$RELEASE_FIXTURE_STUBS" && pwd -P); for tool in pnpm npm curl gh sleep; do [ "$(command -v "$tool")" = "$expected/$tool" ] || exit 92; done'], { cwd: root, env: { ...env, RELEASE_FIXTURE_STUBS: stubs }, encoding: 'utf8', timeout: 10_000 })
  assert.equal(interception.status, 0, 'offline command interception must be proved before any release execution: ' + interception.stderr)
  const prepare = () => {
    const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); p.version = version
    writeFileSync(join(root, 'package.json'), JSON.stringify(p, null, 2) + '\n')
    writeFileSync(join(root, 'docs', 'release-notes-' + version + '.md'), '# synthetic notes\n')
  }
  const commit = (title = message, files = ['package.json', 'docs/release-notes-' + version + '.md']) => { git('add', ...files); git('commit', '-qm', title); return git('rev-parse', 'HEAD') }
  const run = (extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['scripts/release.sh', subject], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
    assert.equal(r.error, undefined, r.error?.message)
    return r
  }
  const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<{ tool: string; args: string[]; cwd: string }> : []
  const pubs = () => calls().filter(c => c.tool === 'npm' && c.args[0] === 'publish')
  return { root, remote, base, git, prepare, commit, run, calls, pubs, dir }
}

for (const detached of [false, true]) test('rejects ' + (detached ? 'detached HEAD' : 'feature branch') + ' before verify or publish', t => {
  const f = fixture(t)
  if (detached) f.git('switch', '-q', '--detach'); else f.git('switch', '-qc', 'feature')
  f.prepare(); f.commit(); f.git('update-ref', 'refs/heads/master', f.git('rev-parse', 'HEAD')); f.git('push', '-q', 'github', 'master')
  const r = f.run({ DRYRUN: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(f.calls().length, 0)
})

test('fresh version-only bump + notes creates exactly one release commit and confines pack scratch', t => {
  const f = fixture(t); f.prepare()
  const r = f.run(); assert.equal(r.status, 0, r.stdout + r.stderr)
  const head = f.git('rev-parse', 'HEAD')
  assert.equal(f.git('log', '-1', '--format=%s'), message)
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1')
  assert.equal(f.git('rev-parse', 'v1.1.0^{commit}'), head)
  assert.equal(f.git('ls-remote', '--tags', 'github', 'refs/tags/v1.1.0').split(/\s+/)[0], head)
  assert.equal(f.pubs().length, 2)
  const pack = f.calls().find(c => c.tool === 'npm' && c.args[0] === 'pack')
  assert.ok(pack)
  assert.equal(resolve(dirname(pack.cwd)), resolve(f.root, 'tmp', 'release'))
  assert.equal(existsSync(pack.cwd), false, 'scratch cleaned on successful exit')
})

test('clean exact release commit can resume before first publish without creating another commit', t => {
  const f = fixture(t); f.prepare(); const head = f.commit()
  const r = f.run({ RELEASE_FIXTURE_PUBLISH_EXIT: '41' })
  assert.equal(r.status, 41, r.stdout + r.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.pubs().length, 1, 'no automatic retry')
})

for (const title of ['chore(release): 1.1.00 — synthetic release', 'chore(release): 1.1.0-extra — synthetic release', 'not chore(release): 1.1.0 — synthetic release']) {
  test('rejects similar or substring release title ' + title, t => {
    const f = fixture(t); f.prepare(); f.commit(title); const r = f.run({ DRYRUN: '1' })
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.calls().length, 0)
  })
}

for (const dirty of [false, true]) test('rejects foreign ' + (dirty ? 'dirty path' : 'committed path') + ' in release material', t => {
  const f = fixture(t); f.prepare(); writeFileSync(join(f.root, 'unrelated.txt'), 'foreign')
  if (!dirty) f.commit(message, ['package.json', 'docs/release-notes-1.1.0.md', 'unrelated.txt'])
  const r = f.run({ DRYRUN: '1' }); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.calls().length, 0)
})

test('rejects a package edit beyond the version even with an exact release title', t => {
  const f = fixture(t); f.prepare(); const p = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')); p.name = 'different-package'
  writeFileSync(join(f.root, 'package.json'), JSON.stringify(p)); f.commit()
  const r = f.run({ DRYRUN: '1' }); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.calls().length, 0)
})

for (const location of ['local', 'remote'] as const) test('conflicting ' + location + ' tag is refused before any publish', t => {
  const f = fixture(t); f.prepare(); f.commit(); f.git('tag', 'v1.1.0', f.base)
  if (location === 'remote') { f.git('push', '-q', 'github', 'v1.1.0'); f.git('tag', '-d', 'v1.1.0') }
  const r = f.run(); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.pubs().length, 0); assert.equal(f.calls().length, 0)
})

test('same-target annotated local and remote tag is idempotent', t => {
  const f = fixture(t); f.prepare(); const head = f.commit(); f.git('tag', '-a', 'v1.1.0', '-m', 'synthetic', head); f.git('push', '-q', 'github', 'v1.1.0')
  const r = f.run(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(f.git('rev-parse', 'v1.1.0^{commit}'), head)
})

for (const mutate of ['head', 'file', 'index']) test('verification-time ' + mutate + ' drift cannot be published', t => {
  const f = fixture(t); f.prepare(); const r = f.run({ RELEASE_FIXTURE_MUTATE: mutate })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.pubs().length, 0)
})

test('pack failure cleans only its own project scratch and never reaches public publish', t => {
  const f = fixture(t); f.prepare(); const r = f.run({ RELEASE_FIXTURE_PACK_EXIT: '42' })
  assert.equal(r.status, 42, r.stdout + r.stderr); assert.equal(f.pubs().length, 1)
  const pack = f.calls().find(c => c.tool === 'npm' && c.args[0] === 'pack'); assert.ok(pack)
  assert.equal(resolve(dirname(pack.cwd)), resolve(f.root, 'tmp', 'release')); assert.equal(existsSync(pack.cwd), false)
})

test('TERM interruption cleans project scratch and leaves no real commands to retry', t => {
  const f = fixture(t); f.prepare(); const r = f.run({ RELEASE_FIXTURE_CANCEL: '1' })
  assert.equal(r.status, 143, r.stdout + r.stderr)
  const pack = f.calls().find(c => c.tool === 'npm' && c.args[0] === 'pack'); assert.ok(pack)
  assert.equal(resolve(dirname(pack.cwd)), resolve(f.root, 'tmp', 'release')); assert.equal(existsSync(pack.cwd), false)
})

test('DRYRUN verifies without committing, publishing, creating scratch or tags', t => {
  const f = fixture(t); f.prepare(); const r = f.run({ DRYRUN: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.deepEqual(f.calls().map(c => c.tool), ['pnpm'])
  assert.equal(f.git('tag', '--list'), '')
  assert.equal(existsSync(join(f.root, 'tmp')), false)
})

test('verify failure exits before committing or publishing', t => {
  const f = fixture(t); f.prepare(); const r = f.run({ RELEASE_FIXTURE_VERIFY_EXIT: '43' })
  assert.equal(r.status, 43, r.stdout + r.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base); assert.equal(f.pubs().length, 0)
})

test('source paths containing spaces use the same exact release flow', t => {
  const f = fixture(t, true); f.prepare(); const r = f.run()
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(f.pubs().length, 2)
})

for (const mutation of ['tag', 'remote']) test('verify-time ' + mutation + ' identity drift stops before publish', t => {
  const f = fixture(t); f.prepare()
  if (mutation === 'remote') { f.commit(); f.git('push', '-q', 'github', 'master') }
  const r = f.run({ RELEASE_FIXTURE_MUTATE: mutation })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.pubs().length, 0)
})

test('same peeled target but different local/remote tag objects need no overwrite push', t => {
  const f = fixture(t); f.prepare(); const head = f.commit()
  f.git('tag', '-a', 'v1.1.0', '-m', 'remote-annotation', head); f.git('push', '-q', 'github', 'v1.1.0')
  const remoteTag = f.git('ls-remote', '--tags', 'github', 'refs/tags/v1.1.0')
  f.git('tag', '-d', 'v1.1.0'); f.git('tag', 'v1.1.0', head)
  const r = f.run(); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(f.git('ls-remote', '--tags', 'github', 'refs/tags/v1.1.0'), remoteTag)
})

for (const dangling of [false, true]) test('linked scratch parent is rejected without touching target (dangling=' + dangling + ')', t => {
  const f = fixture(t); f.prepare(); const outside = join(f.dir, 'not-release-scratch')
  if (!dangling) mkdirSync(outside)
  symlinkSync(outside, join(f.root, 'tmp'), process.platform === 'win32' ? 'junction' : 'dir')
  const r = f.run(); assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(f.pubs().length, 0); assert.equal(existsSync(outside), !dangling)
  if (!dangling) assert.deepEqual(readdirSync(outside), [])
})

test('helper refuses arbitrary cleanup targets and preserves their contents', t => {
  const f = fixture(t); const protectedPath = join(f.dir, 'keep.txt'); writeFileSync(protectedPath, 'keep')
  const r = spawnSync(process.execPath, ['scripts/release-guard.mjs', 'scratch-remove', '../keep.txt'], { cwd: f.root, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.equal(readFileSync(protectedPath, 'utf8'), 'keep')
})


test('already pushed exact release commit is a valid pre-publish resume identity', t => {
  const f = fixture(t); f.prepare(); const head = f.commit(); f.git('push', '-q', 'github', 'master')
  const r = f.run({ DRYRUN: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.pubs().length, 0)
})

test('release notes symlink is rejected before verification or publication', t => {
  const f = fixture(t); f.prepare()
  const notes = join(f.root, 'docs', 'release-notes-1.1.0.md')
  const saved = readFileSync(notes)
  rmSync(notes)
  const target = join(f.dir, 'original-notes.md'); writeFileSync(target, saved)
  symlinkSync(target, notes, 'file')
  const r = f.run({ DRYRUN: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.calls().length, 0)
  assert.deepEqual(readFileSync(target), saved)
})

test('cleanup with a foreign ownership marker preserves the complete directory', t => {
  const f = fixture(t)
  const path = join(f.root, 'tmp', 'release', 'run-synthetic')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, '.release-owner.json'), JSON.stringify({ project: 'someone-else', path }))
  writeFileSync(join(path, 'keep.txt'), 'keep')
  const r = spawnSync(process.execPath, ['scripts/release-guard.mjs', 'scratch-remove', 'tmp/release/run-synthetic'], { cwd: f.root, encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.equal(readFileSync(join(path, 'keep.txt'), 'utf8'), 'keep')
})


test('a foreign staged path appearing during git add is never included in the release commit', t => {
  const f = fixture(t); f.prepare()
  const locate = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(locate.status, 0, locate.stderr)
  const realGit = locate.stdout.trim()
  assert.ok(realGit !== '' && !realGit.includes("'"))
  const wrapper = [
    '#!/usr/bin/env bash',
    'set -eu',
    'if [ "$1" = add ] && [ "' + '$' + '{2:-}" = -- ]; then',
    '  printf foreign > "$RELEASE_FIXTURE_ROOT/foreign.txt"',
    "  '" + realGit + "' add foreign.txt",
    'fi',
    "exec '" + realGit + "' \"$@\"",
  ].join('\n') + '\n'
  writeFileSync(join(f.dir, 'stubs', 'git'), wrapper, { mode: 0o755 })
  const result = f.run()
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.equal(f.pubs().length, 0)
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD').includes('foreign.txt'), false, 'never commit a concurrently staged foreign file')
  assert.equal(f.git('rev-parse', 'HEAD'), f.base, 'guard rejects before creating any release commit')
  assert.ok(f.git('diff', '--cached', '--name-only').split('\n').includes('foreign.txt'), 'do not clear or absorb the foreign staging')
})


test('CRLF working files with Git autocrlf use Git blob identity without rejecting normalized staging', t => {
  const f = fixture(t); f.git('config', 'core.autocrlf', 'true'); f.prepare()
  for (const file of ['package.json', 'docs/release-notes-1.1.0.md']) {
    const path = join(f.root, file)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'))
  }
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(f.pubs().length, 2)
})
