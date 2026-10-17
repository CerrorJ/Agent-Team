// Agent Team 入口。
// 当前阶段：飞书消息驱动 Claude Code / Codex 完成任务。
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  startBot,
  type Bot,
  type IncomingDocumentComment,
  type IncomingMessage,
} from './im/lark.js'
import {
  backendEndpoint,
  sessionLimitTracker,
} from './core/session-limit-tracker.js'
import { classifyProviderError } from './core/provider-error.js'
import { ProviderCliError } from './cli/runner.js'
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildClarificationSupersededCard,
  buildSessionNoticeCard,
  buildTaskCard,
  buildScheduleCreatedCard,
  buildScheduleListCard,
  buildApprovalCard,
  splitLongText,
  ThrottledCardUpdater,
} from './im/card.js'
import { resolveMentions, extractResourceKeys } from './im/message-parser.js'
import { parseCliRequest, parseCommand } from './core/command-parser.js'
import { SessionManager } from './core/session-manager.js'
import { JsonSessionStore } from './core/session-store.js'
import { TaskProgressTracker } from './core/task-progress.js'
import type { ActiveRun } from './core/task-abort.js'
import {
  ClarificationFlowStore,
  findClarificationRequest,
  formatClarificationMessage,
} from './core/clarification.js'
import type { ProductSpecRequest } from './core/product-spec.js'
import { JsonProductSpecFlowStore } from './core/product-spec-store.js'
import {
  DEFAULT_APPROVAL_TIMEOUT_SECONDS,
  findApprovalRequest,
} from './core/approval.js'
import { JsonApprovalFlowStore } from './core/approval-store.js'
import { JsonScheduleStore } from './core/schedule-store.js'
import { JsonScheduleRunStore } from './core/schedule-run-store.js'
import { topicTaskId } from './core/topic-task.js'
import {
  CollaborationInbox,
  buildCollaborationPrompt,
  collaborationOrigin,
  collaborationTurnKey,
  findDispatchTaskRequest,
  type CollaborationMessage,
} from './core/collaboration.js'
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from './core/workspace.js'
import {
  buildBotPrompt,
  loadAgentTeamConfig,
  type BotConfig,
} from './core/bot-registry.js'
import { TeamRegistry } from './core/team-registry.js'
import { getCliAdapter, listCliAdapters } from './cli/registry.js'
import { compactCliSession } from './cli/native-compact.js'
import {
  createCardActionHandler,
  scheduleApprovalContinuation,
} from './app/card-action-handler.js'
import { executeCli } from './app/cli-execution.js'
import { handleSessionCommand } from './app/command-handler.js'
import { sendResultNotification } from './app/notification-service.js'
import { markSessionIdle } from './app/session-view.js'
import { runProductDocumentComment } from './app/product-comment-runner.js'
import { ensureProductSpecSubmission } from './app/product-spec-submission.js'
import { CollaborationService } from './app/collaboration-service.js'
import { Scheduler } from './app/scheduler.js'
import { startScheduleApi } from './app/schedule-api.js'
import { startScheduleFileWatcher } from './app/schedule-watcher.js'
import type { AppRuntime, BotRuntime } from './app/runtime.js'

import { JsonModelConfigStore } from './core/model-config-store.js'

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join('config', 'bots.json'),
)

const agentTeamConfig = await loadAgentTeamConfig(botConfigPath)
const botConfigs = agentTeamConfig.bots

const modelConfigStore = new JsonModelConfigStore(
  join('data', 'bot-model-overrides.json'),
)

await modelConfigStore.load(botConfigs)

const teamRegistry = new TeamRegistry(agentTeamConfig.teamLeaderId, botConfigs)
await Promise.all(
  botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)),
)
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(
    `[Skill] bot=${missing.botId} 找不到 ${missing.skill}，请安装到工作区或用户级 Skills 目录`,
  )
}

const defaultWorkspaces = Object.fromEntries(
  botConfigs.map((config) => [config.id, config.workspaceDir]),
)

const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join('data', 'sessions.json'),
    botConfigs[0]?.id,
    defaultWorkspaces,
  ),
})

const activeRuns = new Map<string, ActiveRun>()
const contextWindows = new Map<string, number>()
const botRuntimes = new Map<string, BotRuntime>()
const processedCollaborationTurns = new Set<string>()
const collaborationInbox = new CollaborationInbox()
const clarificationFlows = new ClarificationFlowStore()

const productSpecFlows = new JsonProductSpecFlowStore(
  join('data', 'product-spec-flows.json'),
)

const approvalFlows = new JsonApprovalFlowStore(
  join('data', 'approval-flows.json'),
)

const processedDocumentCommentEvents = new Set<string>()
const documentCommentQueues = new Map<string, Promise<void>>()
const MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS = 1_000

const runtime: AppRuntime = {
  sessions,
  teamRegistry,
  activeRuns,
  contextWindows,
  botRuntimes,
  processedCollaborationTurns,
  collaborationInbox,
  clarificationFlows,
  productSpecFlows,
  approvalFlows,
  modelConfigStore,
}

const persistBotIdentities = (): void => {
  const identities = Object.fromEntries(
    [...botRuntimes.entries()].map(([id, run]) => [
      id,
      { openId: run.identity.openId, name: run.identity.name },
    ]),
  )

  mkdirSync(join('data'), { recursive: true })
  writeFileSync(
    join('data', 'bot-identities.json'),
    `${JSON.stringify(identities, null, 2)}\n`,
    'utf8',
  )
}

const collaborationService = new CollaborationService(runtime)
const scheduleFilePath = join('data', 'schedules.json')
const scheduleStore = new JsonScheduleStore(scheduleFilePath)

const scheduleRunStore = new JsonScheduleRunStore(
  join('data', 'schedule-runs.json'),
)

