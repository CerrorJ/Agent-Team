/**
 * Agent Team 入口。
 * 当前阶段：飞书消息驱动 Claude Code / Codex 完成任务。
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { startBot, type Bot, type BotIdentity } from './im/lark.js'
import {
  answerContinuation,
  answerNeedsContinuation,
  buildCollaborationCard,
  buildResumeCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from './im/card.js'
import {
  CollaborationInbox,
  collaborationTurnKey,
  type CollaborationMessage,
} from './core/collaboration.js'
import { resolveMentions, extractResourceKeys } from './im/message-parser.js'
import { parseCliRequest, parseCommand } from './core/command-parser.js'
import { SessionManager, type Session } from './core/session-manager.js'
import { JsonSessionStore } from './core/session-store.js'
import { TaskProgressTracker } from './core/task-progress.js'
import { requestTaskAbort, type ActiveRun } from './core/task-abort.js'
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from './core/workspace.js'
import {
  buildBotPrompt,
  loadBotConfigs,
  type BotConfig,
} from './core/bot-registry.js'
import { getCliAdapter, listCliAdapters } from './cli/registry.js'
import type { CliAdapter } from './cli/types.js'
import { runCli } from './cli/runner.js'
import { compactCliSession } from './cli/native-compact.js'
import { listNativeCliSessions } from './cli/native-sessions.js'

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join('config', 'bots.json'),
)

const botConfigs = await loadBotConfigs(botConfigPath)

await Promise.all(
  botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)),
)

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

// 运行中的任务：sessionId → 中止控制器 + 发起人（停止任务时校验权限）
const activeRuns = new Map<string, ActiveRun>()
// 记住各会话的上下文窗口大小，供下一轮执行的进度计算
const contextWindows = new Map<string, number>()
interface BotRuntime {
  config: BotConfig
  bot: Bot
  identity: BotIdentity
}
const botRuntimes = new Map<string, BotRuntime>()
const processedCollaborationTurns = new Set<string>()
const collaborationInbox = new CollaborationInbox()
console.log('Agent Team 启动，正在建立飞书长连接…')
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，已恢复 ${sessions.size} 个会话`,
)
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`)
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`,
  )
}

// 拉起 cli
const executeCli = (
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]['onEvent'],
) => {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId,
    signal,
    onEvent,
  })
}

const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
}

const formatSessionStatus = (session: Session, botId: string): string => {
  const adapter = getCliAdapter(session.cliId)
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `工作目录：${session.workspaceDir}`,
    `CLI 会话：${session.cliSessionId ?? '(尚未建立)'}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join('\n')
}

// 仅 active 状态回落 idle，避免覆盖 closed 等终态
const markSessionIdle = async (sessionId: string): Promise<void> => {
  if (sessions.get(sessionId)?.status !== 'active') return
  await sessions.transition(sessionId, 'idle')
  console.log(`[会话] id=${sessionId} status=idle`)
}

// 派发函数。它先生成一段短任务编号并登记内部任务，再发送卡片和真实 @ 内容。任何一步失败都会执行撤销操作
const sendCollaborationMessage = async (options: {
  senderConfig: BotConfig
  senderBot: Bot
  replyToMessageId: string
  targetBotId: string
  taskId: string
  workspaceDir: string
  prompt: string
}): Promise<void> => {
  const target = botRuntimes.get(options.targetBotId)
  if (!target) throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`)

  const collaboration: CollaborationMessage = {
    dispatchId: randomUUID().replaceAll('-', '').slice(0, 12),
    taskId: options.taskId,
    fromBotId: options.senderConfig.id,
    toBotId: options.targetBotId,
    workspaceDir: options.workspaceDir,
    prompt: options.prompt,
  }

  collaborationInbox.register(collaboration)
  try {
    const cardMessageId = await options.senderBot.replyCard(
      options.replyToMessageId,
      buildCollaborationCard({
        senderName:
          botRuntimes.get(options.senderConfig.id)?.identity.name ??
          options.senderConfig.id,
        targetName: target.identity.name,
        workspaceName: basename(options.workspaceDir),
        prompt: options.prompt,
      }),
      true,
    )

    if (!cardMessageId) throw new Error('飞书没有返回协作卡片 message_id')

    const mentionMessageId = await options.senderBot.replyMention(
      cardMessageId,
      target.identity,
      `新的代码审查任务（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
      true,
    )

    if (!mentionMessageId) throw new Error('飞书没有返回协作通知 message_id')
  } catch (error) {
    collaborationInbox.consume(collaboration.dispatchId, collaboration.toBotId)
    throw error
  }
  console.log(
    `[协作] task=${options.taskId} ${options.senderConfig.id} -> ${options.targetBotId}`,
  )
}

const sendResultNotification = async (options: {
  bot: Bot
  replyToMessageId: string
  target: BotIdentity
  text: string
  replyInThread: boolean
}): Promise<void> => {
  try {
    await options.bot.replyMention(
      options.replyToMessageId,
      options.target,
      options.text,
      options.replyInThread,
    )
  } catch (error) {
    console.error('[通知] 结果通知发送失败:', (error as Error).message)
  }
}

const startConfiguredBot = async (config: BotConfig): Promise<void> => {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    // 卡片「停止任务」回调：定位任务并校验发起人，结果映射成不同的 toast
    onCardAction: async (action) => {
      // 「恢复」按钮回调：校验会话归属与状态后，重新拉取当前目录的 CLI 会话清单，
      // 确认目标会话仍然存在（卡片可能是旧快照，会话也可能已被 /cd 换目录），再切换绑定并刷新卡片。
      if (action.value.action === 'resume_cli_session') {
        const agentSessionId =
          typeof action.value.agentSessionId === 'string'
            ? action.value.agentSessionId
            : ''

        const cliSessionId =
          typeof action.value.cliSessionId === 'string'
            ? action.value.cliSessionId
            : ''

        const session = sessions.get(agentSessionId)
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

          const updated = await sessions.setCliSessionId(
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
          return {
            toast: { type: 'error', content: (error as Error).message },
          }
        }
      }
      if (action.value.action !== 'abort_task') return undefined

      const sessionId =
        typeof action.value.sessionId === 'string' ? action.value.sessionId : ''

      const outcome = requestTaskAbort(
        activeRuns,
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
          toast: { type: 'warning', content: '只有任务发起人可以停止它。' },
        }
      }
      if (outcome === 'already_stopping') {
        return { toast: { type: 'info', content: '正在停止任务，请稍候。' } }
      }
      return { toast: { type: 'success', content: '已发送停止指令。' } }
    },
    onMessage: async (msg, bot) => {
      const resolved = resolveMentions(msg.text, msg.mentions)
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
          console.log(
            `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
          )
          return
        }
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
      // /compact 复用普通任务的执行管线（登记、卡片、取消），用这个标志区分标题与后处理逻辑
      const isCompacting = command?.name === 'compact'
      const taskText = collaboration?.prompt ?? cliRequest?.prompt ?? resolved
      const prompt = buildBotPrompt(config.systemPrompt, taskText)
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

      if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
        await bot.reply(
          msg.messageId,
          `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
          hasThread,
        )
        return
      }
      if (command?.name === 'help') {
        await bot.reply(
          msg.messageId,
          [
            '/status 查看当前会话',
            '/new 开启一个全新的 CLI 会话',
            '/resume 选择当前工作目录中的 CLI 会话',
            '/compact [要求] 使用当前引擎原生整理上下文',
            '/cd 查看当前工作目录',
            '/cd <目录> 切换当前话题的工作目录',
            '/close 关闭当前会话',
            '/help 查看命令',
            '/claude <任务> 新话题使用 Claude Code',
            '/codex <任务> 新话题使用 Codex',
          ].join('\n'),
          hasThread,
        )
        return
      }
      // /new 只清空话题绑定的 cliSessionId，下一条任务自然开启全新会话；旧会话仍在磁盘上，/resume 可找回
      if (command?.name === 'new') {
        if (session.status === 'active') {
          await bot.reply(
            msg.messageId,
            '当前任务结束后才能新建会话。',
            hasThread,
          )
          return
        }
        if (session.status === 'closed') {
          await bot.reply(msg.messageId, '当前话题的会话已经关闭。', hasThread)
          return
        }
        await sessions.clearCliSessionId(session.id)
        await bot.replyCard(
          msg.messageId,
          buildSessionNoticeCard({
            title: '新会话已就绪',
            template: 'green',
            detail: `下一条任务会由 ${cliAdapter.displayName} 开启全新的 CLI 会话。\n\n旧会话仍然保留，可以随时用 \`/resume\` 找回来。`,
          }),
          hasThread,
        )
        return
      }
      // /resume 列出当前工作目录下的 CLI 会话并发选择卡片，实际切换由卡片「恢复」按钮回调完成
      if (command?.name === 'resume') {
        if (session.status === 'active') {
          await bot.reply(
            msg.messageId,
            '当前任务结束后才能切换会话。',
            hasThread,
          )
          return
        }
        if (session.status === 'closed') {
          await bot.reply(msg.messageId, '当前话题的会话已经关闭。', hasThread)
          return
        }
        try {
          const nativeSessions = await listNativeCliSessions({
            adapter: cliAdapter,
            cwd: session.workspaceDir,
          })

          await bot.replyCard(
            msg.messageId,
            buildResumeCard({
              agentSessionId: session.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: session.cliSessionId,
              sessions: nativeSessions,
            }),
            hasThread,
          )
        } catch (error) {
          await bot.reply(
            msg.messageId,
            `无法读取 ${cliAdapter.displayName} 会话：${(error as Error).message}`,
            hasThread,
          )
        }
        return
      }
      // /compact 在现有 CLI 会话内做原生压缩，必须有已绑定的 cliSessionId（即至少完成过一次任务）
      if (command?.name === 'compact') {
        if (session.status === 'active') {
          await bot.reply(
            msg.messageId,
            '当前任务结束后才能整理上下文。',
            hasThread,
          )
          return
        }
        if (session.status === 'closed') {
          await bot.reply(msg.messageId, '当前话题的会话已经关闭。', hasThread)
          return
        }
        if (!session.cliSessionId) {
          await bot.reply(
            msg.messageId,
            '当前还没有可整理的 CLI 会话。先完成一次任务，再使用 /compact。',
            hasThread,
          )
          return
        }
      }
      if (command?.name === 'status') {
        await bot.reply(
          msg.messageId,
          formatSessionStatus(session, config.id),
          hasThread,
        )
        return
      }
      if (command?.name === 'cd') {
        if (!command.path) {
          await bot.reply(
            msg.messageId,
            `当前工作目录：${session.workspaceDir}`,
            hasThread,
          )
          return
        }
        if (session.status === 'active') {
          await bot.reply(
            msg.messageId,
            '当前任务仍在执行，结束后再切换工作目录。',
            hasThread,
          )
          return
        }
        try {
          const workspaceDir = resolveWorkspacePath(
            command.path,
            session.workspaceDir,
          )

          await ensureWorkspaceDirectory(workspaceDir)
          const changed = workspaceDir !== session.workspaceDir
          await sessions.setWorkspaceDir(session.id, workspaceDir)
          await bot.reply(
            msg.messageId,
            changed
              ? `工作目录已切换到：${workspaceDir}\n下一条任务会在这里建立新的 CLI 会话。`
              : `当前工作目录已经是：${workspaceDir}`,
            hasThread,
          )
        } catch (error) {
          await bot.reply(
            msg.messageId,
            `无法切换工作目录：${(error as Error).message}`,
            hasThread,
          )
        }
        return
      }
      if (command?.name === 'close') {
        const active = activeRuns.get(session.id)
        if (active) {
          active.cancelMode = 'close'
          active.controller.abort()
        }
        if (session.status !== 'closed')
          await sessions.transition(session.id, 'closed')
        await bot.reply(
          msg.messageId,
          '当前会话已关闭。需要继续时，请新开一个话题。',
          hasThread,
        )
        return
      }

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
      if (session.status === 'active') {
        await bot.reply(
          msg.messageId,
          '当前会话还在执行，请等任务结束后再追问。',
          hasThread,
        )
        return
      }
      if (
        collaboration &&
        session.workspaceDir !== collaboration.workspaceDir
      ) {
        await ensureWorkspaceDirectory(collaboration.workspaceDir)
        session = await sessions.setWorkspaceDir(
          session.id,
          collaboration.workspaceDir,
        )
      }

      await sessions.transition(session.id, 'active')
      const run = new AbortController()

      const activeRun: ActiveRun = {
        controller: run,
        ownerOpenId: msg.senderOpenId,
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
        await markSessionIdle(session.id)
        throw error
      }

      if (!cardId) {
        console.error('[卡片] 响应里没有 message_id，无法继续更新')
        if (activeRuns.get(session.id)?.controller === run)
          activeRuns.delete(session.id)
        await markSessionIdle(session.id)
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

      // 让事件回调尽快返回，CLI 在后台继续执行。
      // /compact 走原生压缩通道而非 executeCli，但结果包装成相同的 { answer, sessionId, stats } 形状，
      // 下面的成功/取消/失败处理因此可以共用。
      const execution = isCompacting
        ? compactCliSession({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: command.instructions,
            signal: run.signal,
          }).then((result) => ({
            answer: result.message ?? '',
            sessionId: result.sessionId,
            stats: undefined,
          }))
        : executeCli(
            cliAdapter,
            prompt,
            session.workspaceDir,
            session.cliSessionId,
            run.signal,
            (event) => {
              if (
                event.type !== 'tool_start' &&
                event.type !== 'tool_end' &&
                event.type !== 'context'
              )
                return
              progress.accept(event)
              renderProgress()
            },
          )

      void execution
        // 成功：落库 CLI 会话 id，更新完成卡片并续发超长回答
        .then(async (result) => {
          clearInterval(progressHeartbeat)
          // 压缩不产生新会话 ID、也没有 token 统计，这两项只在普通任务里落库
          if (!isCompacting && result.sessionId) {
            await sessions.setCliSessionId(session.id, result.sessionId)
          }
          if (!isCompacting && result.stats?.contextWindowTokens) {
            contextWindows.set(session.id, result.stats.contextWindowTokens)
          }
          const snapshot = progress.snapshot()
          await cardUpdater.finish(
            isCompacting
              ? // 压缩结果里 message 非空 = CLI 认为无需压缩（如 Claude 返回
                // "Not enough messages to compact."），message 为空才是真正压缩完成
                buildSessionNoticeCard({
                  title: result.answer ? '暂时无需整理' : '上下文已整理',
                  template: result.answer ? 'grey' : 'green',
                  detail:
                    result.answer ||
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
                  answer: result.answer,
                  stats: result.stats,
                }),
          )
          if (!isCompacting && answerNeedsContinuation(result.answer)) {
            for (const chunk of splitLongText(
              answerContinuation(result.answer),
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
              target: { openId: msg.senderOpenId, name: '' },
              text: isCompacting
                ? '上下文整理已完成，请查看上方结果。'
                : '任务已完成，请查看上方结果。',
              replyInThread: hasThread,
            })
          }
          if (!isCompacting) {
            try {
              if (!collaboration && config.reviewBy) {
                await sendCollaborationMessage({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: config.reviewBy,
                  taskId: randomUUID(),
                  workspaceDir: session.workspaceDir,
                  prompt: [
                    '请独立检查当前工作目录中刚完成的实现。',
                    `原始任务：${taskText}`,
                    '请直接读取代码和改动，指出明确问题；没有问题时说明检查通过。',
                  ].join('\n\n'),
                })
              } else if (collaboration && senderRuntime) {
                await sendResultNotification({
                  bot,
                  replyToMessageId: msg.messageId,
                  target: senderRuntime.identity,
                  text: '代码审查已完成，请查看上方结果。',
                  replyInThread: hasThread,
                })
              }
            } catch (error) {
              const message = (error as Error).message
              console.error('[协作] 派发失败:', message)
              await bot.reply(
                msg.messageId,
                `协作派发失败：${message}`,
                hasThread,
              )
            }
          }
        })
        // 取消/失败：按 abort 状态分别落取消卡片或失败卡片
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
              // 协作场景 @ 回派发 bot，普通任务 @ 发起用户
              target: senderRuntime?.identity ?? {
                openId: msg.senderOpenId,
                name: '',
              },
              text: '任务已停止，请查看上方状态。',
              replyInThread: hasThread,
            })
            return
          }
          const message = (error as Error).message
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
              openId: msg.senderOpenId,
              name: '',
            },
            text: '任务执行失败，请查看上方错误信息。',
            replyInThread: hasThread,
          })
        })
        // 收尾：注销 activeRuns 登记并回落 idle
        .finally(async () => {
          clearInterval(progressHeartbeat)
          if (activeRuns.get(session.id)?.controller === run) {
            activeRuns.delete(session.id)
          }
          try {
            await markSessionIdle(session.id)
          } catch (error) {
            console.error('[会话] 保存空闲状态失败:', (error as Error).message)
          }
        })
        .catch((error) => {
          console.error('[任务] 回传或收尾失败:', (error as Error).message)
        })
    },
  })

  const identity = await startedBot.getIdentity()
  const runtime = { config, bot: startedBot, identity }
  botRuntimes.set(config.id, runtime)
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  )
}

await Promise.all(botConfigs.map(startConfiguredBot))
