/** release.sh preflight/scratch helper. Usage is internal to release.sh; never publishes, tags, fetches or changes Git configuration. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

function fail(message) { throw new Error(message) }
function git(args, missing = false) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (r.error) fail(r.error.message)
  if (missing && r.status === 1) return null
  if (r.status !== 0) fail('git ' + args[0] + ' failed: ' + r.stderr.trim())
  return r.stdout
}
function root() {
  const project = realpathSync(git(['rev-parse', '--show-toplevel']).trim())
  if (realpathSync('.') !== project) fail('run the release guard from the project root')
  return project
}
function master() {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true)?.trim()
  if (branch !== 'master') fail('release requires the current master branch (not a feature branch or detached HEAD)')
}
function regularFile(path) {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) fail('release input must be a regular file: ' + path)
  return readFileSync(path)
}
function regularDirectory(path, create = false) {
  let entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry && create) { mkdirSync(path); entry = lstatSync(path) }
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory() || resolve(realpathSync(path)) !== resolve(path)) {
    fail('release directory is absent, linked or redirected: ' + path)
  }
}
function packageAt(revision) { return JSON.parse(git(['show', revision + ':package.json'])) }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function versionOnly(before, current) {
  if (before.version === current.version) fail('release must change the package version')
  const old = { ...before }; const next = { ...current }
  delete old.version; delete next.version
  if (!isDeepStrictEqual(old, next)) fail('release package.json may change the version only; land other changes first')
}
function dirtyPaths() {
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
  return entries.map(row => {
    if (row[0] === 'R' || row[1] === 'R' || row[0] === 'C' || row[1] === 'C' || row.includes('\n')) fail('renamed/copied/ambiguous release input')
    if (!/^[ MA?][ MA?] /.test(row)) fail('deleted, conflicted or unsupported release input: ' + row)
    return row.slice(3)
  })
}
function tagState(version, expected) {
  const ref = 'refs/tags/v' + version
  const local = git(['show-ref', '--verify', '--quiet', ref], true) !== null
  const localTarget = local ? git(['rev-parse', ref + '^{commit}']).trim() : null
  const listing = git(['ls-remote', '--tags', 'github', ref, ref + '^{}'])
  const remoteRefs = new Map()
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2 || !/^[a-f0-9]{40,64}$/.test(parts[0]) || ![ref, ref + '^{}'].includes(parts[1])) fail('unexpected remote tag identity')
    remoteRefs.set(parts[1], parts[0])
  }
  const remoteTarget = remoteRefs.get(ref + '^{}') ?? remoteRefs.get(ref) ?? null
  if ((local || remoteTarget) && expected === null) fail('new release material cannot reuse an existing version tag')
  if (localTarget !== null && localTarget !== expected) fail('local version tag points to a different commit')
  if (remoteTarget !== null && remoteTarget !== expected) fail('remote version tag points to a different commit')
  return { local, remote: remoteTarget !== null }
}
// This is an explicit, pinned identity, not permission to accept arbitrary merges.
function mergeIdentityFile(path) { return JSON.parse(regularFile(resolve(path)).toString('utf8')) }
function verifiedMerge(identity, head, remote, pkg, notes) {
  const keys = ['schema', 'repository', 'pullRequest', 'expectedHead', 'expectedTree', 'baseHead', 'preparedHead', 'preparedTree', 'version']
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !isDeepStrictEqual(Object.keys(identity).sort(), [...keys].sort()) || identity.schema !== 1 ||
      typeof identity.repository !== 'string' || !new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$').test(identity.repository) ||
      !Number.isSafeInteger(identity.pullRequest) || identity.pullRequest <= 0 ||
      keys.slice(3, 8).some(key => typeof identity[key] !== 'string' || !/^[a-f0-9]{40}$/.test(identity[key]))) fail('invalid merged-prepared identity: exact repository, PR and full object ids required')
  if (identity.version !== pkg.version) fail('merged-prepared version differs from pinned release version')
  const remoteUrl = git(['config', '--get', 'remote.github.url']).trim()
  if (![ 'https://github.com/' + identity.repository + '.git', 'https://github.com/' + identity.repository,
    'git@github.com:' + identity.repository + '.git', 'ssh://git@github.com/' + identity.repository + '.git' ].includes(remoteUrl)) fail('merged-prepared repository differs from github remote')
  if (head !== identity.expectedHead || remote !== identity.expectedHead) fail('merged-prepared HEAD must equal pinned current remote master')
  const tree = git(['rev-parse', head + '^{tree}']).trim()
  if (tree !== identity.expectedTree) fail('merged-prepared merge tree differs from pinned tree')
  const parents = git(['rev-list', '--parents', '-n', '1', head]).trim().split(/\s+/)
  if (parents.length !== 3 || parents[1] !== identity.baseHead || parents[2] !== identity.preparedHead) fail('merged-prepared requires the exact two ordered parents')
  const preparedParents = git(['rev-list', '--parents', '-n', '1', identity.preparedHead]).trim().split(/\s+/)
  if (preparedParents.length !== 2 || preparedParents[1] !== identity.baseHead) fail('prepared release must be one commit directly on the pinned first parent')
  if (git(['rev-parse', identity.preparedHead + '^{tree}']).trim() !== identity.preparedTree || tree !== identity.preparedTree) fail('prepared PR tree and merge result must be identical')
  const changes = git(['diff', '--name-status', '-z', identity.baseHead, head, '--']).split('\0').filter(Boolean)
  if (!isDeepStrictEqual(changes, ['A', notes, 'M', 'package.json'])) fail('merged-prepared diff must be only the version bump and new current-version notes')
  const priorPackage = git(['ls-tree', identity.baseHead, '--', 'package.json']).trim().split(' ')[0]
  const releaseFiles = git(['ls-tree', head, '--', notes, 'package.json']).trim().split('\n')
  if (priorPackage !== '100644' || releaseFiles.length !== 2 || releaseFiles.some(row => !row.startsWith('100644 blob '))) fail('merged-prepared inputs must retain regular non-executable file modes')
  versionOnly(packageAt(identity.baseHead), pkg)
  const pr = spawnSync('bash', ['-c', 'exec gh "$@"', 'release-pr', 'api', 'repos/' + identity.repository + '/pulls/' + identity.pullRequest], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  })
  if (pr.error || pr.status !== 0) fail('cannot verify prepared PR with GitHub API')
  let record
  try { record = JSON.parse(pr.stdout) } catch { fail('invalid prepared PR response') }
  if (record.number !== identity.pullRequest || record.state !== 'closed' || record.merged !== true ||
      record.merge_commit_sha !== head || record.base?.ref !== 'master' || record.base?.sha !== identity.baseHead ||
      record.base?.repo?.full_name !== identity.repository || record.head?.repo?.full_name !== identity.repository ||
      record.head?.sha !== identity.preparedHead) fail('prepared PR does not match the pinned merged release identity')
  return { ...identity }
}
function inspect(subject, mergeIdentity) {
  const project = root(); master()
  if (typeof subject !== 'string' || subject.trim() === '' || subject !== subject.trim() || /[\r\n\0]/.test(subject)) fail('release subject must be one non-empty line without leading/trailing whitespace')
  const packageBytes = regularFile(join(project, 'package.json'))
  const pkg = JSON.parse(packageBytes)
  if (pkg.name !== '@nelsonlongxiang/dsh-prompt-templates') fail('wrong package identity')
  const version = pkg.version
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) fail('unsafe or invalid version')
  const notes = 'docs/release-notes-' + version + '.md'
  regularDirectory(join(project, 'docs'))
  const noteBytes = regularFile(join(project, notes))
  if (noteBytes.toString('utf8').trim() === '') fail('release notes must not be empty')
  const head = git(['rev-parse', 'HEAD']).trim()
  const remoteLine = git(['ls-remote', '--heads', 'github', 'refs/heads/master']).trim().split(/\s+/)
  if (remoteLine.length !== 2 || remoteLine[1] !== 'refs/heads/master' || !/^[a-f0-9]{40,64}$/.test(remoteLine[0])) fail('remote master identity is absent or ambiguous')
  const remote = remoteLine[0]
  const paths = dirtyPaths()
  const allowed = new Set(['package.json', notes])
  if (paths.some(path => !allowed.has(path))) fail('foreign working-tree or staged changes; only this version package.json and notes are allowed')
  const title = 'chore(release): ' + version + ' — ' + subject
  const headTitle = git(['log', '-1', '--format=%s']).trimEnd()
  let mode
  let verifiedIdentity
  if (mergeIdentity !== undefined) {
    if (paths.length !== 0) fail('merged-prepared release requires a clean worktree and index')
    verifiedIdentity = verifiedMerge(mergeIdentity, head, remote, pkg, notes)
    mode = 'merged-prepared'
  } else if (paths.length > 0) {
    mode = 'new'
    if (head !== remote) fail('new release material requires master to equal remote github/master')
    if (new Set(paths).size !== 2 || !paths.includes('package.json') || !paths.includes(notes)) fail('new release requires both the version bump and its notes')
    if (headTitle === title) fail('current release commit exists but release inputs are still dirty')
    versionOnly(packageAt('HEAD'), pkg)
  } else {
    mode = 'resume'
    if (headTitle !== title) fail('clean release must be the exact current-version release commit and subject')
    const parents = git(['rev-list', '--parents', '-n', '1', head]).trim().split(/\s+/)
    if (parents.length !== 2) fail('release commit must have exactly one parent')
    if (head !== remote && parents[1] !== remote) fail('unpublished history contains changes beyond the one exact release commit')
    const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head]).split('\0').filter(Boolean)
    if (changed.length !== 2 || changed.some(path => !allowed.has(path))) fail('release commit must contain only the version bump and its notes')
    versionOnly(packageAt(parents[1]), pkg)
  }
  const tags = tagState(version, mode !== 'new' ? head : null)
  const indexSha256 = hash(git(['ls-files', '--stage', '-z', '--', 'package.json', notes]))
  const packageBlob = git(['hash-object', '--path=package.json', 'package.json']).trim()
  const notesBlob = git(['hash-object', '--path=' + notes, notes]).trim()
  return { root: project, head, remote, version, notes, title, subject, mode, ...(verifiedIdentity ? { mergeIdentity: verifiedIdentity } : {}), packageSha256: hash(packageBytes), notesSha256: hash(noteBytes), packageBlob, notesBlob, indexSha256, tags }
}
function unchanged(plan) {
  const next = inspect(plan.subject, plan.mergeIdentity)
  if (!isDeepStrictEqual(next, plan)) fail('release identity or inputs changed during verification; nothing may be published')
  return next
}
function staged(plan) {
  const next = inspect(plan.subject, plan.mergeIdentity)
  if (plan.mode !== 'new' || next.mode !== 'new') fail('only fresh release material can be staged')
  const { indexSha256: priorIndex, ...prior } = plan
  const { indexSha256: currentIndex, ...current } = next
  if (!isDeepStrictEqual(prior, current)) fail('verified release identity or worktree changed before commit')
  const paths = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
  if (paths.length !== 2 || !paths.includes('package.json') || !paths.includes(plan.notes)) fail('staged paths differ from this release; preserve staging and stop')
  for (const [path, expected] of [['package.json', plan.packageBlob], [plan.notes, plan.notesBlob]]) {
    // Git clean filters/CRLF normalization define the committed blob; raw
    // working-file hashes above independently detect verification-time drift.
    if (git(['rev-parse', ':' + path]).trim() !== expected) fail('staged release blob differs from the verified file')
  }
}
function finalized(plan) {
  const next = inspect(plan.subject, plan.mergeIdentity)
  if (!['resume', 'merged-prepared'].includes(next.mode) || next.version !== plan.version || next.packageSha256 !== plan.packageSha256 || next.notesSha256 !== plan.notesSha256) fail('release commit does not match the verified inputs')
  if (plan.mode !== 'new' && next.head !== plan.head) fail('verified release HEAD changed')
  if (plan.mode === 'merged-prepared') {
    // Expected local/remote tags may be added after publication; their targets
    // are revalidated by inspect. Everything else must remain pinned.
    const { tags: oldTags, ...before } = plan
    const { tags: newTags, ...after } = next
    if (!isDeepStrictEqual(before, after)) fail('verified merged release identity changed')
  }
  if (plan.mode === 'new' && git(['rev-parse', 'HEAD^']).trim() !== plan.head) fail('release commit does not extend the verified HEAD')
  return next
}
function scratch(create, supplied) {
  const project = root()
  const parent = join(project, 'tmp', 'release')
  if (create && git(['check-ignore', '--quiet', '--', 'tmp/release/owned-probe'], true) === null) fail('project release scratch must be ignored')
  regularDirectory(dirname(parent), create); regularDirectory(parent, create)
  if (create) {
    const path = mkdtempSync(join(parent, 'run-'))
    writeFileSync(join(path, '.release-owner.json'), JSON.stringify({ project, path }))
    return relative(project, path).split('\\').join('/')
  }
  const parts = (supplied ?? '').split('/')
  if (parts.length !== 3 || parts[0] !== 'tmp' || parts[1] !== 'release' || !/^run-[A-Za-z0-9]+$/.test(parts[2])) fail('refusing cleanup of a path not allocated for this release')
  const path = resolve(project, supplied)
  regularDirectory(path)
  const owner = JSON.parse(regularFile(join(path, '.release-owner.json')))
  if (owner.project !== project || owner.path !== path || dirname(path) !== parent) fail('release scratch ownership mismatch; preserve it for inspection')
  rmSync(path, { recursive: true })
}

try {
  const [action, value, key] = process.argv.slice(2)
  if (action === 'master') { root(); master() }
  else if (action === 'inspect') console.log(JSON.stringify(inspect(value, key === undefined ? undefined : mergeIdentityFile(key))))
  else if (action === 'assert') unchanged(JSON.parse(value))
  else if (action === 'staged') staged(JSON.parse(value))
  else if (action === 'finalize') console.log(JSON.stringify(finalized(JSON.parse(value))))
  else if (action === 'field') {
    const plan = JSON.parse(value)
    if (key === 'remote-tag') console.log(plan.tags.remote ? '1' : '0')
    else {
      if (!['version', 'notes', 'title', 'mode', 'head'].includes(key) || typeof plan[key] !== 'string') fail('invalid release plan field')
      console.log(plan[key])
    }
  } else if (action === 'scratch-create') console.log(scratch(true))
  else if (action === 'scratch-remove') scratch(false, value)
  else fail('unknown release guard command')
} catch (error) {
  console.error('release guard: ' + error.message)
  process.exitCode = 2
}
