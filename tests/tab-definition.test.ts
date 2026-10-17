/**
 * Sidebar tab definition tests: the registration is pure data with thunked
 * copy — these tests pin its shape (id/kind identity, guide entry order
 * fields, language freshness) because the registry throws on duplicates and
 * the guide sorts by `order`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PROMPT_TEMPLATES_KIND, PROMPT_TEMPLATES_ID, promptTemplatesTabDefinition } from '../src/client/tab.ts'

describe('promptTemplatesTabDefinition', () => {
  it('registers under the package-name identity and its own kind', () => {
    const definition = promptTemplatesTabDefinition((key) => key)
    assert.equal(definition.id, PROMPT_TEMPLATES_ID)
    assert.equal(definition.id, '@nelsonlongxiang/dsh-prompt-templates')
    assert.equal(definition.kind, PROMPT_TEMPLATES_KIND)
    assert.equal(definition.kind, 'promptTemplates')
  })

  it('is a page type: no address patterns, so it opens by kind only', () => {
    const definition = promptTemplatesTabDefinition((key) => key)
    assert.equal(definition.patterns, undefined)
    assert.equal(definition.canOpen, undefined)
  })

  it('reads its title through the thunk on every call (language changes need no re-registration)', () => {
    let copy = 'Prompts'
    const definition = promptTemplatesTabDefinition(() => copy)
    assert.equal(definition.title(''), 'Prompts')
    copy = '提示词'
    assert.equal(definition.title(''), '提示词')
  })

  it('offers exactly one guide entry with the mandatory order and identity fields', () => {
    const definition = promptTemplatesTabDefinition((key) => key)
    assert.ok(definition.guide !== undefined)
    assert.equal(definition.guide.length, 1)
    const [entry] = definition.guide
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.length > 0)
    assert.equal(typeof entry.order, 'number')
    assert.equal(entry.commandId, undefined)
    assert.equal(entry.title(), 'tab.guideTitle')
    assert.equal(entry.description?.(), 'tab.guideDescription')
  })
})
