export type CliId = 'claude'

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'result'; answer: string; sessionId?: string }
  | { type: 'error'; message: string; sessionId?: string }

export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  // 新会话组装参数
  buildArgs(prompt: string): string[]
  // 已有会话续接
  buildResumeArgs(prompt: string, sessionId: string): string[]
  // 原始输出 -> 统一事件
  parseEvent(line: string): CliEvent | undefined
}

export interface CliRunResult {
  answer: string
  sessionId?: string
}
