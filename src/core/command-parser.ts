import type { CliId } from '../cli/types.js'

export type SlashCommand =
  | { name: 'close' | 'status' | 'help' | 'new' | 'resume' | 'team' }
  | { name: 'compact'; instructions?: string }
  | { name: 'cd'; path?: string }
  | { name: 'schedules' }
  | { name: 'schedule'; request?: string }

// 匹配 at 机器人+指令 的情况，如 “@AT-Test /close”，也支持没有 @ 的纯指令
const COMMAND_RE = /^(?:@.+?\s+)?\/(close|status|help|new|resume|team)\s*$/
const CD_RE = /^(?:@.+?\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/
const COMPACT_RE = /^(?:@.+?\s+)?\/compact(?:\s+([\s\S]+?))?\s*$/
const SCHEDULE_RE = /^(?:@.+?\s+)?\/schedule(?:\s+([\s\S]+?))?\s*$/
const SCHEDULES_RE = /^(?:@.+?\s+)?\/schedules\s*$/
const CLI_REQUEST_RE = /^(?:@.+?\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/

// 「帮我运行 /status 看看」不会被当成命令,文本必须符合「可选的 @提及 + 一条受支持命令」，解析才会成功
export const parseCommand = (text: string): SlashCommand | undefined => {
  const value = text.trim()
  if (SCHEDULES_RE.test(value)) return { name: 'schedules' }
  const scheduleMatch = SCHEDULE_RE.exec(value)
  if (scheduleMatch) {
    return { name: 'schedule', request: scheduleMatch[1]?.trim() || undefined }
  }
  const cdMatch = CD_RE.exec(value)
  if (cdMatch) return { name: 'cd', path: cdMatch[1]?.trim() || undefined }
  const compactMatch = COMPACT_RE.exec(value)
  if (compactMatch) {
    return {
      name: 'compact',
      instructions: compactMatch[1]?.trim() || undefined,
    }
  }
  const match = COMMAND_RE.exec(value)
  if (!match) return undefined
  return {
    name: match[1] as 'close' | 'status' | 'help' | 'new' | 'resume' | 'team',
  }
}

export interface CliRequest {
  cliId: CliId
  prompt: string
}

// 显式选择执行引擎的请求，如 “@Bot /codex 修复登录 bug”；没带任务文本时 prompt 为空。
export const parseCliRequest = (text: string): CliRequest | undefined => {
  const match = CLI_REQUEST_RE.exec(text.trim())
  if (!match) return undefined
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? '').trim(),
  }
}
