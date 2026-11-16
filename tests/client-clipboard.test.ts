import assert from 'node:assert/strict'
import test from 'node:test'
import { copyShareText } from '../src/client/clipboard.ts'
import type { CopyEnvironment } from '../src/client/clipboard.ts'
import { buildSharePayload } from '../src/client/share.ts'

const PAYLOAD = JSON.stringify(buildSharePayload([{
  id: 'fixture', name: '示例', content: 'line 1\nline 2 {{date}}', scope: 'global', session_id: null,
  description: null, position: 0, category: null, inject_enabled: false, inject_every: null, mode: 'inject',
  created_at: '2026-01-01', updated_at: '2026-01-01',
}]))

function fixture(options: { focused?: boolean; copy?: boolean; error?: unknown; available?: boolean } = {}) {
  const calls: string[] = []
  let field: any
  const range = { cloneRange: () => range }
  const selection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange(r: unknown) { assert.equal(r, range) } }
  const active = { selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward',
    focus() { calls.push('restore-focus') },
    setSelectionRange(...args: unknown[]) { assert.deepEqual(args, [2, 5, 'backward']); calls.push('restore-caret') },
  }
  const doc = {
    hasFocus: () => options.focused !== false,
    activeElement: active,
    getSelection: () => selection,
    body: { appendChild(element: unknown) { assert.equal(element, field); calls.push('append') } },
    createElement(name: string) {
      assert.equal(name, 'textarea')
      field = { value: '', style: {}, focus() {}, select() {},
        setSelectionRange(start: number, end: number) { assert.equal(start, 0); assert.equal(end, PAYLOAD.length) },
        remove() { calls.push('remove') },
      }
      return field
    },
    execCommand: options.available === false ? undefined : (command: string) => {
      assert.equal(command, 'copy')
      assert.equal(field.value, PAYLOAD, 'compatibility path gets identical bytes')
      calls.push('legacy')
      if (options.error) throw options.error
      return options.copy === true
    },
  }
  const env = { navigator: {}, document: doc } as unknown as CopyEnvironment
  return { env, calls, active }
}

function named(name: string) { return Object.assign(new Error('private message must not be returned'), { name }) }

test('Clipboard API success does not invoke fallback and preserves the share payload', async () => {
  const f = fixture()
  let received = ''
  const result = await copyShareText(PAYLOAD, { ...f.env, navigator: { clipboard: { async writeText(text) { received = text } } } })
  assert.deepEqual(result, { ok: true, method: 'clipboard' })
  assert.equal(received, PAYLOAD)
  assert.deepEqual(f.calls, [])
})

test('missing Clipboard API falls back synchronously and restores focus/caret', async () => {
  const f = fixture({ copy: true })
  const result = await copyShareText(PAYLOAD, f.env)
  assert.deepEqual(result, { ok: true, method: 'legacy' })
  assert.deepEqual(f.calls, ['append', 'legacy', 'remove', 'restore-focus', 'restore-caret'])
})

test('Clipboard rejection can recover through compatibility copy', async () => {
  const f = fixture({ copy: true })
  const result = await copyShareText(PAYLOAD, { ...f.env, navigator: { clipboard: { async writeText() { throw named('NotAllowedError') } } } })
  assert.equal(result.ok, true)
  assert.ok(f.calls.includes('legacy'))
})

test('missing APIs produce manual sharing with the exact original JSON', async () => {
  const f = fixture({ available: false })
  const result = await copyShareText(PAYLOAD, f.env)
  assert.deepEqual(result, { ok: false, payload: PAYLOAD, failure: { kind: 'unavailable', errorName: null }, legacyErrorName: null })
})

for (const [name, focused, kind] of [
  ['NotAllowedError', true, 'denied'], ['NotAllowedError', false, 'unfocused'],
  ['SecurityError', true, 'security'], ['AbortError', true, 'write-failed'],
] as const) {
  test('manual fallback diagnoses ' + kind + ' without claiming OS damage or dropping data', async () => {
    const f = fixture({ focused })
    const result = await copyShareText(PAYLOAD, { ...f.env, navigator: { clipboard: { async writeText() { throw named(name) } } } })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.payload, PAYLOAD)
      assert.deepEqual(result.failure, { kind, errorName: name })
      assert.equal(JSON.stringify(result).includes('private message'), false)
    }
    assert.ok(f.calls.includes('remove'))
    assert.ok(f.calls.includes('restore-caret'))
  })
}

test('legacy exception is diagnosed but never discards the payload or temporary element', async () => {
  const f = fixture({ error: named('SecurityError') })
  const result = await copyShareText(PAYLOAD, f.env)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.legacyErrorName, 'SecurityError')
    assert.equal(result.payload, PAYLOAD)
  }
  assert.ok(f.calls.includes('remove'))
})

test('contenteditable selection is restored when no input caret exists', async () => {
  const f = fixture({ copy: true })
  Object.assign(f.active, { selectionStart: undefined, selectionEnd: undefined })
  const result = await copyShareText(PAYLOAD, f.env)
  assert.deepEqual(result, { ok: true, method: 'legacy' })
  assert.ok(f.calls.includes('restore-focus'))
  assert.ok(!f.calls.includes('restore-caret'))
})

test('a detached focus target cannot turn confirmed compatibility copy into failure', async () => {
  const f = fixture({ copy: true })
  f.active.focus = () => { throw new Error('detached') }
  assert.deepEqual(await copyShareText(PAYLOAD, f.env), { ok: true, method: 'legacy' })
})

test('throwing clipboard getter still reaches the manual-copy path', async () => {
  const f = fixture({ available: false })
  const navigator = Object.defineProperty({}, 'clipboard', { get() { throw named('SecurityError') } })
  const result = await copyShareText(PAYLOAD, { ...f.env, navigator })
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual(result.failure, { kind: 'security', errorName: 'SecurityError' })
})
