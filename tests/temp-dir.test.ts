/** The scratch helper is copied only into synthetic fixture roots, never a clone or alternate project checkout. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createTestDirectory } from './temp-dir.mjs'

const helperSource = new URL('./temp-dir.mjs', import.meta.url)

async function fixture(t: { after(fn: () => void): void }) {
  const dir = createTestDirectory('scratch-boundary-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = join(dir, 'synthetic-project')
  const tests = join(project, 'tests')
  mkdirSync(tests, { recursive: true })
  const helper = join(tests, 'temp-dir.mjs')
  copyFileSync(helperSource, helper)
  const module = await import(pathToFileURL(helper).href)
  return { dir, project, create: module.createTestDirectory as (prefix: string) => string }
}

test('scratch entry creates only owned paths and rejects invalid prefix before creating anything', async t => {
  const f = await fixture(t)
  for (const prefix of ['', '../escape-', '/absolute-', 'C:drive-', 'space name-', 'x/y-']) {
    assert.throws(() => f.create(prefix), /invalid test directory prefix/)
  }
  assert.equal(existsSync(join(f.project, 'tmp')), false)
  const first = f.create('case-')
  const second = f.create('case-')
  assert.notEqual(first, second)
  assert.equal(first.startsWith(join(f.project, 'tmp', 'test-runs', 'case-')), true)
})

for (const level of ['tmp', 'test-runs'] as const) {
  for (const dangling of [false, true]) {
    test('scratch entry refuses ' + level + ' junction/symlink before writing (dangling=' + dangling + ')', async t => {
      const f = await fixture(t)
      const target = join(f.dir, dangling ? 'absent-target' : 'outside-fixture-project')
      if (!dangling) mkdirSync(target)
      const link = level === 'tmp' ? join(f.project, 'tmp') : join(f.project, 'tmp', 'test-runs')
      if (level === 'test-runs') mkdirSync(join(f.project, 'tmp'))
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => f.create('case-'), /scratch.*(link|redirect|directory)/)
      assert.equal(existsSync(target), !dangling, 'a dangling link must not cause an outside directory to be created')
      if (!dangling) assert.deepEqual(readdirSync(target), [], 'linked target remains untouched')
    })
  }
}
