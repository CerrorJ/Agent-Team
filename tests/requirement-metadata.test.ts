import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import {
  businessCommandSchema,
  type BusinessCommand,
} from '../src/kernel/business-contracts.js'
import { captureTaskConfiguration } from '../src/kernel/run-snapshots.js'

test('需求元数据追加版本：缺省历史保持原样，旧渠道省略保留，显式清除与旧Run引用隔离', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: value }).id

  const input = {
    type: 'requirement.save' as const,
    expectedVersion: 0,
    projectId: run.projectId,
    title: '旧需求',
    body: '原文',
    acceptanceCriteria: '人工核验',
  }

  try {
    const originalKey = randomUUID()
    const id = command(input, originalKey)
    const original = store.snapshot().requirements[0]!

    const raw = database
      .prepare('SELECT data FROM requirement_versions WHERE id=? AND version=1')
      .get(id)?.data

    assert.equal(Object.hasOwn(original, 'priority'), false)
    assert.equal(Object.hasOwn(original, 'stage'), false)

    const taskId = command({
      type: 'task.create',
      projectId: run.projectId,
      roleId: run.roleSnapshot.id,
      title: '固定旧需求',
      goal: '保留依据',
      acceptanceCriteria: '核验旧版本',
      requirementRef: { id, version: 1 },
    })

    const task = store.snapshot().tasks.find((item) => item.id === taskId)!
    // 受控终态历史夹具，仅验证不可变数据；不冒称执行或验收成功。
    store.transaction(() =>
      store.addRun({
        ...run,
        ...captureTaskConfiguration(store, task, run.id),
        taskId,
        status: 'stopped',
        processState: 'confirmed_ended',
        endedAt: new Date().toISOString(),
      }),
    )
    const history = database.prepare('SELECT data FROM runs').get()?.data
    command({
      ...input,
      id,
      expectedVersion: 1,
      priority: 'high',
      stage: 'plan_confirmed',
    })
    command({ ...input, id, expectedVersion: 2, body: '旧渠道修改正文' })
    let latest = store.snapshot().requirements.at(-1)!
    assert.equal(latest.priority, 'high')
    assert.equal(latest.stage, 'plan_confirmed')
    command({ ...input, id, expectedVersion: 3, priority: null, stage: null })
    command({ ...input, id, expectedVersion: 4 })
    latest = store.snapshot().requirements.at(-1)!
    assert.equal(latest.priority, null)
    assert.equal(latest.stage, null)
    assert.equal(command(input, originalKey), id)
    assert.equal(store.snapshot().requirements.length, 5)
    assert.equal(
      database
        .prepare(
          'SELECT data FROM requirement_versions WHERE id=? AND version=1',
        )
        .get(id)?.data,
      raw,
    )
    assert.equal(database.prepare('SELECT data FROM runs').get()?.data, history)
    assert.deepEqual(store.snapshot().runs[0]?.requirementSnapshot, original)
    assert.deepEqual(
      store.snapshot().tasks.find((item) => item.id === taskId)?.requirementRef,
      { id, version: 1 },
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('元数据严格枚举、并发冲突及数据库事件失败不留下版本、通知或回执，原命令可显式重试', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const input = {
    type: 'requirement.save' as const,
    expectedVersion: 0,
    projectId: run.projectId,
    title: '需求',
    body: '目标',
    acceptanceCriteria: '标准',
    priority: 'medium' as const,
    stage: 'needs_clarification' as const,
  }

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: value })

  try {
    for (const fields of [
      { priority: 'urgent' },
      { priority: 1 },
      { stage: 'done' },
      { stage: 'approved' },
      { extra: true },
    ])
      assert.equal(
        businessCommandSchema.safeParse({ ...input, ...fields }).success,
        false,
      )
    const id = command(input).id

    const change = {
      ...input,
      id,
      expectedVersion: 1,
      priority: 'low' as const,
      stage: 'implementing' as const,
    }

    const before = store.snapshot()

    const receipts = database
      .prepare('SELECT COUNT(*) AS count FROM command_receipts')
      .get()?.count

    const notifications = database
      .prepare('SELECT COUNT(*) AS count FROM notification_outbox')
      .get()?.count

    database.exec(
      "CREATE TEMP TRIGGER reject_requirement_event BEFORE INSERT ON workspace_events WHEN NEW.type='requirement.saved' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EVENT_FAILURE'); END",
    )
    const key = randomUUID()
    assert.throws(() => command(change, key), /SYNTHETIC_EVENT_FAILURE/)
    assert.deepEqual(store.snapshot(), before)
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()
        ?.count,
      receipts,
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM notification_outbox')
        .get()?.count,
      notifications,
    )
    database.exec('DROP TRIGGER reject_requirement_event')
    command(change, key)
    command(change, key)
    const committed = store.snapshot()
    assert.equal(committed.requirements.length, 2)
    assert.equal(committed.requirements.at(-1)?.stage, 'implementing')
    assert.equal(committed.runs.length, 0)
    assert.deepEqual(committed.tasks, before.tasks)
    assert.deepEqual(committed.humanRequests, before.humanRequests)
    assert.throws(
      () => command({ ...change, priority: 'high' }),
      /VERSION_CONFLICT/,
    )
    assert.deepEqual(store.snapshot(), committed)
  } finally {
    await service.shutdown()
    database.close()
  }
})
