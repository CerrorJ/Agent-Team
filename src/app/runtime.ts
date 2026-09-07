import type { Bot, BotIdentity } from '../im/lark.js'
import type { ActiveRun } from '../core/task-abort.js'
import type { BotConfig } from '../core/bot-registry.js'
import type { CollaborationInbox } from '../core/collaboration.js'
import type { ClarificationFlowStore } from '../core/clarification.js'
import type { SessionManager } from '../core/session-manager.js'
import type { TeamRegistry } from '../core/team-registry.js'

export interface BotRuntime {
  config: BotConfig
  bot: Bot
  identity: BotIdentity
}

// 应用层共享的运行时状态：入口组装一次，传给 app/ 下各处理模块，
// 避免大家各自持有会话、任务与协作队列的引用
export interface AppRuntime {
  sessions: SessionManager
  teamRegistry: TeamRegistry
  activeRuns: Map<string, ActiveRun>
  contextWindows: Map<string, number>
  botRuntimes: Map<string, BotRuntime>
  processedCollaborationTurns: Set<string>
  collaborationInbox: CollaborationInbox
  clarificationFlows: ClarificationFlowStore
}