const scheduler = new Scheduler({
  runtime,
  scheduleStore,
  runStore: scheduleRunStore,
  defaultProductDeliveryMode: agentTeamConfig.defaultProductDeliveryMode,
})

console.log('Agent Team 启动，正在建立飞书长连接…')
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话`,
)
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`)
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`,
  )
}

const handleBotMessage = async (
  config: BotConfig,
  msg: IncomingMessage,
  bot: Bot,
): Promise<void> => {
  const resolved = resolveMentions(msg.text, msg.mentions)
  const taskId = topicTaskId(msg)
  let senderRuntime: BotRuntime | undefined
  let collaboration: CollaborationMessage | undefined
  if (msg.senderType === 'app' || msg.senderType === 'bot') {
    const currentRuntime = botRuntimes.get(config.id)

    const mentionedCurrentBot = currentRuntime
      ? msg.mentions.some(
          (mention) => mention.openId === currentRuntime.identity.openId,
        )
      : false

    const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1]

    const pending =
      msg.messageType === 'post' && mentionedCurrentBot && dispatchId
        ? collaborationInbox.consume(dispatchId, config.id)
        : undefined

    if (!pending) {
      // 内部团队机器人之间严禁通过非协作派发通道互发消息，直接忽略以避免死循环与逻辑异常
      const isInternalBot = [...botRuntimes.values()].some(
        (r) => r.identity.openId === msg.senderOpenId,
      )

      if (isInternalBot) {
        console.log(
          `[协作] 忽略来自内部团队 bot 的非派发消息 sender=${msg.senderOpenId} target=${config.id}`,
        )
        return
      }

      if (mentionedCurrentBot) {
        console.log(
          `[协作] bot 消息 @ 当前 bot，按外部派活处理 sender=${msg.senderOpenId} target=${config.id}`,
        )
      } else {
        console.log(
          `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
        )
        return
      }
    } else {
      senderRuntime = botRuntimes.get(pending.fromBotId)
      if (!senderRuntime) {
        console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`)
        return
      }
      const turnKey = collaborationTurnKey(pending)
      if (processedCollaborationTurns.has(turnKey)) {
        console.log(`[协作] 忽略重复消息 ${turnKey}`)
        return
      }
      processedCollaborationTurns.add(turnKey)
      collaboration = pending
    }
  }
  const botSender = msg.senderType === 'app' || msg.senderType === 'bot'

  const ownerOpenId =
    collaboration?.ownerOpenId ??
    (botSender
      ? (process.env.OWNER_OPEN_ID ?? msg.senderOpenId)
      : msg.senderOpenId)

  const ownerUnionId =
    collaboration?.ownerUnionId ?? (botSender ? undefined : msg.senderUnionId)

  const hasThread = !!msg.threadId || !!msg.rootId
  const command = parseCommand(resolved)
  const cliRequest = parseCliRequest(resolved)
  if (cliRequest && !cliRequest.prompt) {
    await bot.reply(
      msg.messageId,
      `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
      hasThread,
    )
    return
  }

  // 话题里还有未完成的澄清流程时，普通消息按「补充说明」并入该流程，不开新任务
  const pendingClarification =
    msg.senderType !== 'app' && msg.senderType !== 'bot' && !command
      ? clarificationFlows.findForTask(taskId, config.id)
      : undefined

  const resolvedSession = await sessions.resolve(
    msg,
    cliRequest?.cliId ?? config.defaultCliId,
    config.id,
    collaboration?.workspaceDir ?? config.workspaceDir,
  )

  let { session } = resolvedSession
  const { isNew } = resolvedSession
  if (command && isNew && session.status === 'creating') {
    session = await sessions.transition(session.id, 'idle')
  }
  const cliAdapter = getCliAdapter(session.cliId)
  const isCompacting = command?.name === 'compact'
  let taskText = pendingClarification
    ? formatClarificationMessage(
        pendingClarification,
        cliRequest?.prompt ?? resolved,
      )
    : collaboration
      ? buildCollaborationPrompt(collaboration)
      : (cliRequest?.prompt ?? resolved)
  if (command?.name === 'schedule' && command.request) {
    taskText = [
      '用户想创建一个定时任务。',
      `需求：${command.request}`,
      '请使用 schedule_manage 工具，action=add 创建：targetBotId 选择团队中合适的成员，prompt 保留完整需求，rule 根据需求选择合适的调度规则。',
    ].join('\n\n')
  }

  const prompt = buildBotPrompt(
    config,
    taskText,
    teamRegistry.contextFor(config.id),
    agentTeamConfig.defaultProductDeliveryMode,
  )

  const taskCardTitle = isCompacting ? '整理上下文' : cliAdapter.displayName
  console.log(
    `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
  )
  console.log(`  原文: ${msg.text}`)
  console.log(`  还原: ${resolved}`)
  console.log(
    `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
  )
  console.log(
    `  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status}`,
  )

  const commandOutcome = await handleSessionCommand({
    runtime,
    scheduler,
    config,
    msg,
    bot,
    session,
    cliAdapter,
    command,
    cliRequest,
    isNew,
    hasThread,
  })

  if (commandOutcome === 'handled') return

  if (session.status === 'closed') {
    await bot.reply(
      msg.messageId,
      '这个话题的会话已经关闭，请新开一个话题继续。',
      hasThread,
    )
    return
  }
  if (!isNew && session.status === 'creating') {
    await bot.reply(
      msg.messageId,
      '当前会话正在准备，请稍后再追问。',
      hasThread,
    )
    return
  }
  if (!isCompacting && session.status === 'active') {
    await bot.reply(
      msg.messageId,
      '当前会话还在执行，请等任务结束后再追问。',
      hasThread,
    )
    return
  }

  // 检查当前 bot 是否处于会话限额不可用状态，若受限则直接回传 CEO 调度派发
  if (teamRegistry.getAvailability(config.id, session.cliId).isLimited) {
    if (
      (isNew && session.status === 'creating') ||
      (isCompacting && session.status === 'active')
    ) {
      try {
        session = await sessions.transition(session.id, 'idle')
      } catch (error) {
        console.error(
          '[会话] 限额退出保存空闲状态失败:',
          (error as Error).message,
        )
      }
    }

    const resetInfo = teamRegistry.getAvailability(config.id, session.cliId)
    const leaderId = agentTeamConfig.teamLeaderId
    const groupName = config.group ?? config.id

    const availableFallbacks = teamRegistry.getAvailableFallbackMembers(
      config.id,
    )

    if (config.id !== leaderId) {
      const leaderRuntime = botRuntimes.get(leaderId)
      if (leaderRuntime) {
        const fallbackIds = availableFallbacks.map((f) => f.id).join('、')

        const instruction =
          availableFallbacks.length > 0
            ? [
                `【任务接续派发】`,
                `成员 ${config.id} 当前后端不可用：${resetInfo.reason}${resetInfo.resetsText ? `（${resetInfo.resetsText}）` : ''}，无法接单。`,
                `所在分组 "${groupName}" 内可用备用成员：${fallbackIds}。`,
                `【原任务需求】：${collaboration?.objective ?? taskText}`,
                `【建议处理】：${resetInfo.guidance}`,
                `【请 CEO 调度】：请使用 dispatch_task 派发给同组可用成员（${fallbackIds}）基于工作区现场接续推进，并汇总交付。`,
              ].join('\n\n')
            : [
                `【团队资源受限汇报】`,
                `用户向成员 ${config.id} 发起任务，但所在分组 "${groupName}" 内所有成员均处于后端不可用状态。`,
                `【原任务需求】：${collaboration?.objective ?? taskText}`,
                `【建议处理】：${resetInfo.guidance}`,
                `【请 CEO 处理】：请直接在当前话题向用户说明团队该分组资源受限不可用，并向用户确认下一步决策。`,
              ].join('\n\n')

        const mentionText =
          availableFallbacks.length > 0
            ? `当前成员处于模型后端不可用状态，任务已移交 Team Leader 接续调度同组备用成员处理`
            : `分组 "${groupName}" 成员后端均不可用，已移交 Team Leader 向你确认后续处理`

        try {
          await collaborationService.dispatch({
            senderConfig: config,
            senderBot: bot,
            replyToMessageId: msg.messageId,
            mentionText,
            targetBotId: leaderId,
            taskId,
            ownerOpenId,
            ownerUnionId,
            reportToBotId: leaderId,
            objective:
              availableFallbacks.length > 0
                ? '同组成员后端故障接续派发'
                : '团队资源受限确认',
            instruction,
            expectedOutput:
              availableFallbacks.length > 0
                ? '调度备用成员接续完成任务'
                : '向用户汇报并确认决策',
            round: collaboration ? collaboration.round + 1 : 1,
            maxRounds:
              collaboration?.maxRounds ?? config.collaborationMaxRounds,
            workspaceDir: collaboration?.workspaceDir ?? config.workspaceDir,
          })
          return
        } catch (dispatchErr) {
          console.error(
            '[限额派发] 向 Team Leader 派发工单失败:',
            (dispatchErr as Error).message,
          )
        }
      }

      await bot.reply(
        msg.messageId,
        availableFallbacks.length > 0
          ? `当前成员处于模型后端不可用状态，任务移交 Team Leader 失败，请重试。`
          : `分组 "${groupName}" 成员后端均不可用，移交 Team Leader 失败，请重试。`,
        hasThread,
      )
      return
    } else {
      await bot.reply(
        msg.messageId,
        `Team Leader 当前后端不可用：${resetInfo.reason}${resetInfo.resetsText ? `（${resetInfo.resetsText}）` : ''}。${resetInfo.guidance}`,
        hasThread,
      )
      return
    }
  }

  // 用户没点卡片而是发了新消息：作废旧澄清卡片，新消息会带着已确认答案重新整理
  if (pendingClarification) {
    clarificationFlows.delete(pendingClarification.token)
    if (pendingClarification.cardMessageId) {
      try {
        await bot.updateCard(
          pendingClarification.cardMessageId,
          buildClarificationSupersededCard(pendingClarification),
        )
      } catch (error) {
        console.warn(
          '[澄清] 旧卡片更新失败，继续处理用户的新消息:',
          (error as Error).message,
        )
      }
    }
  }

  if (collaboration && session.workspaceDir !== collaboration.workspaceDir) {
    await ensureWorkspaceDirectory(collaboration.workspaceDir)
    session = await sessions.setWorkspaceDir(
      session.id,
      collaboration.workspaceDir,
    )
  }

  if (session.status !== 'active') {
    session = await sessions.transition(session.id, 'active')
  }

  // 启动前校验会话状态与 ID（在创建任务卡片与定时器前完成，避免留下孤立卡片与心跳）
  const sessionBeforeRun = sessions.get(session.id)
  if (sessionBeforeRun) session = sessionBeforeRun

  if (session.status === 'closed') {
    await bot.reply(
      msg.messageId,
      '这个话题的会话已经关闭，请新开一个话题继续。',
      hasThread,
    )
    return
  }

  if (isCompacting && !session.cliSessionId) {
    try {
      await bot.reply(msg.messageId, '当前还没有可整理的 CLI 会话。', hasThread)
    } finally {
      await markSessionIdle(sessions, session.id)
    }
    return
  }

  const run = new AbortController()

  const activeRun: ActiveRun = {
    controller: run,
    ownerOpenId,
  }

  activeRuns.set(session.id, activeRun)

  // 图片/文件下载
  const resources = extractResourceKeys(msg.messageType, msg.rawContent)
  for (const res of resources) {
    try {
      const savePath = await bot.downloadResource(
        msg.messageId,
        res.key,
        res.type,
        join('data', 'downloads'),
        res.fileName,
      )

      console.log(`  [下载] ${res.type} → ${savePath}`)
    } catch (e) {
      console.error(`  [下载失败] ${res.key}:`, (e as Error).message)
    }
  }

  // 先回复一张卡片，让用户知道任务已经进入执行队列。
  let cardId: string | undefined
  try {
    cardId = await bot.replyCard(
      msg.messageId,
      buildTaskCard({
        title: taskCardTitle,
        status: 'running',
        detail: isCompacting
          ? cliAdapter.id === 'codex' && command?.instructions
            ? 'Codex 正在使用原生默认策略整理上下文'
            : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
          : '正在理解任务',
        abortSessionId: session.id,
      }),
      hasThread,
    )
  } catch (error) {
    if (activeRuns.get(session.id)?.controller === run)
      activeRuns.delete(session.id)
    await markSessionIdle(sessions, session.id)
    throw error
  }

  if (!cardId) {
    console.error('[卡片] 响应里没有 message_id，无法继续更新')
    if (activeRuns.get(session.id)?.controller === run)
      activeRuns.delete(session.id)
    await markSessionIdle(sessions, session.id)
    return
  }
  console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

  const progress = new TaskProgressTracker(
    Date.now,
    contextWindows.get(session.id),
    !session.cliSessionId,
  )

  const cardUpdater = new ThrottledCardUpdater((card) =>
    bot.updateCard(cardId, card),
  )

  const renderProgress = () => {
    const snapshot = progress.snapshot()
    cardUpdater.push(
      buildTaskCard({
        title: taskCardTitle,
        status: 'running',
        detail: isCompacting
          ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
          : snapshot.current,
        ...(!isCompacting ? { progress: snapshot } : {}),
        abortSessionId: session.id,
      }),
    )
  }

  const progressHeartbeat = setInterval(renderProgress, 1_000)
  progressHeartbeat.unref()

  const cliEnv = {
    ...config.cliEnv,
    AGENT_TEAM_CHAT_ID: msg.chatId,
    AGENT_TEAM_OWNER_OPEN_ID: collaboration?.ownerOpenId ?? msg.senderOpenId,
  }

  // 启动 CLI 前拉取会话管理器中的最新记录，防止并发消息在 /newall 后继续跑旧 CLI 会话
  const latestSession = sessions.get(session.id)
  if (latestSession) session = latestSession

  if (session.status === 'closed') {
    clearInterval(progressHeartbeat)
    const cancelMode = activeRuns.get(session.id)?.cancelMode
    if (activeRuns.get(session.id)?.controller === run) {
      activeRuns.delete(session.id)
    }
    try {
      await cardUpdater.finish(
        buildTaskCard({
          title: taskCardTitle,
          status: 'cancelled',
          detail:
            cancelMode === 'close'
              ? '本次任务已停止，当前会话已经关闭。'
              : '当前话题的会话已经关闭。',
          progress: progress.snapshot(),
        }),
      )
      await bot.reply(
        msg.messageId,
        '这个话题的会话已经关闭，请新开一个话题继续。',
        hasThread,
      )
    } catch (e) {
      console.error('[卡片] 关闭会话卡片更新失败:', (e as Error).message)
    }
    return
  }

  if (isCompacting && !session.cliSessionId) {
    clearInterval(progressHeartbeat)
    if (activeRuns.get(session.id)?.controller === run) {
      activeRuns.delete(session.id)
    }
    try {
      await cardUpdater.finish(
        buildTaskCard({
          title: taskCardTitle,
          status: 'failed',
          detail: '当前还没有可整理的 CLI 会话',
        }),
      )
      await bot.reply(msg.messageId, '当前还没有可整理的 CLI 会话。', hasThread)
    } catch (e) {
      console.error('[卡片] 整理卡片更新失败:', (e as Error).message)
    } finally {
      await markSessionIdle(sessions, session.id)
    }
    return
  }

  // 让事件回调尽快返回，CLI 在后台继续执行。
  const execution = isCompacting
    ? compactCliSession({
        adapter: cliAdapter,
        sessionId: session.cliSessionId!,
        cwd: session.workspaceDir,
        instructions: command.instructions,
        signal: run.signal,
        env: cliEnv,
      }).then((result) => ({
        answer: result.message ?? '',
        sessionId: result.sessionId,
        stats: undefined,
        toolCalls: undefined,
      }))
    : executeCli(
        cliAdapter,
        prompt,
        session.workspaceDir,
        session.cliSessionId,
        run.signal,
        ['request_approval'],
        (event) => {
          if (
            event.type !== 'tool_start' &&
            event.type !== 'tool_end' &&
            event.type !== 'context' &&
            event.type !== 'model' &&
            event.type !== 'retry'
          )
            return
          progress.accept(event)
          renderProgress()
        },
        cliEnv,
      )

  void execution
    .then(async (result) => {
      clearInterval(progressHeartbeat)
      if (!isCompacting && result.sessionId) {
        await sessions.setCliSessionId(session.id, result.sessionId)
      }
      if (!isCompacting && result.stats?.contextWindowTokens) {
        contextWindows.set(session.id, result.stats.contextWindowTokens)
      }

      // grill-me：从工具调用里截获 request_clarification，转成卡片逐题收集答案
      const clarificationRequest =
        !isCompacting && config.skills.includes('grill-me')
          ? findClarificationRequest(result.toolCalls)
          : undefined

      if (clarificationRequest) {
        const flow = clarificationFlows.create({
          taskId,
          botId: config.id,
          sessionId: session.id,
          ownerOpenId,
          ownerUnionId,
          collaboration: collaboration
            ? collaborationOrigin(collaboration)
            : undefined,
          originalMessageId: msg.messageId,
          cardMessageId: cardId,
          replyInThread: hasThread,
          request: clarificationRequest,
        })

        if (activeRuns.get(session.id)?.controller === run) {
          activeRuns.delete(session.id)
        }
        await markSessionIdle(sessions, session.id)
        await cardUpdater.finish(buildClarificationCard({ flow }))
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: { openId: flow.ownerOpenId, name: '' },
          text: `需要你确认 ${clarificationRequest.questions.length} 个问题，请在上方卡片中选择。`,
          replyInThread: hasThread,
        })
        console.log(
          `[澄清] 已发送交互卡片 questions=${clarificationRequest.questions.length}`,
        )
        return
      }
      let finalResult = result
      // 仅产品方案 Skill：从工具调用里截获 request_spec_approval，校验产物后展示待确认卡片
      let productSpecRequest: ProductSpecRequest | undefined

      const managesProductSpec =
        !isCompacting &&
        (config.skills.includes('to-spec') ||
          config.skills.includes('to-tickets'))

      if (managesProductSpec) {
        const submission = await ensureProductSpecSubmission({
          result,
          workspaceDir: session.workspaceDir,
          defaultDeliveryMode: agentTeamConfig.defaultProductDeliveryMode,
          retry: (retryPrompt, resultSessionId) =>
            executeCli(
              cliAdapter,
              retryPrompt,
              session.workspaceDir,
              resultSessionId ?? session.cliSessionId,
              run.signal,
              [],
              (event) => {
                if (
                  event.type !== 'tool_start' &&
                  event.type !== 'tool_end' &&
                  event.type !== 'context' &&
                  event.type !== 'model' &&
                  event.type !== 'retry'
                )
                  return
                progress.accept(event)
                renderProgress()
              },
              cliEnv,
            ),
        })

        finalResult = submission.result
        productSpecRequest = submission.request
        if (finalResult.sessionId) {
          await sessions.setCliSessionId(session.id, finalResult.sessionId)
        }
        if (finalResult.stats?.contextWindowTokens) {
          contextWindows.set(session.id, finalResult.stats.contextWindowTokens)
        }
      }

      const dispatchRequest = !isCompacting
        ? findDispatchTaskRequest(finalResult.toolCalls)
        : undefined

      if (dispatchRequest) {
        if (config.id !== agentTeamConfig.teamLeaderId) {
          throw new Error('只有 CEO 助理可以调用 dispatch_task 派发团队任务')
        }
        const dispatchTarget = teamRegistry.get(dispatchRequest.targetBotId)
        if (!dispatchTarget) {
          throw new Error(
            `团队成员未注册或未启用: ${dispatchRequest.targetBotId}`,
          )
        }
        if (dispatchRequest.targetBotId === config.id) {
          throw new Error(`不能把团队任务派发给当前 bot: ${config.id}`)
        }
        if (collaboration && collaboration.round >= collaboration.maxRounds) {
          throw new Error(
            `协作任务已达到轮次上限 ${collaboration.maxRounds}，不能继续派发`,
          )
        }
      }
      if (productSpecRequest && dispatchRequest) {
        throw new Error('不能同时提交产品方案和派发团队任务')
      }
      if (productSpecRequest) {
        if (activeRuns.get(session.id)?.controller === run) {
          activeRuns.delete(session.id)
        }
        await markSessionIdle(sessions, session.id)

        const flow = productSpecFlows.create({
          taskId,
          botId: config.id,
          sessionId: session.id,
          ownerOpenId,
          ownerUnionId,
          collaboration: collaboration
            ? collaborationOrigin(collaboration)
            : undefined,
          request: productSpecRequest,
        })

        await cardUpdater.finish(buildProductSpecApprovalCard(flow))
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: {
            openId: ownerOpenId,
            name: '',
          },
          text: '产品方案已生成，请查看上方确认卡。',
          replyInThread: hasThread,
        })
        console.log('[产品文档] 已展示待确认产物')
        return
      }

      const approvalRequest = !isCompacting
        ? findApprovalRequest(finalResult.toolCalls)
        : undefined

      if (approvalRequest) {
        const flow = approvalFlows.create({
          taskId,
          botId: config.id,
          sessionId: session.id,
          ownerOpenId,
          ownerUnionId,
          collaboration: collaboration
            ? collaborationOrigin(collaboration)
            : undefined,
          originalMessageId: msg.messageId,
          cardMessageId: cardId,
          replyInThread: hasThread,
          request: approvalRequest,
        })

        if (activeRuns.get(session.id)?.controller === run) {
          activeRuns.delete(session.id)
        }
        await markSessionIdle(sessions, session.id)
        await cardUpdater.finish(buildApprovalCard(flow))
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: { openId: ownerOpenId, name: '' },
          text: '开发者请求执行高危操作，请在上方卡片中拍板。',
          replyInThread: hasThread,
        })
        console.log(`[审批] 已展示审批卡 flow=${flow.token}`)

        const timeoutMs =
          (approvalRequest.timeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS) *
          1_000

        const timeout = setTimeout(() => {
          void (async () => {
            const current = approvalFlows.get(flow.token)
            if (!current || current.status !== 'pending') return
            const expired = approvalFlows.expire(flow.token)
            const botRuntime = botRuntimes.get(config.id)
            if (!expired || !botRuntime) return
            try {
              await scheduleApprovalContinuation({
                runtime,
                config,
                flow: expired,
                bot: botRuntime.bot,
              })
            } catch (error) {
              console.error(
                '[审批] 超时自动拒绝失败:',
                (error as Error).message,
              )
            }
          })()
        }, timeoutMs)

        timeout.unref?.()
        return
      }
      const snapshot = progress.snapshot()
      await cardUpdater.finish(
        isCompacting
          ? buildSessionNoticeCard({
              title: finalResult.answer ? '暂时无需整理' : '上下文已整理',
              template: finalResult.answer ? 'grey' : 'green',
              detail:
                finalResult.answer ||
                [
                  `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                  'CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。',
                ].join('\n\n'),
            })
          : buildTaskCard({
              title: taskCardTitle,
              status: 'success',
              detail: '执行完成',
              progress: snapshot,
              answer: finalResult.answer,
              stats: finalResult.stats,
            }),
      )
      if (!isCompacting && answerNeedsContinuation(finalResult.answer)) {
        for (const chunk of splitLongText(
          answerContinuation(finalResult.answer),
        )) {
          await bot.reply(msg.messageId, chunk, hasThread)
        }
      }
      console.log(
        `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? '(无)'}`,
      )
      if (!collaboration) {
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: { openId: ownerOpenId, name: '' },
          text: isCompacting
            ? '上下文整理已完成，请查看上方结果。'
            : '任务已完成，请查看上方结果。',
          replyInThread: hasThread,
        })
      }
      // 产品澄清在本节停在产品结论，不自动进入后续团队编排。
      if (!isCompacting) {
        try {
          if (dispatchRequest) {
            await collaborationService.dispatch({
              senderConfig: config,
              senderBot: bot,
              replyToMessageId: msg.messageId,
              targetBotId: dispatchRequest.targetBotId,
              taskId,
              ownerOpenId,
              ownerUnionId,
              reportToBotId: collaboration?.reportToBotId ?? config.id,
              objective: dispatchRequest.objective,
              instruction: dispatchRequest.instruction,
              expectedOutput: dispatchRequest.expectedOutput,
              round: collaboration ? collaboration.round + 1 : 1,
              maxRounds:
                collaboration?.maxRounds ?? config.collaborationMaxRounds,
              workspaceDir: session.workspaceDir,
            })
            if (!collaboration) {
              const targetName =
                botRuntimes.get(dispatchRequest.targetBotId)?.identity.name ??
                dispatchRequest.targetBotId

              await sendResultNotification({
                bot,
                replyToMessageId: msg.messageId,
                target: { openId: ownerOpenId, name: '' },
                text: `任务已交给 ${targetName}，请查看上方协作消息。`,
                replyInThread: hasThread,
              })
            }
          } else if (collaboration) {
            if (collaboration.reportToBotId === config.id) {
              await sendResultNotification({
                bot,
                replyToMessageId: msg.messageId,
                target: { openId: collaboration.ownerOpenId, name: '' },
                text: `协作任务“${collaboration.objective}”已经完成，请查看上方结果。`,
                replyInThread: hasThread,
              })
            } else if (collaboration.round >= collaboration.maxRounds) {
              await sendResultNotification({
                bot,
                replyToMessageId: msg.messageId,
                target: { openId: collaboration.ownerOpenId, name: '' },
                text: `协作任务“${collaboration.objective}”已达到 ${collaboration.maxRounds} 轮上限，请查看上方结果并决定下一步。`,
                replyInThread: hasThread,
              })
            } else {
              await collaborationService.dispatch({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: msg.messageId,
                targetBotId: collaboration.reportToBotId,
                taskId: collaboration.taskId,
                ownerOpenId: collaboration.ownerOpenId,
                ownerUnionId: collaboration.ownerUnionId,
                reportToBotId: collaboration.reportToBotId,
                objective: collaboration.objective,
                instruction: [
                  `${botRuntimes.get(config.id)?.identity.name ?? config.id} 已完成当前协作任务，下面是它的结果：`,
                  finalResult.answer,
                  '请基于这份结果继续组织后续工作：仍需其他成员参与时使用 dispatch_task 继续派发；已经可以交付时，直接向用户汇总结论。',
                ].join('\n\n'),
                expectedOutput:
                  '继续推进原任务，或在已经完成时向用户给出最终结论。',
                round: collaboration.round + 1,
                maxRounds: collaboration.maxRounds,
                workspaceDir: session.workspaceDir,
              })
            }
          }
        } catch (error) {
          const message = (error as Error).message
          console.error('[协作] 派发失败:', message)
          await bot.reply(msg.messageId, `协作派发失败：${message}`, hasThread)
        }
      }
    })
    .catch(async (error) => {
      clearInterval(progressHeartbeat)
      if (run.signal.aborted) {
        console.log('[CLI] 任务已取消')
        await cardUpdater.finish(
          buildTaskCard({
            title: taskCardTitle,
            status: 'cancelled',
            detail:
              activeRun.cancelMode === 'close'
                ? '本次任务已停止，当前会话已经关闭。'
                : isCompacting
                  ? '整理已停止，当前 CLI 会话没有改变。'
                  : '本次任务已停止。你可以继续在当前话题里提问。',
            progress: progress.snapshot(),
          }),
        )
        await sendResultNotification({
          bot,
          replyToMessageId: msg.messageId,
          target: senderRuntime?.identity ?? {
            openId: ownerOpenId,
            name: '',
          },
          text: '任务已停止，请查看上方状态。',
          replyInThread: hasThread,
        })
        return
      }
      const message = (error as Error).message

      const failure =
        error instanceof ProviderCliError
          ? error.failure
          : classifyProviderError(
              { message },
              backendEndpoint(session.cliId, config.cliEnv),
            )

      if (error instanceof ProviderCliError && error.sessionId) {
        await sessions.setCliSessionId(session.id, error.sessionId)
      }

      if (failure.type !== 'unknown') {
        // Runner 已记录故障；原生 compact 等非 Runner 路径在这里补记。
        if (!(error instanceof ProviderCliError)) {
          sessionLimitTracker.markFailure(session.cliId, config.cliEnv, failure)
        }

        const unavailable = teamRegistry.getAvailability(
          config.id,
          session.cliId,
        )

        const resetText = unavailable.resetsText
        const failureReason = unavailable.reason ?? '模型后端不可用'
        console.warn(
          `[后端故障] Bot ${config.id} ${failureReason}${resetText ? ` (重新尝试: ${resetText})` : ''}`,
        )

        const leaderId = agentTeamConfig.teamLeaderId
        const groupName = config.group ?? config.id

        const availableFallbacks = teamRegistry.getAvailableFallbackMembers(
          config.id,
        )

        const expectedOutput =
          availableFallbacks.length > 0
            ? '调度备用成员接续完成任务'
            : '向用户汇报并确认决策'

        const fallbackIds = availableFallbacks.map((f) => f.id).join('、')

        const handoffInstruction =
          config.id !== leaderId
            ? availableFallbacks.length > 0
              ? [
                  `【任务接续派发】`,
                  `成员 ${config.id} 在执行任务时遇到${failureReason}${resetText ? `（${resetText}）` : ''}，当前会话已停止。`,
                  `所在分组 "${groupName}" 内有可用备用成员：${fallbackIds}。`,
                  `【原任务目标】：${collaboration?.objective ?? resolved}`,
                  `【建议处理】：${unavailable.guidance}`,
                  `【工作区目录】：${session.workspaceDir}`,
                  `【请 CEO 调度】：请使用 dispatch_task 派发给同组可用成员（${fallbackIds}）基于工作区现场接续推进，并汇总交付。`,
                ].join('\n\n')
              : [
                  `【团队资源受限汇报】`,
                  `成员 ${config.id} 在执行任务时遇到${failureReason}${resetText ? `（${resetText}）` : ''}。`,
                  `所在分组 "${groupName}" 内所有成员后端均不可用，暂无可用备用成员。`,
                  `【原任务目标】：${collaboration?.objective ?? resolved}`,
                  `【建议处理】：${unavailable.guidance}`,
                  `【请 CEO 处理】：请直接在当前话题向用户说明团队该分组资源受限不可用，并向用户确认下一步决策。`,
                ].join('\n\n')
            : undefined

        let handoffSuccess = false

        if (config.id !== leaderId) {
          const leaderRuntime = botRuntimes.get(leaderId)

          const mentionText =
            availableFallbacks.length > 0
              ? `成员后端不可用，任务已移交 Team Leader 接续调度备用成员处理`
              : `分组 "${groupName}" 成员后端均不可用，已移交 Team Leader 向你确认后续处理`

          const failureText =
            availableFallbacks.length > 0
              ? `成员后端不可用，任务移交 Team Leader 失败，请重试。`
              : `分组 "${groupName}" 成员后端均不可用，移交 Team Leader 失败，请重试。`

          if (leaderRuntime && handoffInstruction) {
            try {
              await collaborationService.dispatch({
                senderConfig: config,
                senderBot: bot,
                replyToMessageId: cardId,
                skipCard: true,
                mentionText,
                targetBotId: leaderId,
                taskId,
                ownerOpenId,
                ownerUnionId,
                reportToBotId: leaderId,
                objective:
                  availableFallbacks.length > 0
                    ? '同组成员后端故障接续派发'
                    : '团队资源受限确认',
                instruction: handoffInstruction,
                expectedOutput,
                round: collaboration ? collaboration.round + 1 : 1,
                maxRounds:
                  collaboration?.maxRounds ?? config.collaborationMaxRounds,
                workspaceDir: session.workspaceDir,
              })
              handoffSuccess = true
            } catch (dispatchErr) {
              console.error(
                '[限额派发] 向 Team Leader 派发工单失败:',
                (dispatchErr as Error).message,
              )
              await sendResultNotification({
                bot,
                replyToMessageId: msg.messageId,
                target: senderRuntime?.identity ?? {
                  openId: ownerOpenId,
                  name: '',
                },
                text: failureText,
                replyInThread: hasThread,
              })
            }
          } else {
            await sendResultNotification({
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity ?? {
                openId: ownerOpenId,
                name: '',
              },
              text: failureText,
              replyInThread: hasThread,
            })
          }

          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: 'failed',
              detail: handoffSuccess
                ? `${failureReason}${resetText ? `（${resetText}）` : ''}。任务已移交 Team Leader 接续派发。`
                : `${failureReason}${resetText ? `（${resetText}）` : ''}。任务移交 Team Leader 失败，请重试。`,
              expectedOutput,
              handoffDetail: handoffInstruction,
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          )
          return
        } else {
          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: 'failed',
              detail: `${failureReason}${resetText ? `（${resetText}）` : ''}。`,
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          )
          await sendResultNotification({
            bot,
            replyToMessageId: msg.messageId,
            target: senderRuntime?.identity ?? {
              openId: ownerOpenId,
              name: '',
            },
            text: `Team Leader 后端不可用：${failureReason}${resetText ? `（${resetText}）` : ''}，无法继续处理。${unavailable.guidance}`,
            replyInThread: hasThread,
          })
          return
        }
      }

      console.error('[CLI] 执行失败:', message)
      await cardUpdater.finish(
        buildTaskCard({
          title: taskCardTitle,
          status: 'failed',
          detail: isCompacting
            ? '上下文整理失败，当前 CLI 会话没有改变。'
            : '执行没有完成。你可以调整指令后，在当前话题里重试。',
          technicalDetail: message,
          progress: progress.snapshot(),
        }),
      )
      await sendResultNotification({
        bot,
        replyToMessageId: msg.messageId,
        target: senderRuntime?.identity ?? {
          openId: ownerOpenId,
          name: '',
        },
        text: '任务执行失败，请查看上方错误信息。',
        replyInThread: hasThread,
      })
    })
    .finally(async () => {
      clearInterval(progressHeartbeat)
      if (activeRuns.get(session.id)?.controller === run) {
        activeRuns.delete(session.id)
      }
      try {
        await markSessionIdle(sessions, session.id)
      } catch (error) {
        console.error('[会话] 保存空闲状态失败:', (error as Error).message)
      }
    })
    .catch((error) => {
      console.error('[任务] 回传或收尾失败:', (error as Error).message)
    })
}

const startConfiguredBots = async (
  configs: BotConfig[],
  collaborationService: CollaborationService,
): Promise<void> => {
  const configsByAppId = new Map<string, BotConfig[]>()
  for (const config of configs) {
    const group = configsByAppId.get(config.appId) ?? []
    group.push(config)
    configsByAppId.set(config.appId, group)
  }

  await Promise.all(
    [...configsByAppId.entries()].map(async ([appId, groupConfigs]) => {
      const primaryConfig = groupConfigs[0]

      const cardActionHandlers = groupConfigs.map((cfg) =>
        createCardActionHandler({
          runtime,
          config: cfg,
          collaborationService,
          defaultProductDeliveryMode:
            agentTeamConfig.defaultProductDeliveryMode,
        }),
      )

      const hasDriveSkill = groupConfigs.some((cfg) =>
        cfg.skills.includes('lark-drive'),
      )

      const startedBot = startBot({
        appId,
        appSecret: primaryConfig.appSecret,
        onCardAction: async (action) => {
          for (const handler of cardActionHandlers) {
            const res = await handler(action)
            if (res) return res
          }
          return undefined
        },
        onDocumentComment: hasDriveSkill
          ? async (comment, bot) => {
              const driveConfig = groupConfigs.find((cfg) =>
                cfg.skills.includes('lark-drive'),
              )!

              return scheduleDocumentComment(driveConfig, bot, comment)
            }
          : undefined,
        onMessage: async (msg, bot) => {
          let targetConfig = primaryConfig

          const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1]
          if (dispatchId) {
            const pendingCollab = collaborationInbox.peek(dispatchId)
            if (pendingCollab) {
              const matched = groupConfigs.find(
                (c) => c.id === pendingCollab.toBotId,
              )

              if (matched) {
                targetConfig = matched
              }
            }
          }

          await handleBotMessage(targetConfig, msg, bot)
        },
      })

      const identity = await startedBot.getIdentity()

      for (const config of groupConfigs) {
        const botRuntime = { config, bot: startedBot, identity }
        botRuntimes.set(config.id, botRuntime)
        console.log(
          `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}${groupConfigs.length > 1 ? ` (共享 appId: ${config.appId})` : ''}`,
        )
      }
      persistBotIdentities()

      if (hasDriveSkill) {
        try {
          await startedBot.subscribeToDocumentComments()
        } catch (error) {
          console.warn(
            `[Bot ${primaryConfig.id}] 文档评论订阅失败，不影响消息链路:`,
            (error as Error).message,
          )
        }
      }
    }),
  )
}

// 评论区入口：只处理 @本 bot 且命中待确认文档的评论；同会话的评论排队执行，
// 避免两个 CLI 并发改同一份文档。重复事件（飞书可能重推）按 eventId 去重。
const scheduleDocumentComment = (
  config: BotConfig,
  bot: Bot,
  comment: IncomingDocumentComment,
): void => {
  if (!comment.mentionedBot) return

  const flow = productSpecFlows.findPendingByDocument(
    config.id,
    comment.fileToken,
  )

  if (!flow) {
    console.log(
      `[产品评论] 忽略未关联待确认方案的评论 file=${comment.fileToken}`,
    )
    return
  }

  const eventKey =
    comment.eventId ||
    [comment.fileToken, comment.commentId, comment.replyId].join(':')

  if (processedDocumentCommentEvents.has(eventKey)) return
  rememberDocumentCommentEvent(eventKey)

  const workingReaction = bot
    .setDocumentCommentWorking(comment, true)
    .then(() => true)
    .catch((error) => {
      console.warn(
        '[产品评论] 添加处理中表情失败，继续执行:',
        (error as Error).message,
      )
      return false
    })

  const previous =
    documentCommentQueues.get(flow.sessionId) ?? Promise.resolve()

  const queued = Promise.all([
    previous.catch(() => undefined),
    workingReaction,
  ]).then(async ([, reactionAdded]) => {
    try {
      await runProductDocumentComment({
        runtime,
        config,
        bot,
        flow,
        comment,
      })
    } finally {
      if (reactionAdded) {
        await bot.setDocumentCommentWorking(comment, false).catch((error) => {
          console.warn(
            '[产品评论] 移除处理中表情失败:',
            (error as Error).message,
          )
        })
      }
    }
  })

  documentCommentQueues.set(flow.sessionId, queued)
  void queued
    .catch((error) => {
      console.error('[产品评论] 处理失败:', (error as Error).message)
      return bot
        .replyToDocumentComment(
          comment,
          `这条评论暂时没有处理完成：${(error as Error).message}`,
        )
        .catch((replyError) => {
          console.error('[产品评论] 回写失败:', (replyError as Error).message)
        })
    })
    .finally(() => {
      if (documentCommentQueues.get(flow.sessionId) === queued) {
        documentCommentQueues.delete(flow.sessionId)
      }
    })
}

// 事件 ID 只记最近 1000 条（Set 按插入序淘汰最旧的），防止去重集合无限增长
const rememberDocumentCommentEvent = (eventKey: string): void => {
  processedDocumentCommentEvents.add(eventKey)
  if (
    processedDocumentCommentEvents.size <=
    MAX_REMEMBERED_DOCUMENT_COMMENT_EVENTS
  )
    return
  const oldest = processedDocumentCommentEvents.values().next().value
  if (oldest) processedDocumentCommentEvents.delete(oldest)
}

await startConfiguredBots(botConfigs, collaborationService)

await scheduler.start()
startScheduleFileWatcher({ scheduler, filePath: scheduleFilePath })
startScheduleApi({
  scheduler,
  scheduleStore,
  runStore: scheduleRunStore,
  port: Number(process.env.SCHEDULE_API_PORT ?? 3101),
  token: process.env.SCHEDULE_API_TOKEN,
})
