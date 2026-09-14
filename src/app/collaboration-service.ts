// 协作派发服务：登记 inbox → 发协作卡片 → @ 目标 bot，三步全成才算派发完成。
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Bot } from '../im/lark.js'
import { buildCollaborationCard } from '../im/card.js'
import { getBotModelDisplayName, type BotConfig } from '../core/bot-registry.js'
import type { CollaborationMessage } from '../core/collaboration.js'
import { sessionLimitTracker } from '../core/session-limit-tracker.js'
import type { AppRuntime } from './runtime.js'

export interface CollaborationDispatch {
  senderConfig: BotConfig
  senderBot: Bot
  // 有原消息就回复到话题里；没有（例如定时任务触发）就填 chatId 直接发群
  replyToMessageId?: string
  chatId?: string
  // 只要 @ 通知、不要协作卡片时置 true，必须配合 chatId
  skipCard?: boolean
  targetBotId: string
  taskId: string
  ownerOpenId: string
  ownerUnionId?: string
  reportToBotId: string
  objective: string
  instruction: string
  expectedOutput?: string
  round: number
  maxRounds: number
  workspaceDir: string
}

export class CollaborationService {
  constructor(private readonly runtime: AppRuntime) {}

  async dispatch(options: CollaborationDispatch): Promise<void> {
    let effectiveTargetBotId = options.targetBotId
    let effectiveInstruction = options.instruction

    // 如果目标 bot 当前受限，在同组中寻找可用的备用成员进行自动转派
    if (sessionLimitTracker.isLimited(effectiveTargetBotId)) {
      const availableFallbacks = this.runtime.teamRegistry
        .getAvailableFallbackMembers(effectiveTargetBotId)
        .filter((cfg) => this.runtime.botRuntimes.has(cfg.id))

      if (availableFallbacks.length > 0) {
        const fallback = availableFallbacks[0]
        const fallbackModel = getBotModelDisplayName(fallback)
        console.log(
          `[协作] 检测到 ${effectiveTargetBotId} 受限，自动转派至同组备用成员 ${fallback.id} (${fallbackModel})`,
        )
        effectiveTargetBotId = fallback.id
        effectiveInstruction = `【系统提示：原定成员 ${options.targetBotId} 当前触发会话限额，任务已由 CEO 助理转派由同组备用成员 ${fallback.id} (${fallbackModel}) 接替推进】\n\n【极简续跑与节省 Token 规则】：\n1. 继承现场：前序成员已在当前工作区 (${options.workspaceDir}) 完成了部分改动与文件编写。\n2. 避免重复劳动：直接基于当前工作区文件现场继续推进，不要从零重写已有代码，开始前可简要查看文件（如 git status）确认进度。\n3. 独立推进与验证：在当前会话中完成剩余目标，所有测试与验证命令必须在前台同步执行并等待结果。\n4. 精炼交付：完成后提供简要说明并交回 CEO 助理。\n\n${options.instruction}`
      }
    }

    if (sessionLimitTracker.isLimited(effectiveTargetBotId)) {
      const targetConfig = this.runtime.teamRegistry.get(options.targetBotId)
      const groupName = targetConfig?.group ?? options.targetBotId
      const resetInfo = sessionLimitTracker.getLimitInfo(options.targetBotId)
      throw new Error(
        `分组 "${groupName}" 内所有成员均处于会话限额状态${resetInfo.resetsText ? `（预计 ${resetInfo.resetsText} 重置）` : ''}，无法派发。请直接向用户汇报并确认下一步。`,
      )
    }

    const target = this.runtime.botRuntimes.get(effectiveTargetBotId)
    if (!target) throw new Error(`协作 bot 尚未就绪: ${effectiveTargetBotId}`)
    const reportTo = this.runtime.botRuntimes.get(options.reportToBotId)
    if (!reportTo)
      throw new Error(`结果接收 bot 尚未就绪: ${options.reportToBotId}`)

    const collaboration: CollaborationMessage = {
      dispatchId: randomUUID().replaceAll('-', '').slice(0, 12),
      taskId: options.taskId,
      ownerOpenId: options.ownerOpenId,
      ownerUnionId: options.ownerUnionId,
      fromBotId: options.senderConfig.id,
      toBotId: effectiveTargetBotId,
      reportToBotId: options.reportToBotId,
      objective: options.objective,
      instruction: effectiveInstruction,
      expectedOutput: options.expectedOutput,
      round: options.round,
      maxRounds: options.maxRounds,
      workspaceDir: options.workspaceDir,
    }

    this.runtime.collaborationInbox.register(collaboration)

    try {
      if (options.chatId && options.skipCard) {
        // 不发卡片时，任务详情只能塞进这条 @ 正文里
        const mentionText = [
          `新的协作任务：${options.objective}`,
          options.instruction,
          options.expectedOutput ? `期望产出：${options.expectedOutput}` : '',
          `任务编号：${collaboration.dispatchId}`,
        ]
          .filter(Boolean)
          .join('\n')

        const mentionMessageId = await options.senderBot.sendMentionToChat(
          options.chatId,
          target.identity,
          mentionText,
        )

        if (!mentionMessageId) {
          throw new Error('飞书没有返回协作通知 message_id')
        }
      } else {
        const collaborationCard = buildCollaborationCard({
          senderName:
            this.runtime.botRuntimes.get(options.senderConfig.id)?.identity
              .name ?? options.senderConfig.id,
          targetName: target.identity.name,
          reportToName: reportTo.identity.name,
          workspaceName: basename(options.workspaceDir),
          objective: options.objective,
          instruction: options.instruction,
          expectedOutput: options.expectedOutput,
          round: options.round,
          maxRounds: options.maxRounds,
        })

        const cardMessageId = options.chatId
          ? await options.senderBot.sendCardToChat(
              options.chatId,
              collaborationCard,
            )
          : await options.senderBot.replyCard(
              options.replyToMessageId!,
              collaborationCard,
              true,
            )

        if (!cardMessageId) {
          throw new Error('飞书没有返回协作卡片 message_id')
        }

        const mentionText =
          options.round === 1
            ? `新的协作任务：${options.objective}（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
            : `协作结果已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`

        // 发群时 @ 挂在群里，回复时 @ 挂在刚发出的卡片下，保证顺序相邻
        const mentionMessageId = options.chatId
          ? await options.senderBot.sendMentionToChat(
              options.chatId,
              target.identity,
              mentionText,
            )
          : await options.senderBot.replyMention(
              cardMessageId,
              target.identity,
              mentionText,
              true,
            )

        if (!mentionMessageId) {
          throw new Error('飞书没有返回协作通知 message_id')
        }
      }
    } catch (error) {
      // 卡片或 @ 通知失败就撤销 inbox 登记，否则这条协作永远等不到目标 bot 回话
      this.runtime.collaborationInbox.consume(
        collaboration.dispatchId,
        collaboration.toBotId,
      )
      throw error
    }
    console.log(
      `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
    )
  }
}
