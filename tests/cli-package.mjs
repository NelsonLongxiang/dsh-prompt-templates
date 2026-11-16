import { createTestDirectory } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { spawnSync } from 'node:child_process'

const expectedVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version

// `npm pack --json` still runs `prepare` on npm 10, and that script's stdout
// (the pnpm build banner) is concatenated in front of the JSON array. Parse
// the manifest object instead of assuming stdout is JSON alone.
function parsePackManifest(stdout) {
  const candidates = []
  const trimmed = stdout.trimStart()
  if (trimmed.startsWith('[')) candidates.push(trimmed)
  let from = stdout.indexOf('\n[')
  while (from !== -1) {
    candidates.push(stdout.slice(from + 1))
    from = stdout.indexOf('\n[', from + 1)
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed) && typeof parsed[0]?.filename === 'string') return parsed
    } catch { /* a lifecycle log can also contain a bracket */ }
  }
  assert.fail(`npm pack did not emit a JSON manifest\n${stdout}`)
}

// CSS integrity gate: every class declared in a src client module stylesheet
// must appear as a `"class":"<hash>_<class>"` entry in the built bundle. A
// stale css copy under lib/ once shadowed the live stylesheet, silently
// shipping months-old rules (missing classes surfaced as empty className
// strings and broken layout) — this check fails the release instead.
{
  const bundle = readFileSync(resolve('lib/client.js'), 'utf8')
  const cssDir = resolve('src/client')
  for (const file of readdirSync(cssDir).filter(name => name.endsWith('.module.css'))) {
    const source = readFileSync(join(cssDir, file), 'utf8')
    // Selector heads only (`.foo {` / `.foo:hover {`); declarations never match.
    const classes = new Set([...source.matchAll(/(?:^|\n)\s*\.([A-Za-z][A-Za-z0-9_-]*)[^{,\n]*\{/g)].map(match => match[1]))
    for (const className of classes) {
      const entry = new RegExp(`"${className}":\\s*"[A-Za-z0-9_-]+_${className}"`)
      assert.ok(
        entry.test(bundle),
        `built lib/client.js css map is missing class "${className}" from ${file} — stale stylesheet shadow?`,
      )
    }
    process.stdout.write(`css map gate: ${file} (${classes.size} classes) PASS\n`)
  }
}

// The portable page is generated after build, with no CDN, host boot, or clipboard reads.
for (const locale of ['en', 'zh']) {
  const generated = spawnSync(process.execPath, ['tests/clipboard-browser.mjs', locale], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(generated.status, 0, generated.stderr)
  const output = generated.stdout.trim()
  assert.match(output, /^file:/)
  const path = fileURLToPath(output)
  const root = resolve('tmp/test-runs')
  const child = relative(root, path)
  assert.ok(child !== '' && !isAbsolute(child) && !child.startsWith('..'), 'fixture stays in the project-owned scratch')
  assert.equal(basename(path), 'index.html')
  assert.match(basename(dirname(path)), /^clipboard-browser-[A-Za-z0-9]+$/)
  try {
    const html = readFileSync(path, 'utf8')
    assert.match(html, /id="copy-mode"/)
    assert.match(html, /id="environment-refresh"/)
    assert.doesNotMatch(html, /<script[^>]+src=/i)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    assert.equal(scripts.length, 5, 'React, ReactDOM, fixture setup, actual plugin bundle, mount')
    for (const match of scripts) new Script(match[1], { filename: 'clipboard-fixture-' + locale + '.js' })
  } finally { rmSync(dirname(path), { recursive: true, force: true }) }
}
process.stdout.write('portable clipboard fixture smoke: en/zh PASS (parse only, not browser acceptance)\n')

const scratch = createTestDirectory('pt-cli-package-')
try {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(packed.status, 0, packed.stderr)
  const manifest = parsePackManifest(packed.stdout)
  const packedPaths = new Set(manifest[0].files.map(file => file.path))
  const requiredDocs = [
    'README.md', 'README_zh.md', 'docs/spec-event-inject.md',
    'docs/event-failure-contract.md', 'docs/clipboard-verification.md', 'docs/test-plan-phase-c.md',
  ]
  for (const file of requiredDocs) assert.ok(packedPaths.has(file), 'packaged documentation missing: ' + file)
  // Walk Markdown links from the shipped reading entry points: an installed
  // README must not send users to a file omitted by package.json files.
  const seen = new Set()
  const pending = [...requiredDocs]
  while (pending.length > 0) {
    const file = pending.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(resolve(file), 'utf8')
    for (const link of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const destination = link[1].trim().replace(/^<|>$/g, '')
      if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//') || destination.startsWith('#')) continue
      const local = decodeURIComponent(destination.split(/[?#]/, 1)[0])
      if (local === '') continue
      const target = posix.normalize(posix.join(posix.dirname(file), local))
      assert.ok(!target.startsWith('../') && !posix.isAbsolute(target), 'documentation link escapes package: ' + destination)
      assert.ok(packedPaths.has(target), file + ' links to an omitted package file: ' + target)
      if (target.endsWith('.md')) pending.push(target)
    }
  }
  process.stdout.write('packaged documentation links: PASS\n')
  const tarball = resolve(scratch, manifest[0].filename)
  const prefix = join(scratch, 'install')
  const installed = spawnSync('npm', ['install', tarball, '--ignore-scripts', '--no-package-lock', '--omit=optional', '--prefix', prefix], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(installed.status, 0, installed.stderr)
  const installedRoot = join(prefix, 'node_modules', '@nelsonlongxiang', 'dsh-prompt-templates')
  for (const file of seen) {
    assert.equal(readFileSync(join(installedRoot, file), 'utf8'), readFileSync(resolve(file), 'utf8'), 'installed guide differs: ' + file)
  }
  const packageJson = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.version, expectedVersion)
  assert.equal(packageJson.bin['dsh-prompt-templates'].replace(/^\.\//, ''), 'lib/cli/main.js')
  const bin = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-prompt-templates.cmd' : 'dsh-prompt-templates')
  const result = spawnSync(bin, ['--help'], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /deterministic prompt-template database sync/)
  assert.match(result.stdout, /dsh-prompt-templates import/)
  process.stdout.write('packaged bin shim smoke: PASS\n')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
