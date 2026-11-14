/**
 * Event reminders, pure halves: feature extraction, redaction and the two
 * first-phase detectors. No host, no database.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson, exitCodeOf, extractFeatures, outcomeClass, redact, shellCommandOf, splitShellPreparation, SUMMARY_MAX,
} from '../src/event-features.ts'
import {
  detect, detectRepeatedFailure, detectRepeatedPreparation, looksChanged, RULE_REPEATED_FAILURE, RULE_REPEATED_PREPARATION,
} from '../src/event-detect.ts'
import type { ObservationView } from '../src/event-detect.ts'

const OK = { isError: false }
const FAIL = (code?: string) => ({ isError: true, error: { info: code === undefined ? undefined : { code } } })

test('shell preparation prefix: env assignments, absolute interpreter and its flags', () => {
  assert.deepEqual(splitShellPreparation('PYTHONUTF8=1 PYTHONIOENCODING=utf-8 /opt/venv/bin/python -X utf8 tools/run.py --day 1'), {
    prefix: ['PYTHONUTF8=1', 'PYTHONIOENCODING=utf-8', '/opt/venv/bin/python', '-X'],
    task: ['utf8', 'tools/run.py', '--day', '1'],
  })
  assert.deepEqual(splitShellPreparation('C:\\Python311\\python.exe -u job.py').prefix, ['C:\\Python311\\python.exe', '-u'])
  assert.deepEqual(splitShellPreparation('FOO=1 make build'), { prefix: ['FOO=1'], task: ['make', 'build'] })
  // An ordinary command is not manual preparation.
  assert.deepEqual(splitShellPreparation('git status'), { prefix: [], task: ['git', 'status'] })
  assert.deepEqual(splitShellPreparation('python3 x.py').prefix, [])
  // Quoted spans stay one token.
  assert.deepEqual(splitShellPreparation('A="x y" /bin/sh -c "echo hi"').prefix, ['A="x y"', '/bin/sh', '-c'])
})

test('shell command is read from command/cmd/script fields only', () => {
  assert.equal(shellCommandOf({ command: 'ls' }), 'ls')
  assert.equal(shellCommandOf({ cmd: ['git', 'log'] }), 'git log')
  assert.equal(shellCommandOf({ script: '  ' }), null)
  assert.equal(shellCommandOf({ path: 'a.txt' }), null)
  assert.equal(shellCommandOf('ls'), null)
  assert.equal(shellCommandOf(null), null)
})

test('redaction masks credentials but keeps interpreter paths readable', () => {
  const masked = redact('curl -H "Authorization: Bearer abc.def" https://u:pw@host/x --token=s3cr3t API_KEY=xyz ' + 'a'.repeat(40))
  assert.ok(!masked.includes('abc.def'))
  assert.ok(!masked.includes('u:pw@'))
  assert.ok(!masked.includes('s3cr3t'))
  assert.ok(!masked.includes('=xyz'))
  assert.ok(!masked.includes('a'.repeat(40)))
  assert.ok(masked.includes('‹redacted›'))
  const path = '/home/someone/projects/very-long-project-name/.venv/bin/python3.11'
  assert.equal(redact(path), path)
})

test('features never keep assignment values and clip the summary', () => {
  const features = extractFeatures('bash', { command: 'SECRET_TOKEN=abcdef /usr/bin/python run.py' }, OK)
  assert.ok(!features.summary.includes('abcdef'))
  assert.ok(features.summary.startsWith('SECRET_TOKEN=… /usr/bin/python'))
  assert.notEqual(features.stableFingerprint, '')
  const long = extractFeatures('read', { path: 'x'.repeat(500) }, OK)
  assert.equal(long.stableFingerprint, '')
  assert.ok(long.summary.length <= SUMMARY_MAX)
})

test('fingerprints: same prefix shares stable, different task changes target', () => {
  const a = extractFeatures('bash', { command: 'X=1 /bin/python a.py' }, OK)
  const b = extractFeatures('bash', { command: 'X=1 /bin/python b.py' }, OK)
  const c = extractFeatures('bash', { command: 'X=2 /bin/python a.py' }, OK)
  assert.equal(a.stableFingerprint, b.stableFingerprint)
  assert.notEqual(a.targetFingerprint, b.targetFingerprint)
  assert.notEqual(a.stableFingerprint, c.stableFingerprint)
  // Key order does not change a non-shell target.
  assert.equal(extractFeatures('t', { a: 1, b: 2 }, OK).targetFingerprint, extractFeatures('t', { b: 2, a: 1 }, OK).targetFingerprint)
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}')
})

test('outcome classes come from structured fields only', () => {
  assert.equal(outcomeClass(OK), 'ok')
  assert.equal(outcomeClass(FAIL('ENOENT')), 'error:ENOENT')
  assert.equal(outcomeClass(FAIL()), 'error:unknown')
  assert.equal(exitCodeOf({ exitCode: 2 }), 2)
  assert.equal(exitCodeOf({ exitCode: '2' }), null)
  assert.equal(exitCodeOf([1]), null)
  // Output text never decides the outcome.
  const textual = extractFeatures('bash', { command: 'make' }, { isError: false, meta: { stdout: 'ERROR failed' } } as never)
  assert.equal(textual.outcome, 'ok')
})

let seq = 0
function obs(over: Partial<ObservationView>): ObservationView {
  seq += 1
  return {
    seq, call_id: `c${seq}`, tool_name: 'bash', is_ptc_subcall: false, stable_fingerprint: 'S',
    target_fingerprint: `T${seq}`, outcome: 'ok', exit_code: null, summary: 's', ...over,
  }
}
const prepPolicy = { rule_id: RULE_REPEATED_PREPARATION, rule_version: 1, threshold: 3, window_size: 50 } as const
const failPolicy = { rule_id: RULE_REPEATED_FAILURE, rule_version: 1, threshold: 2, window_size: 50 } as const

test('repeated preparation fires at the threshold with differing task parts only', () => {
  const two = [obs({}), obs({})]
  assert.equal(detectRepeatedPreparation(two, two[1] as ObservationView, prepPolicy), null)
  const three = [...two, obs({})]
  const hit = detectRepeatedPreparation(three, three[2] as ObservationView, prepPolicy)
  assert.ok(hit)
  assert.equal(hit.key, 'prep:S')
  assert.equal(hit.evidence_count, 3)
  assert.deepEqual(hit.evidence_refs, three.map(row => row.call_id))
  // An identical re-run (same target) is a retry, not repeated preparation.
  const same = [obs({ target_fingerprint: 'T' }), obs({ target_fingerprint: 'T' }), obs({ target_fingerprint: 'T' })]
  assert.equal(detectRepeatedPreparation(same, same[2] as ObservationView, prepPolicy), null)
  // No prefix → nothing to detect.
  const plain = [obs({ stable_fingerprint: '' }), obs({ stable_fingerprint: '' }), obs({ stable_fingerprint: '' })]
  assert.equal(detect(plain, plain[2] as ObservationView, prepPolicy), null)
})

test('repeated failure fires on the threshold or on a regression after success', () => {
  const a = obs({ target_fingerprint: 'X', outcome: 'error:E1' })
  assert.equal(detectRepeatedFailure([a], a, failPolicy), null)
  const b = obs({ target_fingerprint: 'X', outcome: 'error:E1' })
  const hit = detectRepeatedFailure([a, b], b, failPolicy)
  assert.ok(hit)
  assert.equal(hit.evidence_count, 2)
  // A different failure class of the same target is a different problem key.
  const c = obs({ target_fingerprint: 'X', outcome: 'error:E2' })
  assert.equal(detectRepeatedFailure([a, c], c, failPolicy), null)
  // fail → ok → fail recurs even below the threshold.
  const strict = { ...failPolicy, threshold: 5 }
  const f1 = obs({ target_fingerprint: 'Y', outcome: 'error:E' })
  const ok = obs({ target_fingerprint: 'Y', outcome: 'ok' })
  const f2 = obs({ target_fingerprint: 'Y', outcome: 'error:E' })
  assert.ok(detectRepeatedFailure([f1, ok, f2], f2, strict))
  assert.equal(detectRepeatedFailure([ok, f2], f2, strict), null)
  // Successes never trigger.
  assert.equal(detect([ok], ok, failPolicy), null)
})

test('looksChanged is a hint for notified episodes', () => {
  const prep = { rule_id: RULE_REPEATED_PREPARATION, key: 'prep:S', tool_name: 'bash', target_fingerprint: 'T' } as const
  assert.equal(looksChanged(prep, obs({ stable_fingerprint: '' })), true)
  assert.equal(looksChanged(prep, obs({ stable_fingerprint: 'S' })), false)
  assert.equal(looksChanged(prep, obs({ tool_name: 'read', stable_fingerprint: '' })), false)
  const fail = { rule_id: RULE_REPEATED_FAILURE, key: 'fail:k', tool_name: 'bash', target_fingerprint: 'X' } as const
  assert.equal(looksChanged(fail, obs({ target_fingerprint: 'X', outcome: 'ok' })), true)
  assert.equal(looksChanged(fail, obs({ target_fingerprint: 'X', outcome: 'error:E' })), false)
})
