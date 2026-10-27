import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { workspaceFixture } from './helpers/run-fixture.js'
import {
  syntheticBinding,
  addWaitingRoleRun,
  syntheticAction,
} from './helpers/role-feishu-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import { RoleFeishuRuntime } from '../src/kernel/role-feishu-runtime.js'
import { HumanStore } from '../src/kernel/human-store.js'
import { applyFeishuAction } from '../src/kernel/feishu-actions.js'

test('多应用单连接及按Run校验旧配置，跨应用/绑定/所有者拒绝，决定幂等与断开后迟到回调', async () => {
  const fixture = workspaceFixture({ persistRun: false })
  const a = addWaitingRoleRun({ fixture, binding: syntheticBinding('a') })
  const b = addWaitingRoleRun({ fixture, binding: syntheticBinding('b') })

  const newer = {
    ...a.binding,
    id: randomUUID(),
    ownerOpenId: 'ou_new_owner',
    chatId: 'oc_new_chat',
  }

  const roleV2 = { ...a.role, version: 2, feishuBinding: newer }
  fixture.store.transaction(() => fixture.store.addRole(roleV2))
  const a2 = addWaitingRoleRun({ fixture, binding: newer, role: roleV2 })

  const service = new WorkspaceService({
    store: fixture.store,
    dataDirectory: 'unused',
  })

  const callbacks = new Map<string, (raw: unknown) => unknown>()
  const sent: { appId: string; chatId: string; content: string }[] = []
  const starts: string[] = []
  const closes: string[] = []

  const runtime = new RoleFeishuRuntime({
    store: fixture.store,
    service,
    credentials: async () => 'synthetic-secret-never-record',
    factory: (options) => {
      assert.equal(options.secret, 'synthetic-secret-never-record')
      callbacks.set(options.binding.appId, options.onAction)
      return {
        start: async () => {
          starts.push(options.binding.appId)
        },
        close: () => {
          closes.push(options.binding.appId)
        },
        state: () => 'connected',
        send: async (input) => {
          sent.push({ appId: options.binding.appId, ...input })
          return `om_${sent.length}`
        },
        update: async () => {},
      }
    },
  })

  const invoke = (appId: string, raw: unknown) =>
    callbacks.get(appId)!(raw) as { toast: { type: string } }

  try {
    await assert.rejects(
      runtime.connect({ roleId: a.role.id, expectedRoleVersion: 1 }),
      /VERSION_CONFLICT/,
    )
    await runtime.connect({ roleId: a.role.id, expectedRoleVersion: 2 })
    await runtime.connect({ roleId: b.role.id, expectedRoleVersion: 1 })
    assert.deepEqual(starts.sort(), [a.binding.appId, b.binding.appId].sort())
    for (let index = 0; index < 100 && sent.length < 3; index++) await delay(20)
    assert.deepEqual(
      sent.map((item) => item.chatId).sort(),
      [a.binding.chatId, newer.chatId, b.binding.chatId].sort(),
    )
    const event = syntheticAction(a)
    const previousCallback = callbacks.get(a.binding.appId)!
    fixture.store.transaction(() =>
      fixture.store.addRole({ ...roleV2, version: 3, feishuBinding: null }),
    )
    runtime.disconnect(a.role.id)
    await runtime.connect({ roleId: a.role.id, expectedRoleVersion: 3 })
    assert.equal(
      (previousCallback(event) as { toast: { type: string } }).toast.type,
      'error',
    )
    assert.equal(runtime.status(a.role.id).roleVersion, 3)
    assert.equal(invoke(b.binding.appId, event).toast.type, 'error')
    assert.equal(
      invoke(a.binding.appId, {
        ...event,
        action: {
          ...event.action,
          value: { ...event.action.value, bindingId: newer.id },
        },
      }).toast.type,
      'error',
    )
    assert.equal(
      invoke(a.binding.appId, {
        ...event,
        operator: { ...event.operator, open_id: newer.ownerOpenId },
      }).toast.type,
      'error',
    )
    assert.equal(
      new HumanStore(fixture.store).get(a.request.id).status,
      'pending',
    )
    assert.equal(invoke(a.binding.appId, event).toast.type, 'success')
    assert.equal(invoke(a.binding.appId, event).toast.type, 'success')
    assert.equal(
      invoke(a.binding.appId, { ...event, event_id: randomUUID() }).toast.type,
      'error',
    )
    assert.equal(
      invoke(a.binding.appId, syntheticAction(a2)).toast.type,
      'success',
    )
    assert.equal(
      new HumanStore(fixture.store).get(a.request.id).actor?.channel,
      'feishu',
    )
    assert.equal(
      new HumanStore(fixture.store).get(b.request.id).status,
      'pending',
    )
    assert.throws(
      () =>
        applyFeishuAction({
          store: fixture.store,
          service,
          binding: b.binding,
          raw: {
            ...syntheticAction(b),
            action: {
              ...syntheticAction(b).action,
              value: {
                ...syntheticAction(b).action.value,
                requestId: a.request.id,
              },
            },
          },
        }),
      /FEISHU_IDENTITY_MISMATCH/,
    )
    runtime.disconnect(a.role.id)
    assert.equal(invoke(a.binding.appId, event).toast.type, 'error')
    assert.equal(runtime.status(a.role.id).connections.length, 0)
    assert.equal(runtime.status(b.role.id).connections[0]?.state, 'connected')
    assert.equal(
      JSON.stringify(fixture.store.snapshot()).includes(
        'synthetic-secret-never-record',
      ),
      false,
    )
  } finally {
    runtime.close()
    await runtime.drain()
    await service.shutdown()
    fixture.database.close()
  }
  assert.equal(closes.length, starts.length)
})

