import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import {
  businessCommandSchema,
  type BusinessCommand,
} from '../src/kernel/business-contracts.js'
import { ProductStore } from '../src/kernel/product-store.js'

test('团队说明缺省/继承/清空与幂等重放，既有计划和受控历史Run不改写', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: businessCommandSchema.parse(value) }).id

  const base = {
    type: 'team.save' as const,
    expectedVersion: 0,
    name: '协作团队',
    roleIds: [run.roleSnapshot.id],
    coordinatorRoleId: run.roleSnapshot.id,
  }

  try {
    const key = randomUUID()
    const id = command(base, key)
    assert.equal(
      Object.hasOwn(store.snapshot().teams[0]!, 'description'),
      false,
    )
    command({ ...base, id, expectedVersion: 1, description: '固定说明' })

    const planId = command({
      type: 'team.createTask',
      teamId: id,
      expectedTeamVersion: 2,
      projectId: run.projectId,
      title: '旧计划',
      goal: '旧依据',
      acceptanceCriteria: '人工验收',
      steps: [
        {
          key: 'one',
          roleId: run.roleSnapshot.id,
          title: '步骤',
          goal: '目标',
          acceptanceCriteria: '核验',
          dependsOn: [],
        },
      ],
    })

    const rawPlan = database
      .prepare('SELECT data FROM tasks WHERE id=?')
      .get(planId)?.data

    // 仅作不可变历史夹具，明确不代表模型执行或交付成功。
    store.transaction(() =>
      store.addRun({
        ...run,
        status: 'stopped',
        processState: 'confirmed_ended',
      }),
    )
    const rawRun = database.prepare('SELECT data FROM runs').get()?.data
    command({ ...base, id, expectedVersion: 2 })
    assert.equal(store.snapshot().teams.at(-1)?.description, '固定说明')
    command({ ...base, id, expectedVersion: 3, description: '' })
    command({ ...base, id, expectedVersion: 4 })
    assert.equal(store.snapshot().teams.at(-1)?.description, '')
    assert.equal(command(base, key), id)
    assert.equal(store.snapshot().teams.length, 5)
    assert.equal(
      database.prepare('SELECT data FROM tasks WHERE id=?').get(planId)?.data,
      rawPlan,
    )
    assert.equal(database.prepare('SELECT data FROM runs').get()?.data, rawRun)
    assert.equal(
      store.snapshot().tasks.find((task) => task.id === planId)?.teamSnapshot
        ?.description,
      '固定说明',
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('团队名称规范化冲突和并发旧版本拒绝，事件失败整体回滚后同key可重试', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: businessCommandSchema.parse(value) }).id

  const base = {
    type: 'team.save' as const,
    expectedVersion: 0,
    name: 'Team A',
    description: '说明',
    roleIds: [run.roleSnapshot.id],
    coordinatorRoleId: run.roleSnapshot.id,
  }

  const rows = () =>
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        database.prepare(`SELECT * FROM ${String(name)}`).all(),
      ])

  try {
    const id = command(base)
    const before = rows()
    for (const name of [' team a ', 'Ｔｅａｍ Ａ', 'TEAM A']) {
      assert.throws(() => command({ ...base, name }), /TEAM_NAME_TAKEN/)
      assert.deepEqual(rows(), before)
    }
    for (const fields of [
      { description: null },
      { description: 1 },
      { description: 'a'.repeat(20_001) },
      { extra: 'x' },
    ])
      assert.equal(
        businessCommandSchema.safeParse({ ...base, ...fields }).success,
        false,
      )
    const change = { ...base, id, expectedVersion: 1, description: '新版说明' }
    const key = randomUUID()
    database.exec(
      "CREATE TEMP TRIGGER reject_team_event BEFORE INSERT ON workspace_events WHEN NEW.type='team.saved' BEGIN SELECT RAISE(ABORT,'TEAM_EVENT_FAILURE'); END",
    )
    assert.throws(() => command(change, key), /TEAM_EVENT_FAILURE/)
    assert.deepEqual(rows(), before)
    database.exec('DROP TRIGGER reject_team_event')
    command(change, key)
    command(change, key)
    const committed = rows()
    assert.throws(
      () => command({ ...change, name: '新名称' }),
      /VERSION_CONFLICT/,
    )
    assert.deepEqual(rows(), committed)
    const failedKey = randomUUID()
    assert.throws(() => command(base, failedKey), /TEAM_NAME_TAKEN/)
    command({ ...base, name: '另一团队' }, failedKey)
    assert.equal(store.snapshot().teams.length, 3)
    assert.equal(store.snapshot().runs.length, 0)
    assert.equal(store.snapshot().humanRequests.length, 0)
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('历史重名团队不迁移也不锁死编辑，保持原名可追加，新建或改名仍受唯一约束', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const first = {
    id: randomUUID(),
    version: 1,
    name: '历史重名',
    roleIds: [run.roleSnapshot.id],
    coordinatorRoleId: run.roleSnapshot.id,
    createdAt: new Date().toISOString(),
  }

  const second = { ...first, id: randomUUID() }

  const command = (value: BusinessCommand) =>
    service.command({
      key: randomUUID(),
      command: businessCommandSchema.parse(value),
    })

  try {
    store.transaction(() => {
      new ProductStore(store).append('team_versions', first, 'team.saved')
      new ProductStore(store).append('team_versions', second, 'team.saved')
    })

    const original = database
      .prepare('SELECT data FROM team_versions WHERE version=1 ORDER BY rowid')
      .all()

    const input = {
      type: 'team.save' as const,
      id: first.id,
      expectedVersion: 1,
      name: first.name,
      roleIds: first.roleIds,
      coordinatorRoleId: first.coordinatorRoleId,
      description: '补充旧团队说明',
    }

    command(input)
    command({ ...input, id: second.id, name: '唯一新名称' })
    assert.throws(
      () => command({ ...input, expectedVersion: 2, name: '唯一新名称' }),
      /TEAM_NAME_TAKEN/,
    )
    command({ ...input, expectedVersion: 2, name: '独立名称' })
    assert.deepEqual(
      database
        .prepare(
          'SELECT data FROM team_versions WHERE version=1 ORDER BY rowid',
        )
        .all(),
      original,
    )
    assert.equal(store.snapshot().teams.length, 5)
  } finally {
    await service.shutdown()
    database.close()
  }
})
