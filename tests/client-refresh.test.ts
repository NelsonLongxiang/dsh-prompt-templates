/** The library re-reads while mounted (owner 2026-11-21: agent-written rows never showed). Not a browser test. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LIBRARY_REFRESH_MS, startLibraryRefresh } from '../src/client/refresh.ts'

function harness(visibilityState = 'visible') {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState })
  let tick: (() => void) | undefined
  let interval: number | undefined
  let cleared = false
  const targets = {
    window: win, document: doc,
    setInterval: (fn: () => void, ms: number) => { tick = fn; interval = ms; return 1 },
    clearInterval: () => { cleared = true },
  }
  return { win, doc, targets, tick: () => tick?.(), interval: () => interval, cleared: () => cleared }
}

test('re-reads on every tick, on window focus and when the page becomes visible', () => {
  const h = harness()
  let reads = 0
  const stop = startLibraryRefresh(() => { reads++ }, h.targets)
  assert.equal(h.interval(), LIBRARY_REFRESH_MS)
  h.tick(); assert.equal(reads, 1)
  h.win.dispatchEvent(new Event('focus')); assert.equal(reads, 2)
  h.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(reads, 3)
  stop()
  assert.ok(h.cleared())
  h.win.dispatchEvent(new Event('focus')); h.doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(reads, 3, 'no reads after stop')
})

test('does not read while the page is hidden', () => {
  const h = harness('hidden')
  let reads = 0
  const stop = startLibraryRefresh(() => { reads++ }, h.targets)
  h.tick(); h.doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(reads, 0)
  stop()
})
