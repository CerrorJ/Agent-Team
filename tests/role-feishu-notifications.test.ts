import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { FeishuStore } from '../src/kernel/feishu-store.js'
import { RoleFeishuStore } from '../src/kernel/role-feishu-store.js'
import { flushRoleFeishuNotification } from '../src/kernel/role-feishu-notifications.js'
import { type FeishuBinding } from '../src/kernel/feishu-contracts.js'
import { type FeishuTransport } from '../src/kernel/feishu-transport.js'
import { taskSchema } from '../src/kernel/business-contracts.js'

const binding = (suffix: string): FeishuBinding => ({
  id: randomUUID(),
  version: 1,
  appId: `cli_${suffix.repeat(16)}`,
  tenantKey: `synthetic-${suffix}`,
  ownerOpenId: `ou_${suffix}`,
  chatId: `oc_${suffix}`,
  credentialRef: `feishu-${randomUUID()}`,
  enabled: true,
  updatedAt: new Date().toISOString(),
})

type Fixture = ReturnType<typeof workspaceFixture>

const addRun = (
  fixture: Fixture,
  channel: FeishuBinding | null | undefined,
) => {
  const role = {
    ...fixture.run.roleSnapshot,
    id: randomUUID(),
    ...(channel === undefined ? {} : { feishuBinding: channel }),
  }

  const task = {
    ...fixture.store.get('tasks', fixture.run.taskId, taskSchema),
    id: randomUUID(),
    roleId: role.id,
  }

  const run = {
    ...fixture.run,
    id: randomUUID(),
    roleSnapshot: role,
    taskId: task.id,
    status: 'stopped' as const,
    processState: 'confirmed_ended' as const,
  }

  fixture.store.transaction(() => {
    fixture.store.addRole(role)
    fixture.store.addTask(task)
    fixture.store.addRun(run)
  })
  return run
}

test('角色通知固定Run绑定，角色后续变更及其他应用不会重路由；null/试运行不流入旧单连接', async () => {
  const fixture = workspaceFixture({ persistRun: false })
  const a = binding('a')
  const b = binding('b')
  const channel = new RoleFeishuStore(fixture.store)
  try {
    const runA = addRun(fixture, a)
    const runB = addRun(fixture, b)
    const noChannel = addRun(fixture, null)
    const legacy = addRun(fixture, undefined)
    const trial = addRun(fixture, a)
    fixture.store.transaction(() => {
      fixture.store.addRole({
        ...runA.roleSnapshot,
        version: 2,
        feishuBinding: b,
      })
      fixture.store.updateRun({ ...trial, version: 2, purpose: 'role_trial' })
      new FeishuStore(fixture.store).save({
        type: 'feishu.save',
        expectedVersion: 0,
        ...binding('c'),
      })
    })
    assert.deepEqual(
      channel.pending(a).map((item) => item.runId),
      [runA.id],
    )
    assert.deepEqual(
      channel.pending(b).map((item) => item.runId),
      [runB.id],
    )
    const old = new FeishuStore(fixture.store)
    const oldIds = old.pending(old.binding()!).map((item) => item.taskId)
    assert.ok(oldIds.includes(legacy.taskId))
    for (const run of [runA, runB, noChannel, trial])
      assert.equal(oldIds.includes(run.taskId), false)
    const sent: { chatId: string; content: string; uuid: string }[] = []

    const transport: FeishuTransport = {
      start: async () => {},
      close: () => {},
      state: () => 'connected',
      send: async (input) => {
        sent.push(input)
        return `om_${sent.length}`
      },
      update: async () => {},
    }

    await flushRoleFeishuNotification({
      store: fixture.store,
      binding: a,
      transport,
    })
    await flushRoleFeishuNotification({
      store: fixture.store,
      binding: b,
      transport,
    })
    assert.deepEqual(
      sent.map((item) => item.chatId),
      [a.chatId, b.chatId],
    )
    assert.notEqual(sent[0]!.uuid, sent[1]!.uuid)
    assert.equal(channel.pending(a).length, 0)
    assert.equal(channel.pending(b).length, 0)
  } finally {
    fixture.database.close()
  }
})

test('角色通知网络未知固定正文/uuid重发，随后补状态；过期停止且不影响另一绑定', async () => {
  const fixture = workspaceFixture({ persistRun: false })
  const a = binding('a')
  const b = binding('b')
  const sent: { chatId: string; content: string; uuid: string }[] = []
  const updates: string[] = []

  const transport: FeishuTransport = {
    start: async () => {},
    close: () => {},
    state: () => 'connected',
    send: async (input) => {
      sent.push(input)
      if (sent.length === 1) throw new Error('SYNTHETIC_NETWORK_UNKNOWN')
      return `om_${sent.length}`
    },
    update: async (input) => {
      updates.push(input.content)
    },
  }

  try {
    const runA = addRun(fixture, a)
    addRun(fixture, b)
    const options = { store: fixture.store, binding: a, transport }
    await assert.rejects(
      flushRoleFeishuNotification(options),
      /SYNTHETIC_NETWORK_UNKNOWN/,
    )
    const task = fixture.store.get('tasks', runA.taskId, taskSchema)
    fixture.store.transaction(() =>
      fixture.store.updateTask({
        ...task,
        version: 2,
        title: '网络期间新状态',
      }),
    )
    await flushRoleFeishuNotification(options)
    assert.deepEqual(sent[0], sent[1])
    await flushRoleFeishuNotification(options)
    assert.equal(updates.length, 1)
    assert.match(updates[0]!, /网络期间新状态/)
    fixture.database
      .prepare(
        'UPDATE role_feishu_messages SET message_id=NULL,sequence=0,create_started_at=? WHERE binding_id=?',
      )
      .run(new Date(Date.now() - 56 * 60 * 1000).toISOString(), a.id)
    await assert.rejects(
      flushRoleFeishuNotification(options),
      /FEISHU_DELIVERY_UNCERTAIN/,
    )
    assert.equal(sent.length, 2)
    await flushRoleFeishuNotification({ ...options, binding: b })
    assert.equal(sent.length, 3)
    assert.equal(sent[2]!.chatId, b.chatId)
  } finally {
    fixture.database.close()
  }
})
