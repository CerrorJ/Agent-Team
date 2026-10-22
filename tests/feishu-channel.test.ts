import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  localKernelFixture,
  waitForRun,
} from './helpers/local-kernel-fixture.js'
import { enableTestRole } from './helpers/team-fixture.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { FeishuStore } from '../src/kernel/feishu-store.js'
import { flushFeishuNotification } from '../src/kernel/feishu-notifications.js'
import type { FeishuTransport } from '../src/kernel/feishu-transport.js'
import { fulfillTrial } from './helpers/role-trial-fixture.js'
import { taskSchema } from '../src/kernel/business-contracts.js'
import { taskStatusCard } from '../src/kernel/feishu-card.js'
import { humanRequestSchema } from '../src/kernel/human-contracts.js'

const bindingCommand = () => ({
  type: 'feishu.save' as const,
  expectedVersion: 0,
  appId: 'cli_test',
  tenantKey: 'synthetic-tenant',
  ownerOpenId: 'ou_owner',
  chatId: 'oc_test',
  credentialRef: `feishu-${randomUUID()}`,
  enabled: true,
})

test('渠道端口集成：认证身份、同一人工用例、重复事件与旧卡片；不冒充真实租户验收', async () => {
  let callback: ((raw: unknown) => unknown) | undefined
  let cliCalls = 0
  let closes = 0

  const fixture = await localKernelFixture(
    async (options) => {
      const trial = fulfillTrial(options)
      if (trial) return trial
      cliCalls++
      return {
        answer: '',
        sessionId: randomUUID(),
        toolCalls: [
          {
            toolUseId: randomUUID(),
            toolName: 'request_plan_review',
            input: { title: '合成方案', summary: '等待真实所有者决定' },
          },
        ],
      }
    },
    {
      feishuCredentials: async (binding) => {
        assert.equal(binding.appId, 'cli_test')
        return 'synthetic-secret'
      },
      feishuTransport: (options) => {
        callback = options.onAction
        assert.equal(options.secret, 'synthetic-secret')
        return {
          start: async () => {},
          close: () => {
            closes++
          },
          state: () => 'connected',
          send: async () => 'om_test',
          update: async () => {},
        }
      },
    },
  )

  try {
    await fixture.command(bindingCommand())
    const roleId = await enableTestRole(fixture, '端口测试者')

    const taskId = await fixture.command({
      type: 'task.create',
      projectId: fixture.projectId,
      roleId,
      title: '跨渠道端口',
      goal: '先请求方案',
      acceptanceCriteria: '不能以消息另建业务状态',
    })

    const runId = await fixture.command({
      type: 'run.start',
      taskId,
      expectedVersion: 1,
    })

    assert.equal(
      (await waitForRun(fixture.kernel, runId)).status,
      'waiting_approval',
    )

    const connect = await fixture.kernel.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'feishu.connect',
    })

    assert.equal(connect.status, 'completed')
    const request = (await fixture.snapshot()).humanRequests[0]!

    const event = {
      event_id: 'synthetic-event',
      app_id: 'cli_test',
      tenant_key: 'synthetic-tenant',
      operator: { open_id: 'ou_owner', tenant_key: 'synthetic-tenant' },
      context: { open_chat_id: 'oc_test' },
      action: {
        value: {
          bindingVersion: 1,
          requestId: request.id,
          expectedVersion: request.version,
          expectedDigest: request.digest,
          decision: 'rejected',
        },
        form_value: { reason: '合成拒绝原因' },
      },
    }

    const invoke = (raw: unknown) =>
      callback!(raw) as { toast: { type: string } }

    assert.equal(
      invoke({ ...event, operator: { ...event.operator, open_id: 'ou_other' } })
        .toast.type,
      'error',
    )
    assert.equal((await fixture.snapshot()).humanRequests[0]!.status, 'pending')
    assert.equal(invoke(event).toast.type, 'success')
    assert.equal(invoke(event).toast.type, 'success')
    assert.equal(
      invoke({ ...event, event_id: 'different-event' }).toast.type,
      'error',
    )
    const state = await fixture.snapshot()
    assert.equal(state.humanRequests[0]!.actor?.channel, 'feishu')
    assert.equal(state.humanRequests[0]!.resolutionReason, '合成拒绝原因')
    assert.equal(state.runs.find((run) => run.id === runId)!.status, 'failed')
    assert.equal(cliCalls, 1)
    const bound = state.feishuBinding!
    await fixture.command({
      ...bindingCommand(),
      expectedVersion: bound.version,
    })
    assert.equal(invoke(event).toast.type, 'error')
    assert.ok(closes > 0)
  } finally {
    await fixture.cleanup()
  }
})

