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

function fixture(t: { after(fn: () => void): void }, space = false, removedGuard?: string) {
  const dir = createTestDirectory('release-guard-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, space ? 'project with spaces' : 'project')
  const remote = join(dir, 'remote.git')
  const stubs = join(dir, 'stubs')
  const trace = join(dir, 'commands.jsonl')
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'docs')); mkdirSync(stubs)
  copyFileSync(join(project, 'scripts', 'release.sh'), join(root, 'scripts', 'release.sh'))
  copyFileSync(join(project, 'scripts', 'release-guard.mjs'), join(root, 'scripts', 'release-guard.mjs'))
  if (removedGuard !== undefined) {
    // Mutation is confined to this new fixture BEFORE its baseline commit.
    // Never modify the reviewed project source or a shared checkout to prove a test.
    const helper = join(root, 'scripts', 'release-guard.mjs')
    const source = readFileSync(helper, 'utf8')
    assert.equal(source.split(removedGuard).length, 2, 'mutation must remove exactly one matching guard')
    writeFileSync(helper, source.replace(removedGuard, '// one identity guard removed by offline regression'))
  }
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
  // A maintainer's DRYRUN=1 release.sh run executes pnpm verify, which runs
  // these tests. Fixture scripts must exercise the REAL flow, so strip the
  // ambient DRYRUN; individual tests opt back in via f.run({ DRYRUN: '1' }).
  delete (env as Record<string, string | undefined>).DRYRUN
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
  const run = (extra: Record<string, string> = {}, releaseSubject = subject) => {
    const r = spawnSync('bash', ['scripts/release.sh', releaseSubject, ...(extra.RELEASE_FIXTURE_IDENTITY ? ['--merged-prepared', extra.RELEASE_FIXTURE_IDENTITY] : [])], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
    assert.equal(r.error, undefined, r.error?.message)
    return r
  }
  const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<{ tool: string; args: string[]; cwd: string }> : []
  const pubs = () => calls().filter(c => c.tool === 'npm' && c.args[0] === 'publish')
  return { root, remote, base, git, prepare, commit, run, calls, pubs, dir, env }
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

test('rejects a different package name even with an exact release title', t => {
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

// PR #20 review cases A/B/C: each must fail before verification as well as
// before publication. The mutation checks call the SAME assertions and prove
// a single removed guard breaks its regression, even if a later layer stops it.
type ReleaseFixture = ReturnType<typeof fixture>
function remoteMaster(f: ReleaseFixture): string {
  const refs = f.git('ls-remote', '--heads', 'github', 'refs/heads/master').split(/\s+/)
  assert.equal(refs[1], 'refs/heads/master')
  return refs[0]!
}
function foreignCommit(f: ReleaseFixture): void {
  writeFileSync(join(f.root, 'foreign.txt'), 'not approved for release')
  f.git('add', 'foreign.txt')
  f.git('commit', '-qm', 'foreign unpublished change')
}
const identityCases = [
  {
    key: 'A-new-history',
    removedGuard: "if (head !== remote) fail('new release material requires master to equal remote github/master')",
    diagnostic: 'new release material requires master to equal remote github/master',
    setup(f: ReleaseFixture) { foreignCommit(f); f.prepare() },
  },
  {
    key: 'B-resume-history',
    removedGuard: "if (head !== remote && parents[1] !== remote) fail('unpublished history contains changes beyond the one exact release commit')",
    diagnostic: 'unpublished history contains changes beyond the one exact release commit',
    setup(f: ReleaseFixture) { foreignCommit(f); f.prepare(); f.commit() },
  },
  {
    key: 'C-version-only',
    removedGuard: "if (!isDeepStrictEqual(old, next)) fail('release package.json may change the version only; land other changes first')",
    diagnostic: 'release package.json may change the version only; land other changes first',
    setup(f: ReleaseFixture) {
      f.prepare()
      const path = join(f.root, 'package.json')
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(pkg.name, '@nelsonlongxiang/dsh-prompt-templates')
      pkg.dependencies = { 'synthetic-never-installed': '1.0.0' }
      writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
      f.commit()
    },
  },
]
function assertIdentityRejected(f: ReleaseFixture, result: ReturnType<ReleaseFixture['run']>, head: string, remote: string): void {
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.equal(f.pubs().length, 0, 'identity guard must stop before any publish')
  assert.equal(f.calls().length, 0, 'identity guard must stop before verify, not rely on a later check')
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'do not create a release commit on rejected inputs')
  assert.equal(remoteMaster(f), remote, 'remote master must remain unchanged')
}
for (const scenario of identityCases) {
  test('review identity ' + scenario.key + ' rejects exact counterexample before verify or publish', t => {
    const f = fixture(t); scenario.setup(f)
    const head = f.git('rev-parse', 'HEAD'); const remote = remoteMaster(f)
    assert.notEqual(head, remote, 'counterexample must really differ from remote master')
    const result = f.run()
    assertIdentityRejected(f, result, head, remote)
    assert.ok(result.stderr.includes(scenario.diagnostic), result.stderr)
    t.diagnostic(JSON.stringify({ case: scenario.key, guard: 'intact', exit: result.status, verify: 0, publish: 0, remoteChanged: false }))
  })
  test('review identity ' + scenario.key + ' regression turns red when only its guard is removed', t => {
    const f = fixture(t, false, scenario.removedGuard); scenario.setup(f)
    const head = f.git('rev-parse', 'HEAD'); const remote = remoteMaster(f)
    const result = f.run()
    assert.ok(f.calls().some(call => call.tool === 'pnpm'), 'mutant must pass the specific preflight, not fail on fixture/syntax setup')
    assert.throws(() => assertIdentityRejected(f, result, head, remote), assert.AssertionError)
    t.diagnostic(JSON.stringify({ case: scenario.key, guard: 'removed', exit: result.status,
      verify: f.calls().filter(call => call.tool === 'pnpm').length, publish: f.pubs().length,
      remoteChanged: remoteMaster(f) !== remote, rejectionAssertion: 'red' }))
  })
}

for (const releaseSubject of [' synthetic release', 'synthetic release ']) {
  test('rejects subject edge whitespace before verify and before creating a release commit: ' + JSON.stringify(releaseSubject), t => {
    const f = fixture(t); f.prepare(); const result = f.run({}, releaseSubject)
    assertIdentityRejected(f, result, f.base, f.base)
  })
}

// All URLs below are intercepted before execution; the fixture remote stays local.
function mergedFixture(t: Parameters<typeof fixture>[0], kind = 'normal') {
  const f = fixture(t)
  f.git('checkout', '-qb', 'prepared')
  f.prepare()
  if (kind === 'dependency') {
    const path = join(f.root, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.dependencies = { 'not-installed': '1.0.0' }; writeFileSync(path, JSON.stringify(pkg) + '\n')
  }
  if (kind === 'foreign') writeFileSync(join(f.root, 'foreign.txt'), 'not release material')
  const prepared = f.commit('arbitrary prepared PR title', kind === 'foreign' ? ['package.json', 'docs/release-notes-1.1.0.md', 'foreign.txt'] : undefined)
  f.git('checkout', '-q', 'master')
  const tree = f.git('rev-parse', prepared + '^{tree}')
  let parents = ['-p', f.base, '-p', prepared]
  if (kind === 'swapped') parents = ['-p', prepared, '-p', f.base]
  if (kind === 'three') {
    const third = f.git('commit-tree', tree, '-p', f.base, '-m', 'third fixture parent')
    parents.push('-p', third)
  }
  const merged = f.git('commit-tree', tree, ...parents, '-m', 'Merge pull request #7: not the single-parent release title')
  f.git('reset', '--hard', merged); f.git('push', '-q', 'github', 'master')
  const identity = { schema: 1, repository: 'example/templates', pullRequest: 7, expectedHead: merged, expectedTree: tree,
    baseHead: f.base, preparedHead: prepared, preparedTree: tree, version }
  const pr = { number: 7, state: 'closed', merged: true, merge_commit_sha: merged,
    base: { ref: 'master', sha: f.base, repo: { full_name: identity.repository } },
    head: { sha: prepared, repo: { full_name: identity.repository } } }
  const path = join(f.root, 'tmp', 'identity.json'), prPath = join(f.dir, 'pr.json')
  mkdirSync(join(f.root, 'tmp')); writeFileSync(path, JSON.stringify(identity)); writeFileSync(prPath, JSON.stringify(pr))
  // Per-fixture URL rewrite keeps every Git transport local while preserving the declared repository identity.
  f.git('remote', 'set-url', 'github', 'https://github.com/example/templates.git')
  f.git('config', 'url.' + f.remote + '.insteadOf', 'https://github.com/example/templates.git')
  const flags = { RELEASE_FIXTURE_IDENTITY: path, RELEASE_FIXTURE_PR: prPath }
  const save = () => { writeFileSync(path, JSON.stringify(identity)); writeFileSync(prPath, JSON.stringify(pr)) }
  return { ...f, identity, pr, path, prPath, flags, save, merged, prepared, tree }
}

test('merged-prepared opt-in verifies pinned PR graph and preserves the merge through the entire offline release', t => {
  const f = mergedFixture(t), r = f.run(f.flags)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), f.merged)
  assert.equal(f.git('rev-parse', 'v1.1.0^{commit}'), f.merged)
  assert.equal(f.pubs().length, 2)
  assert.ok(f.calls().filter(c => c.tool === 'gh' && c.args[0] === 'api').length >= 4)
})
test('merged-prepared dryrun verifies but never commits publishes pushes or tags', t => {
  const f = mergedFixture(t), before = remoteMaster(f), r = f.run({ ...f.flags, DRYRUN: '1' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(f.pubs().length, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), before); assert.equal(remoteMaster(f), before)
  assert.equal(f.git('tag'), '')
})
test('merge without explicit pinned identity still fails the original exact title gate', t => {
  const f = mergedFixture(t), r = f.run({ DRYRUN: '1' })
  assert.equal(r.status, 2); assert.match(r.stderr, /exact current-version release commit and subject/)
  assert.equal(f.calls().length, 0)
})
for (const [name, mutate] of [
  ['head', (f: ReturnType<typeof mergedFixture>) => { f.identity.expectedHead = f.base }],
  ['tree', (f: ReturnType<typeof mergedFixture>) => { f.identity.expectedTree = f.base }],
  ['prepared tree', (f: ReturnType<typeof mergedFixture>) => { f.identity.preparedTree = f.base }],
  ['base parent', (f: ReturnType<typeof mergedFixture>) => { f.identity.baseHead = f.prepared }],
  ['version', (f: ReturnType<typeof mergedFixture>) => { f.identity.version = '2.0.0' }],
  ['PR number', (f: ReturnType<typeof mergedFixture>) => { f.pr.number = 8 }],
  ['PR target branch', (f: ReturnType<typeof mergedFixture>) => { f.pr.base.ref = 'feature' }],
  ['short object id', (f: ReturnType<typeof mergedFixture>) => { f.identity.expectedHead = f.merged.slice(0, 12) }],
  ['PR not merged', (f: ReturnType<typeof mergedFixture>) => { f.pr.merged = false }],
  ['PR head', (f: ReturnType<typeof mergedFixture>) => { f.pr.head.sha = f.base }],
  ['PR repository', (f: ReturnType<typeof mergedFixture>) => { f.pr.base.repo.full_name = 'other/repo' }],
  ['PR merge', (f: ReturnType<typeof mergedFixture>) => { f.pr.merge_commit_sha = f.base }],
  ['PR base', (f: ReturnType<typeof mergedFixture>) => { f.pr.base.sha = f.prepared }],
] as const) test('rejects merged-prepared wrong ' + name + ' before verify/publish', t => {
  const f = mergedFixture(t); mutate(f); f.save()
  const r = f.run({ ...f.flags, DRYRUN: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.pubs().length, 0)
  assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
})
for (const kind of ['foreign', 'dependency', 'swapped', 'three']) test('rejects merged-prepared ' + kind + ' graph/material before verification', t => {
  const f = mergedFixture(t, kind), r = f.run({ ...f.flags, DRYRUN: '1' })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
  assert.equal(f.pubs().length, 0)
})
for (const drift of ['head', 'remote', 'file', 'tag']) test('merged-prepared stops ' + drift + ' drift during verify before publish', t => {
  const f = mergedFixture(t), r = f.run({ ...f.flags, RELEASE_FIXTURE_MUTATE: drift })
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(f.pubs().length, 0)
})
test('merged-prepared API failure is closed before verification', t => {
  const f = mergedFixture(t), r = f.run({ ...f.flags, RELEASE_FIXTURE_PR_EXIT: '1' })
  assert.equal(r.status, 2); assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
})
test('merged-prepared rejects dirty allowed inputs and conflicting tags before verify', t => {
  const f = mergedFixture(t); writeFileSync(join(f.root, 'docs/release-notes-1.1.0.md'), 'changed notes')
  assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  f.git('restore', 'docs/release-notes-1.1.0.md'); f.git('tag', 'v1.1.0', f.base)
  assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
})

test('merged-prepared missing/extra identity fields and malformed API fail closed', t => {
  const f = mergedFixture(t)
  writeFileSync(f.path, JSON.stringify({ ...f.identity, skip: true }))
  assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  writeFileSync(f.path, JSON.stringify({ schema: 1 })); assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  f.save(); writeFileSync(f.prPath, 'not-json'); assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
})
test('merged-prepared a real but unrelated single-parent commit cannot opt in', t => {
  const f = mergedFixture(t)
  f.git('reset', '--hard', f.prepared); f.git('push', '-q', '--force', 'github', 'master')
  f.identity.expectedHead = f.prepared; f.save()
  assert.equal(f.run({ ...f.flags, DRYRUN: '1' }).status, 2)
  assert.equal(f.calls().some(c => c.tool === 'pnpm'), false)
})
