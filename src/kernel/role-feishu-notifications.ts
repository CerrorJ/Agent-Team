import { createHash } from 'node:crypto'
import type { WorkspaceStore } from './workspace-store.js'
import type { FeishuBinding } from './feishu-contracts.js'
import type { FeishuTransport } from './feishu-transport.js'
import { taskStatusCard } from './feishu-card.js'
import { RoleFeishuStore } from './role-feishu-store.js'
import { runSchema, taskSchema } from './business-contracts.js'
import { HumanStore } from './human-store.js'

/** 一个Run一张卡，按该Run固定的应用和会话投递，不能从最新角色倒推历史路由。 */
export const flushRoleFeishuNotification = async (input: {
  store: WorkspaceStore
  binding: FeishuBinding
  transport: FeishuTransport
}): Promise<void> => {
  const channel = new RoleFeishuStore(input.store)
  const pending = channel.pending(input.binding, true)[0]
  if (!pending) {
    if (channel.pending(input.binding).length)
      throw new Error('FEISHU_DELIVERY_UNCERTAIN')
    return
  }
  const current = contentForRun(input.store, input.binding, pending.runId)
  if (pending.messageId) {
    await input.transport.update({
      messageId: pending.messageId,
      content: current,
    })
    channel.delivered({
      ...pending,
      bindingId: input.binding.id,
      messageId: pending.messageId,
    })
    return
  }

  const content = channel.createContent({
    ...pending,
    bindingId: input.binding.id,
    content: current,
  })

  const uuid = createHash('sha256')
    .update(`${input.binding.id}:${pending.runId}`)
    .digest('hex')
    .slice(0, 50)

  const messageId = await input.transport.send({
    chatId: input.binding.chatId,
    content,
    uuid,
  })

  channel.delivered({
    ...pending,
    bindingId: input.binding.id,
    messageId,
    sequence: content === current ? pending.sequence : 0,
  })
}

const contentForRun = (
  store: WorkspaceStore,
  binding: FeishuBinding,
  runId: string,
): string => {
  const run = store.get('runs', runId, runSchema)
  if (run.roleSnapshot.feishuBinding?.id !== binding.id)
    throw new Error('FEISHU_IDENTITY_MISMATCH')
  const task = store.get('tasks', run.taskId, taskSchema)

  const request = new HumanStore(store)
    .list()
    .filter((item) => item.runId === runId)
    .at(-1)

  return JSON.stringify(
    taskStatusCard({
      task,
      run,
      ...(request ? { request } : {}),
      bindingVersion: binding.version,
      bindingId: binding.id,
    }),
  )
}
