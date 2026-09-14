import { z } from 'zod'

// 程序内部的交接单，taskId 标识整项协作，dispatchId 则标识当前这一次投递。
export interface CollaborationMessage {
  dispatchId: string
  taskId: string
  ownerOpenId: string
  ownerUnionId?: string
  fromBotId: string
  toBotId: string
  reportToBotId: string
  objective: string
  instruction: string
  expectedOutput?: string
  // 当前是 bot 之间第几次交接；用户发起任务不计入轮次
  round: number
  // 轮次上限，到达后结果不再回传，协作收尾
  maxRounds: number
  workspaceDir: string
}

export interface CollaborationOrigin {
  taskId: string
  fromBotId: string
  reportToBotId: string
  round: number
  maxRounds: number
}

export const DispatchTaskRequestSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  objective: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(2_000),
  expectedOutput: z.string().trim().min(1).max(500).optional(),
})

export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>

export const findDispatchTaskRequest = (
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): DispatchTaskRequest | undefined => {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index]
    if (call?.toolName !== 'dispatch_task') continue
    const parsed = DispatchTaskRequestSchema.safeParse(call.input)
    if (parsed.success) return parsed.data
  }
  return undefined
}

export const collaborationOrigin = (
  message: CollaborationMessage,
): CollaborationOrigin => {
  return {
    taskId: message.taskId,
    fromBotId: message.fromBotId,
    reportToBotId: message.reportToBotId,
    round: message.round,
    maxRounds: message.maxRounds,
  }
}

export const buildCollaborationPrompt = (
  message: CollaborationMessage,
): string => {
  return [
    `协作目标：${message.objective}`,
    `执行要求：${message.instruction}`,
    message.expectedOutput ? `期望产出：${message.expectedOutput}` : '',
    `完成后，把结果交回 ${message.reportToBotId} 继续组织后续工作；已经可以交付时，明确给出最终结论。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// 飞书可能重推同一条消息，用本次投递唯一的 dispatchId 做去重键。
// taskId 是话题级标识，新的协作会在同一话题里重新从第 1 轮开始；
// 因此不能用「任务 + 轮次 + 接收方」，否则会误拦截后续的新派发。
export const collaborationTurnKey = (message: CollaborationMessage): string => {
  return message.dispatchId
}

// CollaborationInbox 只做两件事：发送前用 register() 登记，目标 bot 收到任务编号后用 consume() 领取。领取时还会核对目标 bot，成功后立即删除。同一条派活消息不会再次执行，并发交接也不会互相覆盖。
export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>()

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message)
  }

  peek(dispatchId: string): CollaborationMessage | undefined {
    return this.messages.get(dispatchId)
  }

  consume(
    dispatchId: string,
    toBotId: string,
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId)
    if (!message || message.toBotId !== toBotId) return undefined
    this.messages.delete(dispatchId)
    return message
  }
}
