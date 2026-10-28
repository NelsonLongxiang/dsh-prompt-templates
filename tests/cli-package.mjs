import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const scratch = mkdtempSync(join(tmpdir(), 'pt-cli-package-'))
try {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(packed.status, 0, packed.stderr)
  const manifest = parsePackManifest(packed.stdout)
  const tarball = resolve(scratch, manifest[0].filename)
  const prefix = join(scratch, 'install')
  const installed = spawnSync('npm', ['install', tarball, '--ignore-scripts', '--no-package-lock', '--omit=optional', '--prefix', prefix], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(installed.status, 0, installed.stderr)
  const packageJson = JSON.parse(readFileSync(join(prefix, 'node_modules', '@nelsonlongxiang', 'dsh-prompt-templates', 'package.json'), 'utf8'))
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
