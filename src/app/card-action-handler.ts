import type { Bot, CardAction, CardActionResponse } from '../im/lark.js'
import {
  buildApprovalContinuingCard,
  buildApprovalDecidedCard,
  buildBotModelConfigCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClosedBotModelConfigCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildResumeCard,
} from '../im/card.js'
import type { BotConfig, ProductDeliveryMode } from '../core/bot-registry.js'
import {
  checkModelConfigAccess,
  validateThinkingLevel,
} from '../core/model-config-store.js'
import { isClarificationOwner } from '../core/clarification.js'
import { isProductSpecOwner } from '../core/product-spec.js'
import type { ApprovalFlow } from '../core/approval.js'
import { requestTaskAbort } from '../core/task-abort.js'
import type { CliId } from '../cli/types.js'
import { getCliAdapter } from '../cli/registry.js'
import { listNativeCliSessions } from '../cli/native-sessions.js'
import { continueClarificationFlow } from './clarification-runner.js'
import { continueApprovalFlow } from './approval-runner.js'
import { fetchAvailableModels } from '../core/model-fetcher.js'
import type { CollaborationService } from './collaboration-service.js'
import type { AppRuntime } from './runtime.js'

export const scheduleApprovalContinuation = async (options: {
  runtime: AppRuntime
  config: BotConfig
  flow: ApprovalFlow
  bot: Bot
}): Promise<void> => {
  const { runtime, config, flow, bot } = options
  const session = runtime.sessions.get(flow.sessionId)
  if (!session || session.status === 'closed') {
    throw new Error('对应的 CLI 会话已经失效。')
  }
  if (session.status === 'active') {
    throw new Error('当前会话仍在执行，请稍后重试。')
  }
  await runtime.sessions.transition(session.id, 'active')
  const run = new AbortController()
  runtime.activeRuns.set(session.id, {
    controller: run,
    ownerOpenId: flow.ownerOpenId,
  })
  queueMicrotask(() => {
    void continueApprovalFlow({
      runtime,
      bot,
      config,
      flow,
      run,
    }).catch((error) => {
      console.error('[审批] 继续执行失败:', (error as Error).message)
    })
  })
}

