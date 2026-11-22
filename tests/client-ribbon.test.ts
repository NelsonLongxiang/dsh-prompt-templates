/** §5.16 lesson ribbon logic: order, queue jumps, counts, rotation and the per-session collapse memory. Not a browser test. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { changedLesson, FRESH_MS, nextIndex, orderRibbon, readCollapsed, ribbonCounts, ROTATE_MS, RibbonBus, writeCollapsed, type RibbonLesson } from '../src/client/ribbon.ts'

const lesson = (id: string, key: string, outcome: RibbonLesson['outcome'] = null, stamp = 'r1'): RibbonLesson => ({ id, key, content: `${key} 的体会`, outcome, evidence: null, stamp })

test('the ribbon rolls through the chain order: 收→续, then approved types, then legacy numbers', () => {
  const order = orderRibbon([lesson('a', '续'), lesson('b', '3'), lesson('c', '协作'), lesson('d', '收'), lesson('e', '验')]).map(l => l.key)
  assert.deepEqual(order, ['收', '验', '续', '协作', '3'])
  assert.equal(ROTATE_MS, 6000)
  assert.equal(FRESH_MS, 10000)
  assert.equal(nextIndex(4, 5), 0)
  assert.equal(nextIndex(1, 5), 2)
  assert.equal(nextIndex(0, 0), 0)
})

test('a lesson just written, rewritten or kept jumps the queue; the first snapshot and an unchanged one do not', () => {
  const first = [lesson('a', '收'), lesson('b', '找')]
  assert.equal(changedLesson(null, first), null, 'nothing jumps when the ribbon first appears')
  assert.equal(changedLesson(first, first), null)
  assert.equal(changedLesson(first, [...first, lesson('c', '验')]), 'c', 'a new lesson')
  assert.equal(changedLesson(first, [lesson('a', '收', null, 'r2'), lesson('b', '找')]), 'a', 'a rewrite or a keep changes the stamp')
})

test('the knot counts wrong and right', () => {
  assert.deepEqual(ribbonCounts([lesson('a', '收', 'wrong'), lesson('b', '找', 'right'), lesson('c', '验', 'wrong'), lesson('d', '续')]), { wrong: 2, right: 1, total: 4 })
})

test('collapse is remembered per session; a refusing or missing storage just forgets', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  assert.equal(readCollapsed(storage, 's1'), false)
  writeCollapsed(storage, 's1', true)
  assert.equal(readCollapsed(storage, 's1'), true)
  assert.equal(readCollapsed(storage, 's2'), false, 'per session')
  writeCollapsed(storage, 's1', false)
  assert.equal(readCollapsed(storage, 's1'), false)
  const refusing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
  assert.equal(readCollapsed(refusing, 's1'), false)
  assert.doesNotThrow(() => { writeCollapsed(refusing, 's1', true) })
  assert.equal(readCollapsed(undefined, 's1'), false)
})

test('the bus hands the visible session to the overlay and hides it when that knot leaves', () => {
  const bus = new RibbonBus()
  let seen = 0
  const stop = bus.subscribe(() => { seen += 1 })
  bus.publish({ sessionId: 's1', lessons: [lesson('a', '收')], anchor: { left: 0, top: 40, width: 600 } })
  assert.equal(bus.get().sessionId, 's1')
  bus.publish({ sessionId: 's2', lessons: [], anchor: null })
  bus.release('s1')
  assert.equal(bus.get().sessionId, 's2', 'another session took over: releasing the old one changes nothing')
  bus.release('s2')
  assert.equal(bus.get().sessionId, null)
  stop()
  bus.publish({ sessionId: 's3', lessons: [], anchor: null })
  assert.equal(seen, 3)
})

// Real-host fix (owner 2026-11-22: the ribbon did not render on the test host): it always has a place to hang.
test('the ribbon always gets an anchor: header first, then the knot row, then the viewport top', async () => {
  const { pickAnchor } = await import('../src/client/ribbon.ts')
  const header = { left: 280, top: 92, width: 820 }
  const knot = { left: 280, top: 60, width: 820 }
  assert.deepEqual(pickAnchor([{ source: 'header', anchor: header }, { source: 'knot', anchor: knot }], 1400), { anchor: header, source: 'header' })
  assert.deepEqual(pickAnchor([{ source: 'header', anchor: null }, { source: 'knot', anchor: knot }], 1400), { anchor: knot, source: 'knot' })
  assert.deepEqual(pickAnchor([{ source: 'header', anchor: { left: 0, top: 50, width: 0 } }, { source: 'knot', anchor: null }], 1400), { anchor: { left: 0, top: 0, width: 1400 }, source: 'viewport' }, 'a zero-width header is not a place')
  assert.deepEqual(pickAnchor([{ source: 'header', anchor: { left: Number.NaN, top: 50, width: 800 } }], 1400).source, 'viewport')
  assert.deepEqual(pickAnchor([], 0).anchor.width, 1, 'even a zero-width window yields a drawable anchor')
})

test('the overlay no longer waits for the knot: it falls back to the composer session and fetches for itself', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/LessonRibbon.tsx', import.meta.url), 'utf8')
  assert.match(src, /const fallback = published\.sessionId === null \? target : null/)
  assert.match(src, /loadRibbonLessons\(fallback\)/)
  assert.doesNotMatch(src, /if \(state\.anchor === null \|\| state\.sessionId === null \|\| lessons\.length === 0\) return null/, 'a missing anchor must not hide the ribbon')
  assert.match(src, /data-lesson-ribbon-anchor=/, 'the anchor source is visible for real-host checks')
  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(index, /targetSession: \(\) => controller\.targetSession\(\) \?\? null/)
})
