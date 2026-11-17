/** Offline command doubles used only by release-script.test.ts; never contacts a registry. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const [tool, ...args] = process.argv.slice(2)
const root = process.env.RELEASE_FIXTURE_ROOT
if (!root || !process.env.RELEASE_FIXTURE_TRACE) throw new Error('fixture context required')
appendFileSync(process.env.RELEASE_FIXTURE_TRACE, JSON.stringify({ tool, args, cwd: process.cwd() }) + '\n')
if (tool === 'pnpm') {
  if (process.env.RELEASE_FIXTURE_MUTATE === 'file') writeFileSync(join(root, 'unrelated.txt'), 'unexpected change')
  if (process.env.RELEASE_FIXTURE_MUTATE === 'head') {
    const result = spawnSync('git', ['commit', '--allow-empty', '-m', 'unexpected concurrent commit'], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  if (process.env.RELEASE_FIXTURE_MUTATE === 'index') {
    const r = spawnSync('git', ['add', 'package.json'], { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  if (process.env.RELEASE_FIXTURE_MUTATE === 'tag') {
    const r = spawnSync('git', ['tag', 'v1.1.0', 'HEAD'], { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  if (process.env.RELEASE_FIXTURE_MUTATE === 'remote') {
    const r = spawnSync('git', ['push', 'github', 'HEAD^:refs/heads/master', '--force'], { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  process.exit(Number(process.env.RELEASE_FIXTURE_VERIFY_EXIT ?? 0))
}
if (tool === 'npm' && args[0] === 'publish') process.exit(Number(process.env.RELEASE_FIXTURE_PUBLISH_EXIT ?? 0))
if (tool === 'npm' && args[0] === 'pack') {
  if (process.env.RELEASE_FIXTURE_PACK_EXIT) process.exit(Number(process.env.RELEASE_FIXTURE_PACK_EXIT))
  const pkg = join('fixture-content', 'package')
  mkdirSync(join(pkg, 'lib', 'cli'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  writeFileSync(join(pkg, 'lib', 'client.js'), 'synthetic')
  writeFileSync(join(pkg, 'lib', 'cli', 'main.js'), 'synthetic')
  const result = spawnSync('tar', ['-czf', 'fixture.tgz', '-C', 'fixture-content', 'package'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  console.log('fixture.tgz')
}
if (tool === 'npm' && args[0] === 'view') console.log('1.1.0')
if (tool === 'curl') process.stdout.write('200')
if (tool === 'gh' && args[0] === 'release' && args[1] === 'view') process.exit(1)
