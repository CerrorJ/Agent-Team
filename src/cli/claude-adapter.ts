import { promptInputForPlatform } from './types.js'
import type {
  CliAdapter,
  CliPromptInput,
  CliEvent,
  CliRunStats,
} from './types.js'
import {
  CLAUDE_CLARIFICATION_TOOL_NAME,
  CLAUDE_PRODUCT_SPEC_TOOL_NAME,
  CLAUDE_DISPATCH_TASK_TOOL_NAME,
  CLAUDE_REQUEST_APPROVAL_TOOL_NAME,
  CLAUDE_SCHEDULE_MANAGE_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  claudeAppToolArgs,
} from './app-tools.js'

// 原始数据结构
interface ClaudeEvent {
  type?: unknown
  subtype?: unknown
  model?: unknown
  is_error?: unknown
  result?: unknown
  session_id?: unknown
  duration_ms?: unknown
  num_turns?: unknown
  usage?: unknown
  modelUsage?: unknown
  message?: unknown
}

// 原始数据结构-content中的数据
interface ClaudeContentBlock {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  is_error?: unknown
}

// 卡片展示的tool名称映射
const TOOL_LABELS: Record<string, string> = {
  Agent: '启动子任务',
  Bash: '运行命令',
  Edit: '修改文件',
  Glob: '查找文件',
  Grep: '搜索代码',
  Read: '读取文件',
  Task: '启动子任务',
  TaskOutput: '等待子任务完成',
  WebFetch: '读取网页',
  WebSearch: '搜索资料',
  Write: '写入文件',
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const asNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const asModelName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  return model ? model : undefined
}

const shortPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(normalized.startsWith('/') ? -2 : -3).join('/')
}

const shortText = (value: unknown, maxLength = 72): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

const toolDetail = (name: string, input: unknown): string | undefined => {
  if (!isRecord(input)) return undefined
  if (['Read', 'Edit', 'Write'].includes(name)) {
    return shortPath(input.file_path)
  }
  if (name === 'Glob') return shortText(input.pattern)
  if (name === 'Grep') return shortText(input.pattern)
  if (name === 'Bash') return shortText(input.description)
  if (name === 'Agent' || name === 'Task') return shortText(input.description)
  if (name === 'WebSearch') return shortText(input.query)
  return undefined
}

const messageBlocks = (message: unknown): ClaudeContentBlock[] => {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

// 累计token数
const usageTokens = (usage: unknown): number | undefined => {
  if (!isRecord(usage)) return undefined

  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined)

  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined
}

// 上下文窗口token数
const contextWindowTokens = (modelUsage: unknown): number | undefined => {
  if (!isRecord(modelUsage)) return undefined

  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0)

  return windows.length ? Math.max(...windows) : undefined
}

// 耗时轮次token数统计
const parseStats = (event: ClaudeEvent): CliRunStats | undefined => {
  const usage = isRecord(event.usage) ? event.usage : {}
  const totalTokens = usageTokens(usage)
  const windowTokens = contextWindowTokens(event.modelUsage)

  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
    turns: asNumber(event.num_turns),
    totalTokens,
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    contextWindowTokens: windowTokens,
  }

  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined
}

