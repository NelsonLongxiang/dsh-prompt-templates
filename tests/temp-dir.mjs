/** Project-owned scratch for test runs; no fallback to the OS temporary directory. */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const project = realpathSync(fileURLToPath(new URL('..', import.meta.url)))

export function createTestDirectory(prefix) {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error('invalid test directory prefix')
  const root = join(project, 'tmp', 'test-runs')
  // Existing junctions/symlinks must not redirect a project test outside its owner.
  for (const dir of [dirname(root), root]) {
    mkdirSync(dir, { recursive: true })
    if (resolve(realpathSync(dir)) !== resolve(dir)) throw new Error('test scratch redirects outside its declared path: ' + dir)
  }
  return mkdtempSync(join(root, prefix))
}
