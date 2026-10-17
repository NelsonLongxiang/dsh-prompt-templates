/**
 * Controller delivery-target semantics: the version counter + listener set
 * behind the open panel's useSyncExternalStore subscription. A session
 * switch must bump the version and notify listeners (so the panel
 * re-renders with the fresh target), and a repeated attach of the same
 * session must stay silent (no render churn).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PromptPanelController } from '../src/client/service.ts'

test('controller bumps target version and notifies on change', () => {
  const controller = new PromptPanelController()
  assert.equal(controller.targetSession(), undefined)
  assert.equal(controller.targetVersion(), 0)

  let notifications = 0
  const unsubscribe = controller.subscribeTarget(() => { notifications += 1 })

  controller.setTargetSession('session-a')
  assert.equal(controller.targetSession(), 'session-a')
  assert.equal(controller.targetVersion(), 1)
  assert.equal(notifications, 1)

  controller.setTargetSession('session-b')
  assert.equal(controller.targetSession(), 'session-b')
  assert.equal(controller.targetVersion(), 2)
  assert.equal(notifications, 2)
  unsubscribe()
})

test('controller dedupes repeated attaches of the same session', () => {
  const controller = new PromptPanelController()
  let notifications = 0
  controller.subscribeTarget(() => { notifications += 1 })

  controller.setTargetSession('session-a')
  controller.setTargetSession('session-a')
  assert.equal(controller.targetVersion(), 1)
  assert.equal(notifications, 1)
})

test('controller subscription unsubscribe stops notifications', () => {
  const controller = new PromptPanelController()
  let notifications = 0
  const unsubscribe = controller.subscribeTarget(() => { notifications += 1 })
  unsubscribe()
  controller.setTargetSession('session-a')
  assert.equal(notifications, 0)
  assert.equal(controller.targetVersion(), 1)
})