export const createCardActionHandler = (options: {
  runtime: AppRuntime
  config: BotConfig
  collaborationService: CollaborationService
  defaultProductDeliveryMode: ProductDeliveryMode
}): ((action: CardAction) => Promise<CardActionResponse | undefined>) => {
  const { runtime, config, collaborationService, defaultProductDeliveryMode } =
    options

  return async (action) => {
    if (action.value.action === 'approve_product_spec') {
      const flowToken =
        typeof action.value.flowToken === 'string' ? action.value.flowToken : ''

      const flow = runtime.productSpecFlows.get(flowToken)
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } }
      }
      if (flow.status === 'expired') {
        return {
          toast: { type: 'warning', content: '这份产品方案已经失效。' },
          card: {
            type: 'raw',
            data: buildProductSpecExpiredCard(flow),
          },
        }
      }
      if (flow.status === 'approved') {
        return {
          toast: { type: 'info', content: '产品方案已经确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(flow),
          },
        }
      }
      if (!isProductSpecOwner(flow, action)) {
        return {
          toast: { type: 'warning', content: '只有任务发起人可以确认。' },
        }
      }
      const approved = runtime.productSpecFlows.approve(flowToken)
      if (!approved) {
        return { toast: { type: 'warning', content: '方案状态已经更新。' } }
      }
      if (approved.collaboration) {
        const botRuntime = runtime.botRuntimes.get(config.id)
        if (!botRuntime) {
          return { toast: { type: 'error', content: '当前 Bot 尚未就绪。' } }
        }
        const collaboration = approved.collaboration

        const productDescription =
          approved.request.deliveryMode === 'lark-doc'
            ? `文档 URL：${approved.request.documentUrl}`
            : `Spec：${approved.request.specPath}\nTickets：${approved.request.ticketsPath}`

        try {
          await collaborationService.dispatch({
            senderConfig: config,
            senderBot: botRuntime.bot,
            replyToMessageId: action.messageId,
            targetBotId: collaboration.reportToBotId,
            taskId: collaboration.taskId,
            ownerOpenId: approved.ownerOpenId,
            ownerUnionId: approved.ownerUnionId,
            reportToBotId: collaboration.reportToBotId,
            objective: `产品方案已确认：${approved.request.title}`,
            instruction: [
              `${config.role} 已经完成产品方案，用户确认通过。`,
              `方案标题：${approved.request.title}`,
              `方案摘要：${approved.request.summary}`,
              productDescription,
              `确认记录：${approved.approvedAt ?? ''}`,
              '请基于这份已确认方案继续组织后续工作：需要开发者实现时，使用 dispatch_task 把方案交给 developer。',
            ].join('\n\n'),
            expectedOutput:
              '继续推进原任务，或在已经完成时向用户给出最终结论。',
            round: collaboration.round + 1,
            maxRounds: collaboration.maxRounds,
            workspaceDir:
              runtime.sessions.get(approved.sessionId)?.workspaceDir ??
              config.workspaceDir,
          })
        } catch (error) {
          return {
            toast: {
              type: 'error',
              content: `确认结果交回失败：${(error as Error).message}`,
            },
          }
        }
      }
      return {
        toast: { type: 'success', content: '产品方案已确认。' },
        card: {
          type: 'raw',
          data: buildProductSpecApprovedCard(approved),
        },
      }
    }

    if (action.value.action === 'answer_clarification') {
      const flowToken =
        typeof action.value.flowToken === 'string' ? action.value.flowToken : ''

      const questionId =
        typeof action.value.questionId === 'string'
          ? action.value.questionId
          : ''

      const flow = runtime.clarificationFlows.get(flowToken)
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这组澄清问题已经失效。' } }
      }
      if (!isClarificationOwner(flow, action)) {
        return {
          toast: { type: 'warning', content: '只有任务发起人可以回答。' },
        }
      }

      const question = flow.request.questions[flow.currentIndex]
      if (!question || question.id !== questionId) {
        return {
          toast: {
            type: 'warning',
            content: '问题已经更新，请按当前卡片作答。',
          },
        }
      }

      // decisionMode 走「按推荐作答」通道：current 只作答本题，remaining 采纳剩余全部
      const decisionMode =
        action.value.decisionMode === 'current' ||
        action.value.decisionMode === 'remaining'
          ? action.value.decisionMode
          : undefined

      let answered
      if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(
          flowToken,
          decisionMode === 'remaining',
        )
      } else {
        const custom = action.value.custom === true

        const optionId =
          typeof action.value.optionId === 'string' ? action.value.optionId : ''

        const selectedOption = question.options.find(
          (option) => option.id === optionId,
        )

        const customAnswer =
          typeof action.formValue.custom_answer === 'string'
            ? action.formValue.custom_answer.trim()
            : ''

        const answer = custom ? customAnswer : (selectedOption?.label ?? '')
        if (!answer) {
          return {
            toast: {
              type: 'warning',
              content: custom ? '请先输入你的答案。' : '这个选项已经失效。',
            },
          }
        }
        answered = runtime.clarificationFlows.answer(
          flowToken,
          questionId,
          answer,
        )
      }
      if (!answered) {
        return { toast: { type: 'warning', content: '答案没有保存，请重试。' } }
      }
      if (!answered.complete) {
        return {
          toast: { type: 'success', content: '已记录，继续下一题。' },
          card: {
            type: 'raw',
            data: buildClarificationCard({ flow: answered.flow }),
          },
        }
      }

      const session = runtime.sessions.get(answered.flow.sessionId)
      const botRuntime = runtime.botRuntimes.get(config.id)
      if (!session || !botRuntime || session.status === 'closed') {
        return {
          toast: { type: 'error', content: '对应的 CLI 会话已经失效。' },
        }
      }
      if (session.status === 'active') {
        return {
          toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' },
        }
      }

      try {
        await runtime.sessions.transition(session.id, 'active')
        const run = new AbortController()
        runtime.activeRuns.set(session.id, {
          controller: run,
          ownerOpenId: answered.flow.ownerOpenId,
        })
        runtime.clarificationFlows.delete(flowToken)
        // 先把 toast + 过渡卡片返回给飞书，CLI 续跑放进微任务，别拖住卡片回调
        queueMicrotask(() => {
          void continueClarificationFlow({
            runtime,
            bot: botRuntime.bot,
            config,
            flow: answered.flow,
            run,
            defaultDeliveryMode: defaultProductDeliveryMode,
          }).catch((error) => {
            console.error('[澄清] 继续执行失败:', (error as Error).message)
          })
        })
        return {
          toast: { type: 'success', content: '答案已收到。' },
          card: {
            type: 'raw',
            data: buildClarificationContinuingCard(answered.flow),
          },
        }
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } }
      }
    }

    if (action.value.action === 'decide_approval') {
      const flowToken =
        typeof action.value.flowToken === 'string' ? action.value.flowToken : ''

      const decision = action.value.decision === 'reject' ? 'reject' : 'approve'
      const flow = runtime.approvalFlows.get(flowToken)
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份审批请求已经失效。' } }
      }
      if (flow.status !== 'pending') {
        return {
          toast: { type: 'info', content: '这份审批已经处理过。' },
          card: {
            type: 'raw',
            data: buildApprovalDecidedCard(flow),
          },
        }
      }
      if (new Date(flow.expiresAt).getTime() < Date.now()) {
        const expired = runtime.approvalFlows.expire(flowToken)
        const botRuntime = runtime.botRuntimes.get(config.id)
        if (expired && botRuntime) {
          try {
            await scheduleApprovalContinuation({
              runtime,
              config,
              flow: expired,
              bot: botRuntime.bot,
            })
          } catch (error) {
            console.error('[审批] 超时收束失败:', (error as Error).message)
          }
        }
        return {
          toast: { type: 'warning', content: '审批已超时，按拒绝处理。' },
          card: {
            type: 'raw',
            data: buildApprovalDecidedCard(expired ?? flow),
          },
        }
      }
      if (!action.operatorOpenId) {
        return {
          toast: { type: 'warning', content: '无法识别操作者，无法审批。' },
        }
      }

      const resolved = runtime.approvalFlows.resolve(
        flowToken,
        decision === 'approve' ? 'approved' : 'rejected',
      )

      if (!resolved) {
        return { toast: { type: 'warning', content: '审批状态已经更新。' } }
      }
      const botRuntime = runtime.botRuntimes.get(config.id)
      if (!botRuntime) {
        return { toast: { type: 'error', content: '当前 Bot 尚未就绪。' } }
      }
      try {
        await scheduleApprovalContinuation({
          runtime,
          config,
          flow: resolved,
          bot: botRuntime.bot,
        })
        return {
          toast: {
            type: 'success',
            content: decision === 'approve' ? '已放行。' : '已拒绝。',
          },
          card: {
            type: 'raw',
            data: buildApprovalContinuingCard(resolved),
          },
        }
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } }
      }
    }

    if (action.value.action === 'resume_cli_session') {
      const agentSessionId =
        typeof action.value.agentSessionId === 'string'
          ? action.value.agentSessionId
          : ''

      const cliSessionId =
        typeof action.value.cliSessionId === 'string'
          ? action.value.cliSessionId
          : ''

      const session = runtime.sessions.get(agentSessionId)
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: 'error', content: '这条会话记录已经失效。' } }
      }
      if (session.status === 'active') {
        return {
          toast: { type: 'warning', content: '当前任务结束后才能切换会话。' },
        }
      }
      if (session.status === 'closed') {
        return {
          toast: { type: 'warning', content: '当前话题的会话已经关闭。' },
        }
      }
      try {
        const cliAdapter = getCliAdapter(session.cliId)

        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        })

        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: {
              type: 'error',
              content: '这个 CLI 会话已经不在当前工作目录中。',
            },
          }
        }

        const updated = await runtime.sessions.setCliSessionId(
          session.id,
          cliSessionId,
        )

        return {
          toast: { type: 'success', content: '已切换到选中的历史会话。' },
          card: {
            type: 'raw',
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        }
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } }
      }
    }

    if (action.value.action === 'open_bot_model_config') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const targetBot = runtime.teamRegistry.members[0]
      if (!targetBot) {
        return {
          toast: { type: 'error', content: '未找到可配置的团队成员。' },
        }
      }

      const selectedCliId = targetBot.defaultCliId

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        selectedCliId,
      )

      return {
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId,
            effectiveConfig,
          }),
        },
      }
    }

    if (action.value.action === 'switch_bot_model_config') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const targetBotId =
        typeof action.value.targetBotId === 'string'
          ? action.value.targetBotId
          : (action.option ?? '')

      const targetBot = runtime.teamRegistry.members.find(
        (m) => m.id === targetBotId,
      )

      if (!targetBot) {
        return {
          toast: { type: 'error', content: '找不到选中的角色。' },
        }
      }

      const selectedCliId: CliId =
        action.value.targetCliId === 'codex' ||
        action.value.targetCliId === 'claude'
          ? (action.value.targetCliId as CliId)
          : targetBot.defaultCliId

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        selectedCliId,
      )

      return {
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId,
            effectiveConfig,
          }),
        },
      }
    }

    if (action.value.action === 'switch_bot_cli_tab') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const targetBotId =
        typeof action.value.targetBotId === 'string'
          ? action.value.targetBotId
          : ''

      const targetBot = runtime.teamRegistry.members.find(
        (m) => m.id === targetBotId,
      )

      if (!targetBot) {
        return {
          toast: { type: 'error', content: '找不到选中的角色。' },
        }
      }

      const selectedCliId: CliId =
        action.value.targetCliId === 'codex' ? 'codex' : 'claude'

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        selectedCliId,
      )

      return {
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId,
            effectiveConfig,
          }),
        },
      }
    }

    if (action.value.action === 'save_bot_model_config') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const botId =
        typeof action.value.botId === 'string' ? action.value.botId : ''

      const targetBot = runtime.teamRegistry.members.find((m) => m.id === botId)
      if (!targetBot) {
        return {
          toast: { type: 'error', content: '找不到目标角色。' },
        }
      }

      const cliId: CliId =
        action.value.cliId === 'codex'
          ? 'codex'
          : action.value.cliId === 'claude'
            ? 'claude'
            : targetBot.defaultCliId

      const baseUrl =
        typeof action.formValue.base_url === 'string'
          ? action.formValue.base_url.trim()
          : undefined

      const apiKey =
        typeof action.formValue.api_key === 'string'
          ? action.formValue.api_key.trim()
          : undefined

      const selectedModel =
        typeof action.formValue.model_select === 'string'
          ? action.formValue.model_select.trim()
          : ''

      const inputModel =
        typeof action.formValue.model === 'string'
          ? action.formValue.model.trim()
          : undefined

      const model = selectedModel || inputModel || undefined

      const thinkingLevel =
        typeof action.formValue.thinking_level === 'string'
          ? action.formValue.thinking_level.trim()
          : undefined

      if (thinkingLevel) {
        const validation = validateThinkingLevel(cliId, thinkingLevel)
        if (!validation.valid) {
          return {
            toast: {
              type: 'error',
              content: validation.error ?? '思考/推理等级参数非法。',
            },
          }
        }
      }

      await runtime.modelConfigStore.save(
        botId,
        cliId,
        { baseUrl, apiKey, model, thinkingLevel },
        runtime.teamRegistry.members,
      )

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        cliId,
      )

      const cliName = cliId === 'claude' ? 'Claude Code' : 'Codex'

      return {
        toast: {
          type: 'success',
          content: `${targetBot.id} 的 ${cliName} 配置已保存并立即生效！`,
        },
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId: cliId,
            effectiveConfig,
            statusNotice: `✅ ${targetBot.role} (${targetBot.id}) 的 ${cliName} 配置已保存并立即生效！`,
          }),
        },
      }
    }

    if (action.value.action === 'reset_bot_model_config') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const botId =
        typeof action.value.botId === 'string' ? action.value.botId : ''

      const targetBot = runtime.teamRegistry.members.find((m) => m.id === botId)
      if (!targetBot) {
        return {
          toast: { type: 'error', content: '找不到目标角色。' },
        }
      }

      const cliId: CliId =
        action.value.cliId === 'codex'
          ? 'codex'
          : action.value.cliId === 'claude'
            ? 'claude'
            : targetBot.defaultCliId

      await runtime.modelConfigStore.reset(
        botId,
        cliId,
        runtime.teamRegistry.members,
      )

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        cliId,
      )

      const cliName = cliId === 'claude' ? 'Claude Code' : 'Codex'

      return {
        toast: {
          type: 'info',
          content: `已恢复 ${targetBot.id} 的 ${cliName} 默认配置`,
        },
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId: cliId,
            effectiveConfig,
            statusNotice: `🔄 已恢复 ${targetBot.role} (${targetBot.id}) 的 ${cliName} 为默认配置`,
          }),
        },
      }
    }

    if (action.value.action === 'probe_bot_models') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const botId =
        typeof action.value.botId === 'string' ? action.value.botId : ''

      const targetBot = runtime.teamRegistry.members.find((m) => m.id === botId)
      if (!targetBot) {
        return {
          toast: { type: 'error', content: '找不到目标角色。' },
        }
      }

      const cliId: CliId =
        action.value.cliId === 'codex'
          ? 'codex'
          : action.value.cliId === 'claude'
            ? 'claude'
            : targetBot.defaultCliId

      const effectiveConfig = runtime.modelConfigStore.getEffectiveConfig(
        targetBot,
        cliId,
      )

      const savedCli = runtime.modelConfigStore.get(botId, cliId)
      const currentSavedBaseUrl = savedCli?.baseUrl ?? ''

      const typedBaseUrl =
        typeof action.formValue?.base_url === 'string'
          ? action.formValue.base_url.trim()
          : undefined

      const typedApiKey =
        typeof action.formValue?.api_key === 'string'
          ? action.formValue.api_key.trim()
          : undefined

      const hasUnsavedBaseUrl =
        typedBaseUrl !== undefined &&
        typedBaseUrl !== '' &&
        typedBaseUrl !== currentSavedBaseUrl

      const hasUnsavedApiKey = Boolean(typedApiKey)

      // 决定探测使用的 Base URL 和 API Key：优先使用表单中本次填写的草稿，未填写则回退已保存配置或全局配置
      const probeBaseUrl = typedBaseUrl || effectiveConfig.baseUrl

      const probeApiKey =
        typedApiKey ||
        savedCli?.apiKey ||
        (cliId === 'claude'
          ? process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY) ||
        ''

      const cliName = cliId === 'claude' ? 'Claude Code' : 'Codex'

      if (!probeBaseUrl) {
        return {
          toast: {
            type: 'error',
            content: '当前未配置 Base URL 服务地址，请先填写服务地址。',
          },
        }
      }

      const probeResult = await fetchAvailableModels({
        cliId,
        baseUrl: probeBaseUrl,
        apiKey: probeApiKey,
      })

      if (!probeResult.success || probeResult.models.length === 0) {
        const errMsg = probeResult.error ?? '端点未返回可用模型列表。'

        const failureDetail = hasUnsavedApiKey
          ? '因安全原因未保存的密钥已被清空，重试前请在表单中重新输入 API Key。'
          : '请检查 Base URL 与 API Key。'

        return {
          toast: {
            type: 'error',
            content: hasUnsavedApiKey
              ? `探测失败: ${errMsg}（请重新输入未保存的密钥后重试）`
              : `探测失败: ${errMsg}`,
          },
          card: {
            type: 'raw',
            data: buildBotModelConfigCard({
              botConfigs: runtime.teamRegistry.members,
              selectedBotId: targetBot.id,
              selectedCliId: cliId,
              effectiveConfig,
              draft: { baseUrl: probeBaseUrl },
              statusNotice: `⚠️ [${cliName}] 模型探测失败: ${errMsg}。服务地址草稿已保留，${failureDetail}`,
            }),
          },
        }
      }

      const previewModels = probeResult.models.slice(0, 4).join('、')

      const moreText =
        probeResult.models.length > 4
          ? ` 等共 ${probeResult.models.length} 个`
          : ''

      // 状态提示与 Toast：若存在未保存的敏感密钥，明确提示用户在保存前重新输入密钥；始终保留 Base URL 草稿
      let statusNotice: string
      let toastContent: string

      if (hasUnsavedApiKey) {
        statusNotice = `⚠️ 成功探测到模型（共 ${probeResult.models.length} 项）！服务地址草稿已保留。因安全原因密钥无法回显，请选择模型并在密钥栏重新输入密钥后点击「💾 保存并立即生效」。`
        toastContent = `成功获取到 ${probeResult.models.length} 个可用模型！注意：请重新输入未保存的密钥后再点击保存。`
      } else if (hasUnsavedBaseUrl) {
        statusNotice = `✅ 成功探测到模型：${previewModels}${moreText}！服务地址草稿已保留，请选择模型后点击「💾 保存并立即生效」。`
        toastContent = `成功获取到 ${probeResult.models.length} 个可用模型！服务地址草稿已保留。`
      } else {
        statusNotice = `✅ 成功探测到模型：${previewModels}${moreText}，可在下方下拉选择！`
        toastContent = `成功获取到 ${probeResult.models.length} 个可用模型！`
      }

      return {
        toast: {
          type: 'success',
          content: toastContent,
        },
        card: {
          type: 'raw',
          data: buildBotModelConfigCard({
            botConfigs: runtime.teamRegistry.members,
            selectedBotId: targetBot.id,
            selectedCliId: cliId,
            effectiveConfig,
            availableModels: probeResult.models,
            draft: { baseUrl: probeBaseUrl },
            statusNotice,
          }),
        },
      }
    }

    if (action.value.action === 'close_bot_model_config') {
      const access = checkModelConfigAccess(action.operatorOpenId)
      if (!access.allowed) {
        return {
          toast: {
            type: 'error',
            content: access.reason ?? '只有管理员可以配置角色模型。',
          },
        }
      }

      const botId =
        typeof action.value.botId === 'string' ? action.value.botId : ''

      const targetBot = runtime.teamRegistry.members.find((m) => m.id === botId)

      const cliId: CliId =
        action.value.cliId === 'codex'
          ? 'codex'
          : action.value.cliId === 'claude'
            ? 'claude'
            : (targetBot?.defaultCliId ?? 'claude')

      const cliName = cliId === 'claude' ? 'Claude Code' : 'Codex'

      return {
        toast: { type: 'info', content: '已关闭模型配置面板。' },
        card: {
          type: 'raw',
          data: buildClosedBotModelConfigCard({
            botId: targetBot?.id ?? botId,
            cliName,
          }),
        },
      }
    }

    if (action.value.action !== 'abort_task') return undefined

    const sessionId =
      typeof action.value.sessionId === 'string' ? action.value.sessionId : ''

    const outcome = requestTaskAbort(
      runtime.activeRuns,
      sessionId,
      action.operatorOpenId,
    )

    if (outcome === 'not_found') {
      return {
        toast: { type: 'info', content: '任务已经结束，无需再次停止。' },
      }
    }
    if (outcome === 'forbidden') {
      return {
        toast: { type: 'warning', content: '无法识别操作者，无法停止任务。' },
      }
    }
    if (outcome === 'already_stopping') {
      return { toast: { type: 'info', content: '正在停止任务，请稍候。' } }
    }
    return { toast: { type: 'success', content: '已发送停止指令。' } }
  }
}
