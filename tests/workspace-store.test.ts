import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { CommandLedger } from '../src/kernel/command-ledger.js'
import {
  roleVersionSchema,
  type BusinessCommand,
  type RoleVersion,
} from '../src/kernel/business-contracts.js'

const role = (): RoleVersion => ({
  id: randomUUID(),
  version: 1,
  name: '测试角色',
  responsibility: '仅执行测试任务',
  cli: 'codex',
  model: '',
  permission: 'read-only',
  skills: [],
  createdAt: new Date().toISOString(),
})

test('命令幂等与内容冲突：同一回执不会重复创建角色版本', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const store = new WorkspaceStore(database)
    const ledger = new CommandLedger(store)
    const input = role()

    const command: BusinessCommand = {
      type: 'role.save',
      expectedVersion: 0,
      name: input.name,
      responsibility: input.responsibility,
      cli: input.cli,
      model: '',
      permission: input.permission,
    }

    const key = randomUUID()

    const operation = () => {
      store.addRole(input)
      return { id: input.id }
    }

    assert.deepEqual(ledger.execute({ key, command }, operation), {
      id: input.id,
    })
    assert.deepEqual(ledger.execute({ key, command }, operation), {
      id: input.id,
    })
    assert.equal(store.list('role_versions', roleVersionSchema).length, 1)
    assert.throws(
      () =>
        ledger.execute(
          { key, command: { ...command, name: '内容已改变' } },
          operation,
        ),
      /IDEMPOTENCY_CONFLICT/,
    )
    assert.equal(
      database.prepare('SELECT COUNT(*) AS total FROM workspace_events').get()
        ?.total,
      1,
    )
  } finally {
    database.close()
  }
})

test('失败事务同时回滚状态、事件、outbox和回执', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const store = new WorkspaceStore(database)
    assert.throws(
      () =>
        store.transaction(() => {
          store.addRole(role())
          throw new Error('中断事务')
        }),
      /中断事务/,
    )
    for (const table of [
      'role_versions',
      'workspace_events',
      'notification_outbox',
      'command_receipts',
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total,
        0,
      )
    }
  } finally {
    database.close()
  }
})

test('角色修改追加版本，旧版本不变且并发旧版本写入被拒绝', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const store = new WorkspaceStore(database)
    const original = role()
    store.transaction(() => store.addRole(original))
    store.transaction(() =>
      store.addRole({ ...original, version: 2, responsibility: '新职责' }),
    )
    assert.throws(
      () => store.transaction(() => store.addRole({ ...original, version: 2 })),
      /VERSION_CONFLICT/,
    )
    const versions = store.list('role_versions', roleVersionSchema)
    assert.equal(versions[0]?.responsibility, '仅执行测试任务')
    assert.equal(versions[1]?.responsibility, '新职责')
  } finally {
    database.close()
  }
})
