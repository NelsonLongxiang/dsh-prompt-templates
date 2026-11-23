/** #78 review X7/X8: the panel keeps the card rounds recorded not applicable. Not a browser test: the tooltip check reads the panel source. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { listCardStats } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

function stubFetch(body: unknown): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  return () => { globalThis.fetch = original }
}

test('listCardStats keeps na from the host (X7)', async () => {
  const restore = stubFetch({ cards: [{ template_id: 'c-na', injected: 3, lessons: 0, none: 1, missed: 0, na: 2, recurrence: { hits: 0, fails: 0 } }] })
  try {
    assert.deepEqual(await listCardStats('s'), [{ template_id: 'c-na', injected: 3, lessons: 0, none: 1, missed: 0, na: 2, recurrence: { hits: 0, fails: 0 } }])
  } finally { restore() }
})

test('listCardStats gives na 0 for a host that predates it', async () => {
  const restore = stubFetch({ cards: [{ template_id: 'c-old', injected: 1, lessons: 1, none: 0, missed: 0, recurrence: { hits: 0, fails: 0 } }] })
  try {
    assert.equal((await listCardStats('s'))[0]?.na, 0)
  } finally { restore() }
})

test('the card tooltip shows na in both languages (X8)', () => {
  for (const locale of [zh, en]) assert.ok(locale['panel.cardYield'].includes('{na}'), 'the text has a place for na')
  const library = readFileSync(new URL('../src/client/Library.tsx', import.meta.url), 'utf8')
  assert.ok(library.includes(".replace('{na}', String(cardYield.na))"), 'the panel fills {na} with the card\'s na')
})
