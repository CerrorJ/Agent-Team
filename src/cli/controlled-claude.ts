import type { CliPromptInput } from './types.js'
import { humanOutputJsonSchema } from './structured-human-output.js'

export interface ControlledClaudePolicy {
  permission: 'read-only' | 'workspace-write'
  humanRequests?: boolean
}

/** 原生 Windows 没有 Claude shell 沙箱，因此两平台统一先开放受限文件工具，不提供无隔离命令。 */
export const controlledClaudeArgs = (input: {
  prompt: string
  promptInput: CliPromptInput
  policy: ControlledClaudePolicy
  model?: string
  reasoningEffort?: string
  sessionId?: string
}): string[] => {
  const tools =
    input.policy.permission === 'workspace-write'
      ? 'Read,Glob,Grep,Edit,Write'
      : 'Read,Glob,Grep'

  const args = [
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--settings',
    '{"disableAllHooks":true}',
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  if (input.policy.humanRequests)
    args.push('--json-schema', humanOutputJsonSchema())
  if (input.model) args.push('--model', input.model)
  if (input.reasoningEffort) args.push('--effort', input.reasoningEffort)
  if (input.sessionId) args.push('--resume', input.sessionId)
  args.push('-p')
  if (input.promptInput === 'argument') args.push(input.prompt)
  return args
}