test('角色通知在途断开后退出必须等待投递回执落盘，密钥迟到不重建连接', async () => {
  const fixture = workspaceFixture({ persistRun: false })
  const a = addWaitingRoleRun({ fixture, binding: syntheticBinding('a') })

  const service = new WorkspaceService({
    store: fixture.store,
    dataDirectory: 'unused',
  })

  let release!: (id: string) => void
  let started = false

  const runtime = new RoleFeishuRuntime({
    store: fixture.store,
    service,
    credentials: async () => 'synthetic-only',
    factory: () => ({
      start: async () => {},
      close: () => {},
      state: () => 'connected',
      send: () => {
        started = true
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
      update: async () => {},
    }),
  })

  try {
    await runtime.connect({ roleId: a.role.id, expectedRoleVersion: 1 })
    for (let index = 0; index < 100 && !started; index++) await delay(20)
    assert.equal(started, true)
    runtime.close()
    let drained = false

    const draining = runtime.drain().then(() => {
      drained = true
    })

    await delay(10)
    assert.equal(drained, false)
    release('om_synthetic_late')
    await draining
    assert.equal(
      fixture.database
        .prepare('SELECT message_id FROM role_feishu_messages')
        .get()?.message_id,
      'om_synthetic_late',
    )
    let releaseSecret!: (value: string) => void
    let factories = 0

    const late = new RoleFeishuRuntime({
      store: fixture.store,
      service,
      credentials: () =>
        new Promise<string>((resolve) => {
          releaseSecret = resolve
        }),
      factory: () => {
        factories++
        throw new Error('must not reconnect')
      },
    })

    const connecting = late.connect({
      roleId: a.role.id,
      expectedRoleVersion: 1,
    })

    late.close()
    releaseSecret('synthetic-delayed-secret')
    await connecting
    await late.drain()
    assert.equal(factories, 0)
  } finally {
    runtime.close()
    await runtime.drain()
    await service.shutdown()
    fixture.database.close()
  }
})

test('同角色应用hex大小写变体复用一条连接槽，不产生两个认证消费者', async () => {
  const fixture = workspaceFixture({ persistRun: false })
  const a = addWaitingRoleRun({ fixture, binding: syntheticBinding('a') })

  const service = new WorkspaceService({
    store: fixture.store,
    dataDirectory: 'unused',
  })

  let starts = 0
  let closes = 0

  const runtime = new RoleFeishuRuntime({
    store: fixture.store,
    service,
    credentials: async () => 'synthetic-only',
    factory: () => ({
      start: async () => {
        starts++
      },
      close: () => {
        closes++
      },
      state: () => 'connected',
      send: async () => 'om_synthetic',
      update: async () => {},
    }),
  })

  try {
    await runtime.connect({ roleId: a.role.id, expectedRoleVersion: 1 })
    fixture.store.transaction(() =>
      fixture.store.addRole({
        ...a.role,
        version: 2,
        feishuBinding: {
          ...a.binding,
          id: randomUUID(),
          appId: 'cli_AAAAAAAAAAAAAAAA',
        },
      }),
    )
    await runtime.connect({ roleId: a.role.id, expectedRoleVersion: 2 })
    assert.equal(runtime.status(a.role.id).connections.length, 1)
    assert.equal(starts, 2)
    assert.equal(closes, 1)
  } finally {
    runtime.close()
    await runtime.drain()
    await service.shutdown()
    fixture.database.close()
  }
  assert.equal(closes, starts)
})
