import assert from 'node:assert/strict'
import test from 'node:test'
import { GITHUB_REPOSITORY_URL, PLUGIN_VERSION, templateCountLabel } from '../src/client/meta.ts'

test('count label reports current-tab size or matched/searchable ratio', () => {
  assert.equal(templateCountLabel(7, 40, false), '7')
  assert.equal(templateCountLabel(2, 40, true), '2/40')
  assert.equal(templateCountLabel(0, 0, true), '0/0')
})

test('GitHub metadata targets the canonical plugin repository', () => {
  assert.equal(GITHUB_REPOSITORY_URL, 'https://github.com/NelsonLongXiang/dsh-prompt-templates')
  // Unbundled tests intentionally use the dev fallback; the production bundle
  // assertion lives in verify:release/browser smoke where tsdown injects 0.7.0.
  assert.equal(PLUGIN_VERSION, 'dev')
})
