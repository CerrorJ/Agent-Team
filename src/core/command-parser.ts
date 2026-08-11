export type CommandName = 'close' | 'status' | 'help'

export interface SlashCommand {
  name: CommandName
}

// 匹配 at 机器人+指令 的情况，如 “@AT-Test /close”，也支持没有 @ 的纯指令
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/

// 「帮我运行 /status 看看」不会被当成命令,文本必须符合「可选的 @提及 + 一条受支持命令」，解析才会成功
export const parseCommand = (text: string): SlashCommand | undefined => {
  const match = COMMAND_RE.exec(text.trim())
  if (!match) return undefined
  return { name: match[1] as CommandName }
}
