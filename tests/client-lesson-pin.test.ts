/** The panel's lesson pin calls (体会 phase 2): request shape and how a full quota settles. Not a browser test. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { listLessonPins, setLessonPinned } from '../src/client/api.ts'

type Call = { url: string; init?: RequestInit }
function stubFetch(respond: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('listLessonPins reads the session lessons route and keeps only id + pinned', async () => {
  const stub = stubFetch(() => json(200, { items: [{ id: 'a', pinned: true, recall_count: 2 }, { id: 'b', pinned: false }, { pinned: true }] }))
  try {
    assert.deepEqual(await listLessonPins('sess 1'), [{ id: 'a', pinned: true }, { id: 'b', pinned: false }])
    assert.equal(stub.calls[0].url, '/plugins/dsh-prompt-templates/lessons?session_id=sess%201')
  } finally { stub.restore() }
})

test('listLessonPins degrades to no toggles when the host has no lessons route', async () => {
  const stub = stubFetch(() => json(404, { error: { code: 'not-found' } }))
  try { assert.deepEqual(await listLessonPins('s'), []) } finally { stub.restore() }
  const broken = stubFetch(() => { throw new TypeError('offline') })
  try { assert.deepEqual(await listLessonPins('s'), []) } finally { broken.restore() }
})

test('setLessonPinned PATCHes the lesson and surfaces a full quota as pinned-full', async () => {
  const ok = stubFetch(() => json(200, { id: 'x/1', pinned: true }))
  try {
    assert.deepEqual(await setLessonPinned('x/1', true), { ok: true, value: { id: 'x/1', pinned: true } })
    assert.equal(ok.calls[0].url, '/plugins/dsh-prompt-templates/lessons/x%2F1')
    assert.equal(ok.calls[0].init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(ok.calls[0].init?.body)), { pinned: true })
  } finally { ok.restore() }
  const full = stubFetch(() => json(409, { error: { code: 'pinned-full', message: 'at most 3 pinned lessons' } }))
  try {
    const result = await setLessonPinned('y', true)
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.error.code, 'pinned-full')
  } finally { full.restore() }
})
