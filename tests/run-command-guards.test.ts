import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { prepareRunCommand } from '../src/kernel/run-commands.js'
import { LocalScheduler } from '../src/kernel/local-scheduler.js'
import { runSchema } from '../src/kernel/business-contracts.js'
import { workspaceFixture as fixture } from './helpers/run-fixture.js'

test('排队取消记录未启动进程已经结束，允许后续新 Run；待确认进程拒绝停止决定', () => {
  const { database, store, run } = fixture()
  try {
    store.transaction(
      prepareRunCommand({
        store,
        dataDirectory: 'unused',
        command: { type: 'run.stop', runId: run.id, expectedVersion: 1 },
      }),
    )
    const cancelled = store.get('runs', run.id, runSchema)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.processState, 'confirmed_ended')
    assert.ok(cancelled.endedAt)
    store.transaction(() =>
      store.updateRun({
        ...cancelled,
        version: 3,
        status: 'running',
        processState: 'uncertain',
      }),
    )
    assert.throws(
      () =>
        store.transaction(
          prepareRunCommand({
            store,
            dataDirectory: 'unused',
            command: { type: 'run.stop', runId: run.id, expectedVersion: 3 },
          }),
        ),
      /STATE_UNCERTAIN/,
    )
    assert.equal(store.get('runs', run.id, runSchema).version, 3)
  } finally {
    database.close()
  }
})

test('完全退出也将尚未启动的排队任务取消为确认结束', async () => {
  const { database, store, run } = fixture()
  try {
    await new LocalScheduler({ store, dataDirectory: 'unused' }).shutdown()
    assert.equal(
      store.get('runs', run.id, runSchema).processState,
      'confirmed_ended',
    )
  } finally {
    database.close()
  }
})

test('历史 Run 的日志不被其他 Run 后来的全局日志挤掉', () => {
  const { database, store, run } = fixture()
  try {
    store.event('run.activity', { id: run.id, version: 1, label: '原执行日志' })
    const otherRun = randomUUID()
    for (let index = 0; index < 120; index++)
      store.event('run.activity', {
        id: otherRun,
        version: 1,
        label: `其他日志${index}`,
      })
    assert.equal(store.activity().length, 100)
    assert.equal(
      store.activity().some((item) => item.runId === run.id),
      false,
    )
    assert.equal(store.activity(run.id)[0]?.label, '原执行日志')
  } finally {
    database.close()
  }
})