const outputArgs = (prompt: string, promptInput: CliPromptInput): string[] => {
  return [
    '--dangerously-skip-permissions',
    '-p',
    ...(promptInput === 'argument' ? [prompt] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    ...claudeAppToolArgs(),
  ]
}

export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const
  readonly command = 'claude'
  readonly displayName = 'Claude Code'

  buildArgs(prompt: string, promptInput: CliPromptInput): string[] {
    return outputArgs(prompt, promptInput)
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[] {
    return ['--resume', sessionId, ...outputArgs(prompt, promptInput)]
  }

  buildCompactPlan(sessionId: string, instructions?: string) {
    const command = instructions?.trim()
      ? `/compact ${instructions.trim()}`
      : '/compact'

    return {
      protocol: 'claude-stream-json' as const,
      command: this.command,
      // 现在 prompt 走 stdin（`-p -`），runClaudeCompact 需要这份文本写入子进程。
      prompt: command,
      args: this.buildResumeArgs(
        command,
        sessionId,
        promptInputForPlatform(process.platform),
      ),
    }
  }

  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0]
  }

  parseEvents(line: string): CliEvent[] {
    let event: ClaudeEvent
    try {
      event = JSON.parse(line) as ClaudeEvent
    } catch {
      return []
    }

    //session_id是Claude自己的ID，和session.id不是同一个值session.id 由 Agent Team 生成
    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : undefined

    // Claude Code 启动后会发出 system/init，其中 model 是这次实际使用的模型。
    if (event.type === 'system' && event.subtype === 'init') {
      const model = asModelName(event.model)
      return [
        ...(sessionId ? [{ type: 'session' as const, sessionId }] : []),
        ...(model ? [{ type: 'model' as const, model }] : []),
      ]
    }
    if (event.type === 'assistant') {
      const message = isRecord(event.message) ? event.message : {}
      // message.usage 是运行时token数,随执行过程到达，转化成 context，可以实时更新卡片
      const usedTokens = usageTokens(message.usage)

      const contextEvent: CliEvent[] =
        usedTokens === undefined ? [] : [{ type: 'context', usedTokens }]

      // 遍历全部内容，保留带有 id 和工具名的 tool_use,每次调用会生成独立的 tool_start
      const toolEvents = messageBlocks(event.message).flatMap(
        (block): CliEvent[] => {
          if (
            block.type !== 'tool_use' ||
            typeof block.id !== 'string' ||
            typeof block.name !== 'string'
          )
            return []
          const detail = toolDetail(block.name, block.input)

          const events: CliEvent[] = [
            {
              type: 'tool_start',
              toolUseId: block.id,
              toolName: block.name,
              label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
              ...(detail ? { detail } : {}),
            },
          ]

          // 应用层 MCP 工具：Claude 事件里带 mcp__agent_team__ 前缀，归一成统一名后吐 tool_call
          if (block.name === CLAUDE_CLARIFICATION_TOOL_NAME) {
            events.push({
              type: 'tool_call',
              toolUseId: block.id,
              toolName: 'request_clarification',
              input: block.input,
            })
          }
          if (block.name === CLAUDE_PRODUCT_SPEC_TOOL_NAME) {
            events.push({
              type: 'tool_call',
              toolUseId: block.id,
              toolName: PRODUCT_SPEC_TOOL_NAME,
              input: block.input,
            })
          }
          if (block.name === CLAUDE_DISPATCH_TASK_TOOL_NAME) {
            events.push({
              type: 'tool_call',
              toolUseId: block.id,
              toolName: DISPATCH_TASK_TOOL_NAME,
              input: block.input,
            })
          }
          if (block.name === CLAUDE_REQUEST_APPROVAL_TOOL_NAME) {
            events.push({
              type: 'tool_call',
              toolUseId: block.id,
              toolName: REQUEST_APPROVAL_TOOL_NAME,
              input: block.input,
            })
          }
          if (block.name === CLAUDE_SCHEDULE_MANAGE_TOOL_NAME) {
            events.push({
              type: 'tool_call',
              toolUseId: block.id,
              toolName: SCHEDULE_MANAGE_TOOL_NAME,
              input: block.input,
            })
          }
          return events
        },
      )

      return [...contextEvent, ...toolEvents]
    }
    if (event.type === 'user') {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (
          block.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string'
        ) {
          return []
        }
        return [
          {
            type: 'tool_end',
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ]
      })
    }
    // 任务结束时还会发出 result
    if (event.type !== 'result') return []
    if (event.is_error) {
      return [
        {
          type: 'error',
          message:
            typeof event.result === 'string'
              ? event.result
              : 'Claude Code 执行失败',
          ...(sessionId ? { sessionId } : {}),
        },
      ]
    }
    if (typeof event.result !== 'string') return []
    const stats = parseStats(event)
    //result.usage 记录的是整次执行累计消耗，可能包含多轮输入、输出和缓存读取.写入 totalTokens，不是当前上下文的总数，当前上下文的总数要等 result.modelUsage 出来才清楚
    return [
      {
        type: 'result',
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ]
  }
}
