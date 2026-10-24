import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { CommandLedger } from '../src/kernel/command-ledger.js'
import { prepareCatalogCommand } from '../src/kernel/catalog-commands.js'
import { RoleReadinessStore } from '../src/kernel/role-readiness-store.js'
import {
  businessCommandSchema,
  roleVersionSchema,
  type BusinessCommand,
} from '../src/kernel/business-contracts.js'

type RoleSave = Extract<BusinessCommand, { type: 'role.save' }>

const base: RoleSave = {
  type: 'role.save',
  expectedVersion: 0,
  name: '配置角色',
  responsibility: '在任务边界内工作',
  cli: 'codex',
  model: '',
  permission: 'read-only',
}

const fixture = () => {
  const database = new DatabaseSync(':memory:')
  const store = new WorkspaceStore(database)
  const ledger = new CommandLedger(store)

  const save = (command: RoleSave) =>
    ledger.execute(
      { key: randomUUID(), command },
      prepareCatalogCommand({ store, command }),
    ).id

  return {
    database,
    store,
    save,
    read: (id: string) => store.get('role_versions', id, roleVersionSchema),
  }
}

test('角色配置追加版本，旧客户端省略新字段不擦除配置，历史版本不改写且需重新试运行', () => {
  const f = fixture()
  try {
    const id = f.save({
      ...base,
      slug: 'product-manager',
      inputRequirements: '已确认需求',
      deliveryRequirements: '可追溯方案',
      maxConcurrency: 2,
    })

    const original = f.read(id)
    f.save({ ...base, id, expectedVersion: 1, name: '新名称' })
    const latest = f.read(id)
    assert.equal(latest.version, 2)
    assert.equal(latest.name, '新名称')
    for (const field of [
      'slug',
      'inputRequirements',
      'deliveryRequirements',
      'maxConcurrency',
    ] as const)
      assert.equal(latest[field], original[field])
    assert.deepEqual(
      f.store
        .list('role_versions', roleVersionSchema)
        .find((role) => role.id === id && role.version === 1),
      original,
    )
    assert.equal(new RoleReadinessStore(f.store).read(latest).enabled, false)
    assert.equal(new RoleReadinessStore(f.store).read(latest).state, 'draft')
  } finally {
    f.database.close()
  }
})

test('角色标识唯一且保存后不可改，失败不提交状态、事件、通知或幂等回执', () => {
  const f = fixture()
  try {
    const id = f.save({ ...base, slug: 'developer' })

    const counts = () =>
      [
        'role_versions',
        'workspace_events',
        'notification_outbox',
        'command_receipts',
      ].map(
        (table) =>
          f.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      )

    const before = counts()
    assert.throws(
      () => f.save({ ...base, name: '另一角色', slug: 'developer' }),
      /ROLE_IDENTIFIER_TAKEN/,
    )
    assert.throws(
      () => f.save({ ...base, id, expectedVersion: 1, slug: 'renamed' }),
      /ROLE_IDENTIFIER_IMMUTABLE/,
    )
    assert.throws(
      () => f.save({ ...base, id, expectedVersion: 0 }),
      /VERSION_CONFLICT/,
    )
    assert.deepEqual(counts(), before)
    assert.equal(f.read(id).version, 1)
  } finally {
    f.database.close()
  }
})

test('旧角色缺省字段读取不补写，编辑产生稳定默认标识及配置，仅写入新版本', () => {
  const f = fixture()
  try {
    const id = randomUUID()

    const legacy = {
      id,
      version: 1,
      name: '旧角色',
      responsibility: '旧职责',
      cli: 'codex',
      model: '',
      permission: 'read-only',
      skills: [],
      createdAt: new Date().toISOString(),
    }

    f.store.transaction(() => f.store.addRole(roleVersionSchema.parse(legacy)))

    const originalRow = f.database
      .prepare('SELECT data FROM role_versions WHERE id=? AND version=1')
      .get(id)?.data

    assert.deepEqual(f.read(id), legacy)
    f.save({ ...base, id, expectedVersion: 1 })
    assert.equal(f.read(id).slug, `role-${id.replaceAll('-', '')}`)
    assert.equal(f.read(id).maxConcurrency, 1)
    assert.equal(f.read(id).inputRequirements, '')
    assert.equal(
      f.database
        .prepare('SELECT data FROM role_versions WHERE id=? AND version=1')
        .get(id)?.data,
      originalRow,
    )
  } finally {
    f.database.close()
  }
})

test('角色输入边界拒绝非法标识和超过本机调度上限的并发，不将输入要求当权限', () => {
  for (const fields of [
    { slug: 'invalid slug' },
    { slug: 'bad--slug' },
    { maxConcurrency: 0 },
    { maxConcurrency: 3 },
    { inputRequirements: 'x'.repeat(20001) },
  ])
    assert.equal(
      businessCommandSchema.safeParse({ ...base, ...fields }).success,
      false,
    )
  assert.equal(
    businessCommandSchema.safeParse({
      ...base,
      slug: 'developer-2',
      maxConcurrency: 2,
    }).success,
    true,
  )
})
