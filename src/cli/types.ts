export type CliId = 'claude' | 'codex'

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

// 原生压缩的执行计划：两家 CLI 能力不同，只能各走各的协议——
// Claude Code 用 `-p --resume <id>` 执行 /compact 指令并解析 stream-json 输出；
// Codex 的 exec 模式不支持压缩指令，必须起 app-server 走 JSON-RPC（thread/resume + thread/compact/start）。
// 详见 native-compact.ts 的两个分支实现。
export type CliCompactPlan =
  | {
      protocol: 'claude-stream-json'
      command: string
      args: string[]
      prompt: string
    }
  | {
      protocol: 'codex-app-server'
      command: string
      args: string[]
      sessionId: string
    }

export type CliPromptInput = 'argument' | 'stdin'

// Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。
export const promptInputForPlatform = (
  platform: NodeJS.Platform,
): CliPromptInput => (platform === 'win32' ? 'stdin' : 'argument')

export interface CliRunStats {
  durationMs?: number
  turns?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextUsedTokens?: number
  contextWindowTokens?: number
}

//恢复卡片只需要统一的三项信息：会话 ID、标题和最后更新时间
export interface CliSessionSummary {
  id: string
  title: string
  updatedAt: string
}

// tool_start 与 tool_end 通过 toolUseId 关联一次工具调用，
// result.stats 则保存最终耗时、轮次与模型窗口。
// stats 事件由适配器在执行中途汇报（如 codex 每个 turn.completed），
// runner 记下最后一份，result 事件本身没带统计时用它兜底。
// tool_call 只为应用层工具（如 request_clarification）发出：
// tool_start 面向进度展示（带 label），tool_call 携带原始入参供应用层重建状态。
export type CliEvent =
  | { type: 'session'; sessionId: string }
  // 模型信息仅用于卡片展示，不参与会话状态机。Codex 事件未报告模型时使用本机配置兜底。
  | { type: 'model'; model: string; source: 'reported' | 'configured' }
  | {
      type: 'tool_start'
      toolUseId: string
      toolName: string
      label: string
      detail?: string
    }
  | { type: 'tool_end'; toolUseId: string; failed: boolean }
  | { type: 'context'; usedTokens: number }
  | { type: 'stats'; stats: CliRunStats }
  | {
      type: 'tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    }
  | { type: 'result'; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: 'error'; message: string; sessionId?: string }

export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  // 新会话组装参数
  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    options?: { model?: string; reasoningEffort?: string },
  ): string[]
  // 已有会话续接组装参数
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    options?: { model?: string; reasoningEffort?: string },
  ): string[]
  // 组装在已有会话内执行原生压缩的子进程计划
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan
  // 原始输出 -> 统一事件
  parseEvents(line: string): CliEvent[]
}

export interface CliRunResult {
  answer: string
  sessionId?: string
  stats?: CliRunStats
  // 本次运行里调用成功的应用层工具（失败的在 tool_end 时剔除）
  toolCalls?: Array<{
    toolUseId: string
    toolName: string
    input: unknown
  }>
}
