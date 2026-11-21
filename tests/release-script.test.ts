/**
 * Guard for tests/release-script.suite.ts (#31): on Windows the `bash` that first resolves on PATH may be
 * WSL bash, which strips Windows env vars (RELEASE_FIXTURE_STUBS arrives empty → every fixture dies with
 * `cd "": No such file or directory`). Probe once: the suite needs a POSIX bash that is MSYS/Cygwin-flavoured
 * AND passes Windows env through. Git Bash satisfies both. Otherwise skip the whole suite with one clear
 * line instead of 40 cryptic failures; run `pnpm verify` from Git Bash on Windows.
 */
import test from 'node:test'
import { spawnSync } from 'node:child_process'

// The guard applies on Windows only: on Linux/macOS (CI included) `uname -s` is Linux/Darwin and the
// suite must always run — skipping there would silently drop the release regressions from CI.
const onWindows = process.platform === 'win32'
const probe = onWindows
  ? spawnSync('bash', ['-c', 'uname -s; printf %s "${RELEASE_FIXTURE_ENV_PROBE:-}"'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, RELEASE_FIXTURE_ENV_PROBE: 'pass-through' },
  })
  : undefined
const banner = (probe?.stdout?.split('\n')[0] ?? '').trim()
const usable = !onWindows || (probe?.status === 0 && /MINGW|MSYS|CYGWIN/.test(banner) && (probe?.stdout ?? '').includes('pass-through'))

if (usable) {
  await import('./release-script.suite.ts')
} else {
  const reason = `offline release suite needs Git Bash (MSYS/Cygwin) with Windows env passthrough; this shell resolves bash to: ${banner || probe?.error?.message || 'unknown'} — under WSL bash, Windows env vars like RELEASE_FIXTURE_STUBS are stripped (#31). On Windows run pnpm verify from Git Bash.`
  test('release-script offline suite (bash environment guard)', { skip: reason }, () => {})
}
