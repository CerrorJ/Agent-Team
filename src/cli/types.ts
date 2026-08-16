export type CliId = 'claude' | 'codex'

export type CliPromptInput = 'argument' | 'stdin'

/** Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。 */
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
// tool_start 与 tool_end 通过 toolUseId 关联一次工具调用，
// result.stats 则保存最终耗时、轮次与模型窗口
export type CliEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool_start'
      toolUseId: string
      toolName: string
      label: string
      detail?: string
    }
  | { type: 'tool_end'; toolUseId: string; failed: boolean }
  | { type: 'context'; usedTokens: number }
  | { type: 'result'; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: 'error'; message: string; sessionId?: string }

export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  // 新会话组装参数
  buildArgs(prompt: string, promptInput: CliPromptInput): string[]
  // 已有会话续接组装参数
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[]
  // 原始输出 -> 统一事件
  parseEvents(line: string): CliEvent[]
}

export interface CliRunResult {
  answer: string
  sessionId?: string
  stats?: CliRunStats
}
