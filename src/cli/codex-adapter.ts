import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CliAdapter,
  CliPromptInput,
  CliEvent,
  CliRunStats,
} from './types.js'
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  codexAppToolArgs,
} from './app-tools.js'

interface CodexEvent {
  type?: unknown
  thread_id?: unknown
  model?: unknown
  item?: unknown
  usage?: unknown
  error?: unknown
  message?: unknown
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

const configModel = (path: string): string | undefined => {
  try {
    const content = readFileSync(path, 'utf8')
    const match = content.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m)
    return match ? asModelName(match[1]) : undefined
  } catch {
    return undefined
  }
}

// Codex exec 的 thread.started 通常不返回 model；先读 Agent Team profile，
// 缺失时回退用户的默认 config.toml。CLI 真正报告模型时会优先采用报告值。
const configuredCodexModel = (): string | undefined => {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return (
    configModel(join(codexHome, 'agent-team-runtime.config.toml')) ??
    configModel(join(codexHome, 'config.toml'))
  )
}

const shortText = (value: unknown, maxLength = 72): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

const firstChangedPath = (
  item: Record<string, unknown>,
): string | undefined => {
  if (typeof item.path === 'string') return shortText(item.path)
  if (!Array.isArray(item.changes)) return undefined
  const change = item.changes.find(isRecord)
  return change ? shortText(change.path) : undefined
}

const toolInfo = (
  item: Record<string, unknown>,
):
  | {
      toolName: string
      label: string
      detail?: string
    }
  | undefined => {
  if (item.type === 'command_execution') {
    const detail = shortText(item.command)
    return {
      toolName: 'Bash',
      label: '运行命令',
      ...(detail ? { detail } : {}),
    }
  }
  if (item.type === 'file_change') {
    const detail = firstChangedPath(item)
    return {
      toolName: 'Edit',
      label: '修改文件',
      ...(detail ? { detail } : {}),
    }
  }
  if (item.type === 'web_search') {
    const detail = shortText(item.query)
    return {
      toolName: 'WebSearch',
      label: '搜索资料',
      ...(detail ? { detail } : {}),
    }
  }
  if (item.type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : ''
    const tool = typeof item.tool === 'string' ? item.tool : ''
    const detail = shortText([server, tool].filter(Boolean).join('.'))
    return {
      toolName: 'MCP',
      label: '调用外部工具',
      ...(detail ? { detail } : {}),
    }
  }
  return undefined
}

const parseStats = (usage: unknown): CliRunStats | undefined => {
  if (!isRecord(usage)) return undefined
  const inputTokens = asNumber(usage.input_tokens)
  const outputTokens = asNumber(usage.output_tokens)
  const cacheReadTokens = asNumber(usage.cached_input_tokens)

  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0)

  const stats: CliRunStats = {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  }

  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined
}

const errorMessage = (event: CodexEvent): string => {
  if (typeof event.message === 'string') return event.message
  if (isRecord(event.error) && typeof event.error.message === 'string') {
    return event.error.message
  }
  return 'Codex 执行失败'
}

export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const
  readonly command = 'codex'
  readonly displayName = 'Codex'

  // 单次任务
  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    options?: { model?: string },
  ): string[] {
    const args = [
      ...codexAppToolArgs(),
      'exec',
      '--json',
      '--skip-git-repo-check',
    ]

    if (options?.model) {
      args.push('-m', options.model)
    }

    // Windows 上沙箱功能不支持，必须完全禁用；approvals 也一并绕过。
    if (process.platform === 'win32') {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    } else {
      args.push('--yolo')
    }
    // 从 stdin 读取 prompt，规避 Windows 下 shell 参数转义问题。
    args.push(promptInput === 'stdin' ? '-' : prompt)
    return args
  }

  // 多轮询问使用
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    options?: { model?: string },
  ): string[] {
    const args = [
      ...codexAppToolArgs(),
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
    ]

    if (options?.model) {
      args.push('-m', options.model)
    }

    args.push(sessionId)

    // Windows 上沙箱功能不支持，必须完全禁用；approvals 也一并绕过。
    if (process.platform === 'win32') {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    } else {
      args.push('--yolo')
    }
    // 从 stdin 读取 prompt，规避 Windows 下 shell 参数转义问题。
    args.push(promptInput === 'stdin' ? '-' : prompt)
    return args
  }

  // exec 模式没有压缩指令，压缩只能通过 app-server 的 JSON-RPC 通道发起（thread/compact/start）
  buildCompactPlan(sessionId: string) {
    return {
      protocol: 'codex-app-server' as const,
      command: this.command,
      args: ['app-server', '--stdio'],
      sessionId,
    }
  }

  parseEvents(line: string): CliEvent[] {
    let event: CodexEvent
    try {
      event = JSON.parse(line) as CodexEvent
    } catch {
      return []
    }

    if (
      event.type === 'thread.started' &&
      typeof event.thread_id === 'string'
    ) {
      const reportedModel = asModelName(event.model)
      const model = reportedModel ?? configuredCodexModel()
      return [
        ...(model
          ? [
              {
                type: 'model' as const,
                model,
                source: reportedModel
                  ? ('reported' as const)
                  : ('configured' as const),
              },
            ]
          : []),
        { type: 'session', sessionId: event.thread_id },
      ]
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      return [{ type: 'error', message: errorMessage(event) }]
    }
    if (event.type === 'turn.completed') {
      const stats = parseStats(event.usage)
      return stats ? [{ type: 'stats', stats }] : []
    }
    if (!isRecord(event.item)) return []
    const item = event.item
    if (
      event.type === 'item.completed' &&
      item.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      return [{ type: 'result', answer: item.text }]
    }
    if (typeof item.id !== 'string') return []
    const tool = toolInfo(item)
    if (!tool) return []
    if (event.type === 'item.started') {
      const events: CliEvent[] = [
        {
          type: 'tool_start',
          toolUseId: item.id,
          ...tool,
        },
      ]

      // 应用层 MCP 工具（agent_team 服务）：额外吐 tool_call，把原始入参交给应用层
      if (
        item.type === 'mcp_tool_call' &&
        item.server === 'agent_team' &&
        (item.tool === CLARIFICATION_TOOL_NAME ||
          item.tool === PRODUCT_SPEC_TOOL_NAME ||
          item.tool === DISPATCH_TASK_TOOL_NAME ||
          item.tool === REQUEST_APPROVAL_TOOL_NAME ||
          item.tool === SCHEDULE_MANAGE_TOOL_NAME)
      ) {
        events.push({
          type: 'tool_call',
          toolUseId: item.id,
          toolName: item.tool,
          input: item.arguments ?? item.input,
        })
      }
      return events
    }
    if (event.type === 'item.completed') {
      const exitCode = asNumber(item.exit_code)
      return [
        {
          type: 'tool_end',
          toolUseId: item.id,
          failed:
            item.status === 'failed' ||
            (exitCode !== undefined && exitCode !== 0),
        },
      ]
    }
    return []
  }
}