test('持久通知：网络结果未知后固定正文/uuid重发，随后补齐新状态；超出去重期限不盲发', async () => {
  const fixture = workspaceFixture()
  const channel = new FeishuStore(fixture.store)
  fixture.store.transaction(() => channel.save(bindingCommand()))
  const binding = channel.binding()!
  const sends: { chatId: string; content: string; uuid: string }[] = []
  const updates: string[] = []

  const transport: FeishuTransport = {
    start: async () => {},
    close: () => {},
    state: () => 'connected',
    send: async (input) => {
      sends.push(input)
      if (sends.length === 1) throw new Error('NETWORK_UNKNOWN')
      return 'om_synthetic'
    },
    update: async (input) => {
      updates.push(input.content)
    },
  }

  try {
    const options = { store: fixture.store, binding, transport }
    await assert.rejects(flushFeishuNotification(options), /NETWORK_UNKNOWN/)
    const task = fixture.store.get('tasks', fixture.run.taskId, taskSchema)
    fixture.store.transaction(() =>
      fixture.store.updateTask({
        ...task,
        version: 2,
        title: '网络期间新标题',
      }),
    )
    await flushFeishuNotification(options)
    assert.deepEqual(sends[0], sends[1])
    await flushFeishuNotification(options)
    assert.equal(updates.length, 1)
    assert.match(updates[0]!, /网络期间新标题/)
    assert.equal(channel.pending(binding).length, 0)
    fixture.database
      .prepare(
        'UPDATE feishu_messages SET message_id=NULL,sequence=0,create_started_at=?',
      )
      .run(new Date(Date.now() - 56 * 60 * 1000).toISOString())
    await assert.rejects(
      flushFeishuNotification(options),
      /FEISHU_DELIVERY_UNCERTAIN/,
    )
    assert.equal(sends.length, 2)
  } finally {
    fixture.database.close()
  }
})

test('卡片仅展示共享状态，未提供自动答案或任意命令入口', () => {
  const fixture = workspaceFixture()
  try {
    const task = fixture.store.get('tasks', fixture.run.taskId, taskSchema)
    const card = taskStatusCard({ task, run: fixture.run, bindingVersion: 1 })
    assert.equal(card.schema, '2.0')
    assert.match(JSON.stringify(card), /执行成功与验收分开/)
    assert.equal(JSON.stringify(card).includes('shell'), false)

    const request = humanRequestSchema.parse({
      id: randomUUID(),
      version: 1,
      runId: fixture.run.id,
      taskId: task.id,
      projectId: task.projectId,
      segmentId: randomUUID(),
      payload: { kind: 'plan', title: '长方案', summary: '文'.repeat(4000) },
      digest: 'a'.repeat(64),
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      decidedAt: null,
      decision: null,
      actor: null,
    })

    const longCard = JSON.stringify(
      taskStatusCard({ task, run: fixture.run, request, bindingVersion: 1 }),
    )

    assert.equal(longCard.includes('"tag":"form"'), false)
    assert.match(longCard, /在纬舟桌面完整查看/)
  } finally {
    fixture.database.close()
  }
})
