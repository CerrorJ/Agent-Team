import { createHash } from 'node:crypto'

// 飞书消息里可用的"话题"定位字段：话题内消息优先 threadId，
// 非话题的回复用 rootId（根消息），裸消息只能退回自身 messageId
export interface TopicAddress {
  messageId: string
  chatId: string
  threadId: string
  rootId: string
}

export const topicIdOf = (message: TopicAddress): string => {
  return message.threadId || message.rootId || message.messageId
}

// chatId + 话题 ID 哈希成稳定的短任务 ID：同一话题始终归到同一个任务
export const topicTaskId = (message: TopicAddress): string => {
  return createHash('sha256')
    .update(`${message.chatId}:${topicIdOf(message)}`)
    .digest('hex')
    .slice(0, 24)
}
