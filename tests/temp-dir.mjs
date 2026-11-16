/** Project-owned scratch for test runs; no fallback to the OS temporary directory. */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const project = realpathSync(fileURLToPath(new URL('..', import.meta.url)))

export function createTestDirectory(prefix) {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error('invalid test directory prefix')
  const root = join(project, 'tmp', 'test-runs')
  // Inspect before mkdir: even a dangling junction is not an owned directory.
  // This is a workspace preflight, not an OS sandbox against concurrent path replacement.
  for (const dir of [dirname(root), root]) {
    let entry = lstatSync(dir, { throwIfNoEntry: false })
    if (entry === undefined) {
      try { mkdirSync(dir) } catch (error) {
        // Parallel test workers may create the same regular parent directory.
        if (error?.code !== 'EEXIST') throw error
      }
      entry = lstatSync(dir)
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('test scratch path is a link or not a directory: ' + dir)
    if (resolve(realpathSync(dir)) !== resolve(dir)) throw new Error('test scratch redirects outside its declared path: ' + dir)
  }
  return mkdtempSync(join(root, prefix))
}
