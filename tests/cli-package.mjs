import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scratch = mkdtempSync(join(tmpdir(), 'pt-cli-package-'))
try {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(packed.status, 0, packed.stderr)
  const manifest = JSON.parse(packed.stdout)
  const tarball = resolve(scratch, manifest[0].filename)
  const prefix = join(scratch, 'install')
  const installed = spawnSync('npm', ['install', tarball, '--ignore-scripts', '--no-package-lock', '--omit=optional', '--prefix', prefix], { encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(installed.status, 0, installed.stderr)
  const packageJson = JSON.parse(readFileSync(join(prefix, 'node_modules', '@nelsonlongxiang', 'dsh-prompt-templates', 'package.json'), 'utf8'))
  assert.equal(packageJson.version, '0.5.1')
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
