/**
 * Bootstrap the package-local Python backend venv with `uv sync`.
 *
 * Idempotent: an existing `python/.venv` is only synced, never rebuilt from
 * scratch, and no user data under `$DSH_HOME` is touched. Requires `uv` on
 * PATH; a missing `uv` fails with a clear diagnostic instead of a broken
 * install.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pythonProject = join(pkgRoot, 'python')

if (!existsSync(join(pythonProject, 'pyproject.toml'))) {
  console.error(`dsh-prompt-templates: python/pyproject.toml missing at ${pythonProject}`)
  process.exit(1)
}

const result = spawnSync('uv', ['sync', '--project', pythonProject], {
  stdio: 'inherit',
  env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(pythonProject, '.venv'), PYTHONDONTWRITEBYTECODE: '1' },
})

if (result.error !== undefined) {
  console.error(
    'dsh-prompt-templates: `uv` is required to bootstrap the Python backend '
    + '(https://docs.astral.sh/uv/). Install uv, then rerun '
    + '`node scripts/bootstrap.mjs`.',
  )
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
