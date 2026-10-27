import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import {
  businessCommandSchema,
  type BusinessCommand,
  roleVersionSchema,
} from '../src/kernel/business-contracts.js'
import { FeishuStore } from '../src/kernel/feishu-store.js'

const binding = () => ({
  appId: 'cli_0123456789abcdef',
  tenantKey: 'synthetic-tenant',
  ownerOpenId: 'ou_owner',
  chatId: 'oc_role',
  credentialRef: `feishu-${randomUUID()}`,
  enabled: true,
})

const roleCommand = () => ({
  type: 'role.save' as const,
  expectedVersion: 0,
  name: '渠道角色',
  slug: `role-${randomUUID().replaceAll('-', '')}`,
  responsibility: '验证真实内核边界，未调用真实租户',
  cli: 'codex' as const,
  model: '',
  permission: 'read-only' as const,
})

test('角色渠道配置省略继承/null清除/相同配置复用身份，历史归属保留，复制不继承授权', async () => {
  const { store, database, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: businessCommandSchema.parse(value) }).id

  const base = roleCommand()
  const connection = binding()
  try {
    const key = randomUUID()
    const id = command({ ...base, feishu: connection }, key)
    const first = store.get('role_versions', id, roleVersionSchema)

    const firstRaw = database
      .prepare('SELECT data FROM role_versions WHERE id=? AND version=1')
      .get(id)?.data

    assert.ok(first.feishuBinding?.id)
    command({ ...base, id, expectedVersion: 1, feishu: connection })
    assert.deepEqual(
      store.get('role_versions', id, roleVersionSchema).feishuBinding,
      first.feishuBinding,
    )
    command({ ...base, id, expectedVersion: 2 })
    assert.deepEqual(
      store.get('role_versions', id, roleVersionSchema).feishuBinding,
      first.feishuBinding,
    )
    // 历史Run夹具仅检查字节，不代表模型执行。
    store.transaction(() =>
      store.addRun({
        ...run,
        roleSnapshot: first,
        status: 'stopped',
        processState: 'confirmed_ended',
      }),
    )
    const rawRun = database.prepare('SELECT data FROM runs').get()?.data
    command({
      ...base,
      id,
      expectedVersion: 3,
      feishu: { ...connection, chatId: 'oc_second' },
    })

    const changed = store.get(
      'role_versions',
      id,
      roleVersionSchema,
    ).feishuBinding!

    assert.notEqual(changed.id, first.feishuBinding!.id)

    const copiedBound = command({
      type: 'role.copy',
      sourceRoleId: id,
      expectedSourceVersion: 4,
      name: '已绑定角色副本',
      slug: 'copied-bound-role',
    })

    assert.equal(
      store.get('role_versions', copiedBound, roleVersionSchema).feishuBinding,
      null,
    )
    command({ ...base, id, expectedVersion: 4, feishu: null })
    assert.equal(
      store.get('role_versions', id, roleVersionSchema).feishuBinding,
      null,
    )
    assert.equal(command({ ...base, feishu: connection }, key), id)
    assert.equal(database.prepare('SELECT data FROM runs').get()?.data, rawRun)
    assert.equal(
      database
        .prepare('SELECT data FROM role_versions WHERE id=? AND version=1')
        .get(id)?.data,
      firstRaw,
    )
    assert.throws(
      () => command({ ...roleCommand(), feishu: connection }),
      /FEISHU_APP_IN_USE/,
    )
    assert.throws(
      () => command({ type: 'feishu.save', expectedVersion: 0, ...connection }),
      /FEISHU_APP_IN_USE/,
    )

    const copied = command({
      type: 'role.copy',
      sourceRoleId: id,
      expectedSourceVersion: 5,
      name: '副本',
      slug: 'copied-role',
    })

    assert.equal(
      store.get('role_versions', copied, roleVersionSchema).feishuBinding,
      null,
    )
    const other = { ...connection, appId: 'cli_fedcba9876543210' }
    command({ type: 'feishu.save', expectedVersion: 0, ...other })
    assert.throws(
      () => command({ ...roleCommand(), feishu: other }),
      /FEISHU_APP_IN_USE/,
    )
    assert.equal(new FeishuStore(store).binding()?.appId, other.appId)
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('角色渠道严格输入/CAS/事件失败整事务回滚，同命令键可重试，不持久化Secret', async () => {
  const { store, database } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: businessCommandSchema.parse(value) }).id

  const base = { ...roleCommand(), feishu: binding() }

  const rows = () =>
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        database.prepare(`SELECT * FROM ${String(name)}`).all(),
      ])

  try {
    for (const invalid of [
      { ...base.feishu, secret: 'must-never-persist' },
      { ...base.feishu, id: randomUUID() },
      { ...base.feishu, appId: 'cli_invalid' },
      { ...base.feishu, ownerOpenId: 'other' },
      { ...base.feishu, credentialRef: '../secret' },
    ])
      assert.equal(
        businessCommandSchema.safeParse({ ...base, feishu: invalid }).success,
        false,
      )
    const before = rows()
    const key = randomUUID()
    database.exec(
      "CREATE TEMP TRIGGER fail_role_channel BEFORE INSERT ON workspace_events WHEN NEW.type='role.version_created' BEGIN SELECT RAISE(ABORT,'CHANNEL_EVENT_FAILURE'); END",
    )
    assert.throws(() => command(base, key), /CHANNEL_EVENT_FAILURE/)
    assert.deepEqual(rows(), before)
    database.exec('DROP TRIGGER fail_role_channel')
    const id = command(base, key)
    assert.equal(command(base, key), id)
    const committed = rows()
    assert.throws(
      () => command({ ...base, id, expectedVersion: 0, feishu: null }),
      /VERSION_CONFLICT/,
    )
    assert.deepEqual(rows(), committed)
    assert.equal(
      JSON.stringify(committed).includes('must-never-persist'),
      false,
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('工作空间历史应用归属与hex大小写别名均不可被角色或旧渠道重新争领', async () => {
  const { store, database } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand) =>
    service.command({
      key: randomUUID(),
      command: businessCommandSchema.parse(value),
    }).id

  const first = { ...binding(), appId: 'cli_aaaaaaaaaaaaaaaa' }
  try {
    command({ type: 'feishu.save', expectedVersion: 0, ...first })
    command({
      type: 'feishu.save',
      expectedVersion: 1,
      ...first,
      appId: 'cli_bbbbbbbbbbbbbbbb',
    })
    assert.throws(
      () => command({ ...roleCommand(), feishu: first }),
      /FEISHU_APP_IN_USE/,
    )
    assert.throws(
      () =>
        command({
          ...roleCommand(),
          feishu: { ...first, appId: 'cli_AAAAAAAAAAAAAAAA' },
        }),
      /FEISHU_APP_IN_USE/,
    )
    const roleBinding = { ...first, appId: 'cli_cccccccccccccccc' }
    command({ ...roleCommand(), feishu: roleBinding })

    const counts = () =>
      database.prepare('SELECT COUNT(*) AS n FROM role_versions').get()?.n

    const before = counts()
    assert.throws(
      () =>
        command({
          ...roleCommand(),
          feishu: { ...roleBinding, appId: 'cli_CCCCCCCCCCCCCCCC' },
        }),
      /FEISHU_APP_IN_USE/,
    )
    assert.throws(
      () =>
        command({
          type: 'feishu.save',
          expectedVersion: 2,
          ...roleBinding,
          appId: 'cli_CCCCCCCCCCCCCCCC',
        }),
      /FEISHU_APP_IN_USE/,
    )
    assert.equal(counts(), before)
    assert.equal(
      new FeishuStore(store).binding()?.appId,
      'cli_bbbbbbbbbbbbbbbb',
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})
