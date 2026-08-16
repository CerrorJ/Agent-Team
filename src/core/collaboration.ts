// 程序内部的交接单，taskId 标识整项协作，dispatchId 则标识当前这一次投递。
export interface CollaborationMessage {
  dispatchId: string
  taskId: string
  fromBotId: string
  toBotId: string
  round: number // 当前是 bot 之间第几次交接；用户发起任务不计入轮次
  maxRounds: number // 轮次上限，到达后结果不再回传，协作收尾
  workspaceDir: string
  prompt: string
}

// 飞书可能重推同一条消息，用「任务 + 轮次 + 接收方」做去重键；
// 键里带 round，领取过上一轮不会挡住下一轮的新交接
export const collaborationTurnKey = (message: CollaborationMessage): string =>
  `${message.taskId}:${message.round}:${message.toBotId}`

// CollaborationInbox 只做两件事：发送前用 register() 登记，目标 bot 收到任务编号后用 consume() 领取。领取时还会核对目标 bot，成功后立即删除。同一条派活消息不会再次执行，并发交接也不会互相覆盖。
export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>()

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message)
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
