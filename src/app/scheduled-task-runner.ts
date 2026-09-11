// 定时任务的直接执行：借用目标 bot 的既有会话跑一轮 CLI，
// 会话状态走 creating→idle→active→idle，结束后恢复 idle 供下一轮复用。
import { runCli } from '../cli/runner.js'
import { getCliAdapter } from '../cli/registry.js'
import { buildBotPrompt } from '../core/bot-registry.js'
import type { AppRuntime } from './runtime.js'
import type { ScheduledTask } from '../core/schedule.js'
import { markSessionIdle } from './session-view.js'

export const runScheduledTaskDirectly = async (options: {
  runtime: AppRuntime
  task: ScheduledTask
  scheduledFor: string
  defaultProductDeliveryMode: 'local' | 'lark-doc'
}): Promise<{ sessionId?: string }> => {
  const { runtime, task, scheduledFor } = options
  const target = runtime.teamRegistry.get(task.targetBotId)
  if (!target) {
    throw new Error(`定时任务目标成员未注册或未启用: ${task.targetBotId}`)
  }

  // 同一任务的每一轮都解析到同一个话题地址，CLI 会话得以跨轮续接而不是每轮新开
  const messageAddress = {
    messageId: `scheduled-${task.id}`,
    chatId: task.chatId,
    threadId: `scheduled-${task.id}`,
    rootId: '',
  }

  const resolved = await runtime.sessions.resolve(
    messageAddress,
    target.defaultCliId,
    target.id,
    target.workspaceDir,
  )

  let { session } = resolved
  if (resolved.isNew && session.status === 'creating') {
    session = await runtime.sessions.transition(session.id, 'idle')
  }
  if (session.status === 'active') {
    throw new Error('目标 bot 当前会话仍在执行')
  }
  await runtime.sessions.transition(session.id, 'active')

  const prompt = buildBotPrompt(
    target,
    [
      `这是一条由 Agent Team 发起的定时任务，计划触发时间：${scheduledFor}。`,
      task.prompt,
      '直接执行任务要求；如果任务要求把结果推送给你或其他用户，请自行完成推送。',
    ].join('\n\n'),
    runtime.teamRegistry.contextFor(target.id),
    options.defaultProductDeliveryMode,
  )

  const adapter = getCliAdapter(session.cliId)
  const run = new AbortController()
  try {
    const result = await runCli({
      adapter,
      prompt,
      cwd: session.workspaceDir,
      sessionId: session.cliSessionId,
      signal: run.signal,
      // 把群聊与发起人传给子进程，应用层工具（确认卡片等）要知道结果发回哪里
      env: {
        ...target.cliEnv,
        AGENT_TEAM_CHAT_ID: task.chatId,
        AGENT_TEAM_OWNER_OPEN_ID: task.creatorOpenId,
      },
      onEvent: (event) => {
        if (event.type === 'tool_start') {
          console.log(
            `[定时] ${task.id} 开始 ${event.label}${'detail' in event && event.detail ? ` ${event.detail}` : ''}`,
          )
        }
      },
    })

    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId)
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens)
    }
    console.log(`[定时] ${task.id} 直接执行完成`)
    return { sessionId: result.sessionId }
  } finally {
    await markSessionIdle(runtime.sessions, session.id)
  }
}
