import { createHash } from 'node:crypto'
import type { WorkspaceStore } from './workspace-store.js'
import { FeishuStore } from './feishu-store.js'
import type { FeishuBinding } from './feishu-contracts.js'
import type { FeishuTransport } from './feishu-transport.js'
import { taskStatusCard } from './feishu-card.js'

/** 每次只投递一项；业务提交早于网络，失败重启后从持久投影游标对账。 */
export const flushFeishuNotification = async (options: {
  store: WorkspaceStore
  binding: FeishuBinding
  transport: FeishuTransport
}): Promise<void> => {
  const channel = new FeishuStore(options.store)
  const pending = nextNotification(channel, options.binding)
  if (!pending) return

  const current = notificationContent(
    options.store,
    options.binding,
    pending.taskId,
  )

  if (pending.messageId) {
    await options.transport.update({
      messageId: pending.messageId,
      content: current,
    })
    channel.delivered({
      ...pending,
      bindingVersion: options.binding.version,
      messageId: pending.messageId,
    })
    return
  }

  const content = channel.createContent({
    ...pending,
    bindingVersion: options.binding.version,
    content: current,
  })

  const uuid = createHash('sha256')
    .update(
      `${options.binding.id}:${options.binding.version}:${pending.taskId}`,
    )
    .digest('hex')
    .slice(0, 50)

  const messageId = await options.transport.send({
    chatId: options.binding.chatId,
    content,
    uuid,
  })

  // 若重发使用的是旧正文，保留旧游标，下一轮补发最新状态至同一消息。
  channel.delivered({
    bindingVersion: options.binding.version,
    taskId: pending.taskId,
    sequence: content === current ? pending.sequence : 0,
    messageId,
  })
}

const nextNotification = (channel: FeishuStore, binding: FeishuBinding) => {
  const pending = channel.pending(binding, true)[0]
  if (!pending && channel.pending(binding).length)
    throw new Error('FEISHU_DELIVERY_UNCERTAIN')
  return pending
}

const notificationContent = (
  store: WorkspaceStore,
  binding: FeishuBinding,
  taskId: string,
): string => {
  const snapshot = store.snapshot()
  const task = snapshot.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('NOT_FOUND')
  const run = snapshot.runs.filter((item) => item.taskId === task.id).at(-1)

  const request = snapshot.humanRequests
    .filter((item) => item.runId === run?.id)
    .at(-1)

  return JSON.stringify(
    taskStatusCard({
      task,
      ...(run ? { run } : {}),
      ...(request ? { request } : {}),
      bindingVersion: binding.version,
    }),
  )
}
