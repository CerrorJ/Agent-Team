import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { CommandLedger } from '../src/kernel/command-ledger.js'
import { prepareCatalogCommand } from '../src/kernel/catalog-commands.js'
import { RoleReadinessStore } from '../src/kernel/role-readiness-store.js'
import { prepareRoleCommand } from '../src/kernel/role-commands.js'
import {
  businessCommandSchema,
  roleVersionSchema,
  type BusinessCommand,
  type RoleVersion,
} from '../src/kernel/business-contracts.js'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import { createKernel } from '../src/kernel/kernel.js'

type Copy = Extract<BusinessCommand, { type: 'role.copy' }>

const makeSource = (): RoleVersion => ({
  id: randomUUID(),
  version: 1,
  name: '来源角色',
  slug: 'source-role',
  responsibility: '保持固定配置',
  inputRequirements: '明确输入',
  deliveryRequirements: '可审查交付',
  maxConcurrency: 2,
  cli: 'codex',
  model: 'fixed-model',
  permission: 'workspace-write',
  skills: [],
  modelProfileSnapshot: {
    id: randomUUID(),
    version: 1,
    name: '固定模型',
    cli: 'codex',
    provider: 'cli-managed',
    model: 'fixed-model',
    baseUrl: '',
    credentialRef: null,
    reasoningEffort: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
})

const fixture = (source: RoleVersion = makeSource()) => {
  const database = new DatabaseSync(':memory:')
  const store = new WorkspaceStore(database)
  const ledger = new CommandLedger(store)
  store.transaction(() => {
    store.addRole(source)
    new RoleReadinessStore(store).reset(source)
  })

  const command: Copy = {
    type: 'role.copy',
    sourceRoleId: source.id,
    expectedSourceVersion: source.version,
    name: '独立副本',
    slug: 'independent-copy',
  }

  return {
    database,
    store,
    source,
    command,
    copy: (value: Copy = command, key = randomUUID()) =>
      ledger.execute(
        { key, command: value },
        prepareCatalogCommand({ store, command: value }),
      ),
    read: (id: string) => store.get('role_versions', id, roleVersionSchema),
  }
}

const allRows = (database: DatabaseSync) =>
  (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => ({
    name,
    rows: database
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all(),
  }))

test('复制完整固定配置但不继承受控就绪记录，独立ID/v1和不可执行草稿，原对象不改写', () => {
  const f = fixture()
  try {
    const readiness = new RoleReadinessStore(f.store)
    f.store.transaction(() => {
      const original = readiness.read(f.source)
      // 仅受控就绪夹具；不是已执行CLI或模型的证明。
      readiness.save({
        ...original,
        version: original.version + 1,
        state: 'ready',
        enabled: true,
        latestTrialRunId: randomUUID(),
      })
    })
    const before = f.store.snapshot()
    const result = f.copy()
    const copied = f.read(result.id)
    assert.notEqual(copied.id, f.source.id)
    assert.equal(copied.version, 1)
    assert.equal(copied.name, '独立副本')
    assert.equal(copied.slug, 'independent-copy')

    const {
      id: _id,
      version: _version,
      name: _name,
      slug: _slug,
      createdAt: _createdAt,
      ...configuration
    } = copied

    const {
      id: _sourceId,
      version: _sourceVersion,
      name: _sourceName,
      slug: _sourceSlug,
      createdAt: _sourceCreated,
      ...originalConfiguration
    } = f.source

    assert.deepEqual(configuration, originalConfiguration)
    assert.deepEqual(f.read(f.source.id), f.source)
    const state = readiness.read(copied)
    assert.equal(state.state, 'draft')
    assert.equal(state.enabled, false)
    assert.equal(state.latestTrialRunId, null)
    assert.deepEqual(f.store.snapshot().runs, before.runs)
    assert.deepEqual(f.store.snapshot().tasks, before.tasks)

    const enabling = prepareRoleCommand({
      store: f.store,
      command: {
        type: 'role.setEnabled',
        roleId: result.id,
        expectedRoleVersion: 1,
        expectedReadinessVersion: state.version,
        enabled: true,
      },
      dataDirectory: 'unused',
    })

    assert.throws(enabling, /ROLE_NOT_READY/)
    assert.equal(readiness.read(copied).enabled, false)
  } finally {
    f.database.close()
  }
})

test('相同键返回原副本，来源之后改版也不重复复制；变更命令内容及新键旧来源版本拒绝', () => {
  const f = fixture()
  try {
    const key = randomUUID()
    const result = f.copy(f.command, key)
    f.store.transaction(() =>
      f.store.addRole({
        ...f.source,
        version: 2,
        responsibility: '新来源职责',
      }),
    )
    const before = allRows(f.database)
    assert.deepEqual(f.copy(f.command, key), result)
    assert.throws(
      () => f.copy({ ...f.command, name: '不同内容' }, key),
      /IDEMPOTENCY_CONFLICT/,
    )
    assert.throws(() => f.copy(), /VERSION_CONFLICT/)
    assert.deepEqual(allRows(f.database), before)
    assert.equal(f.read(result.id).responsibility, '保持固定配置')
  } finally {
    f.database.close()
  }
})

test('唯一标识包含历史占用，重复与旧源版本失败不留下任何表、事件/outbox或回执写入', () => {
  const f = fixture()
  try {
    const other = { ...makeSource(), slug: 'history-occupied' }
    f.store.transaction(() => {
      f.store.addRole(other)
      f.store.addRole({ ...other, version: 2, slug: 'legacy-renamed' })
    })
    const before = allRows(f.database)
    for (const slug of [f.source.slug!, 'history-occupied'])
      assert.throws(
        () => f.copy({ ...f.command, slug }),
        /ROLE_IDENTIFIER_TAKEN/,
      )
    assert.deepEqual(allRows(f.database), before)
  } finally {
    f.database.close()
  }
})

test('就绪写入或复制审计事件失败回滚角色、就绪、全部事件/outbox及回执', () => {
  for (const trigger of [
    "CREATE TRIGGER refuse_copy BEFORE INSERT ON role_readiness BEGIN SELECT RAISE(ABORT,'copy fixture failure'); END",
    "CREATE TRIGGER refuse_copy BEFORE INSERT ON workspace_events WHEN NEW.type='role.copied' BEGIN SELECT RAISE(ABORT,'copy fixture failure'); END",
  ]) {
    const f = fixture()
    try {
      f.database.exec(trigger)
      const before = allRows(f.database)
      assert.throws(() => f.copy(), /copy fixture failure/)
      assert.deepEqual(allRows(f.database), before)
    } finally {
      f.database.close()
    }
  }
})

test('历史缺省字段归一到新副本，缺失技能保持引用但试运行守卫拒绝，不创建Run', () => {
  const source = makeSource()
  delete source.slug
  delete source.inputRequirements
  delete source.deliveryRequirements
  delete source.maxConcurrency
  delete source.modelProfileSnapshot
  source.skills = [{ id: randomUUID(), digest: 'a'.repeat(64) }]
  const f = fixture(source)
  try {
    const before = JSON.stringify(f.read(source.id))
    const copied = f.read(f.copy().id)
    assert.equal(copied.inputRequirements, '')
    assert.equal(copied.deliveryRequirements, '')
    assert.equal(copied.maxConcurrency, 1)
    assert.equal(copied.modelProfileSnapshot, null)
    assert.deepEqual(copied.skills, source.skills)
    assert.equal(JSON.stringify(f.read(source.id)), before)
    assert.throws(
      () =>
        prepareRoleCommand({
          store: f.store,
          command: {
            type: 'role.trial',
            roleId: copied.id,
            expectedRoleVersion: 1,
            projectId: randomUUID(),
          },
          dataDirectory: 'unused',
        }),
      /NOT_FOUND/,
    )
    assert.equal(f.store.snapshot().runs.length, 0)
  } finally {
    f.database.close()
  }
})

test('复制协议拒绝状态/配置/凭据注入，调用方只能指定新名称标识和精确来源', () => {
  const f = fixture()
  try {
    assert.equal(businessCommandSchema.safeParse(f.command).success, true)
    for (const field of [
      { enabled: true },
      { permission: 'workspace-write' },
      { model: 'override' },
      { secret: 'synthetic-secret' },
      { slug: 'BAD SLUG' },
      { name: ' ' },
      { expectedSourceVersion: 0 },
    ])
      assert.equal(
        businessCommandSchema.safeParse({ ...f.command, ...field }).success,
        false,
      )
  } finally {
    f.database.close()
  }
})

test('真实嵌入协议复制固定模型历史版本，重启仍是同一草稿/幂等副本，无CLI/网络调用', async () => {
  const f = await localKernelFixture(async () => {
    throw new Error('MUST_NOT_EXECUTE')
  })

  let restarted: ReturnType<typeof createKernel> | undefined
  try {
    const modelId = await f.command({
      type: 'model.save',
      expectedVersion: 0,
      name: '旧模型',
      cli: 'codex',
      provider: 'cli-managed',
      model: 'old-model',
      baseUrl: '',
      credentialRef: null,
      reasoningEffort: '',
    })

    const sourceId = await f.command({
      type: 'role.save',
      expectedVersion: 0,
      name: '真实协议来源',
      slug: 'protocol-source',
      responsibility: '不执行，仅复制',
      cli: 'codex',
      model: '',
      permission: 'read-only',
      modelProfileRef: { id: modelId, version: 1 },
    })

    await f.command({
      type: 'model.save',
      id: modelId,
      expectedVersion: 1,
      name: '新模型',
      cli: 'codex',
      provider: 'cli-managed',
      model: 'new-model',
      baseUrl: '',
      credentialRef: null,
      reasoningEffort: '',
    })

    const command: Copy = {
      type: 'role.copy',
      sourceRoleId: sourceId,
      expectedSourceVersion: 1,
      name: '协议副本',
      slug: 'protocol-copy',
    }

    const key = randomUUID()
    const id = await f.command(command, key)
    const copied = (await f.snapshot()).roles.find((role) => role.id === id)!
    assert.equal(copied.modelProfileSnapshot?.version, 1)
    assert.equal(copied.model, 'old-model')
    assert.ok(f.kernel.handshake.capabilities.includes('role-copy'))
    await f.kernel.shutdown()
    restarted = createKernel({
      dataDirectory: f.dataDirectory,
      sourceCommit: 'a'.repeat(40),
      execute: async () => {
        throw new Error('MUST_NOT_EXECUTE')
      },
    })

    const result = await restarted.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'workspace.command',
      key,
      command,
    })

    assert.equal(result.status, 'completed')
    assert.deepEqual(result.result, { id })

    const response = await restarted.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'workspace.snapshot',
    })

    assert.equal(response.status, 'completed')
    const snapshot = response.result as Awaited<ReturnType<typeof f.snapshot>>
    assert.equal(snapshot.roles.filter((role) => role.id === id).length, 1)
    assert.equal(
      snapshot.roleReadiness.find((role) => role.roleId === id)?.enabled,
      false,
    )
    assert.equal(snapshot.runs.length, 0)
  } finally {
    await restarted?.shutdown()
    await f.cleanup()
  }
})
