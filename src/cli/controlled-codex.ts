import type { CliPromptInput } from './types.js'

export interface ControlledCodexPolicy {
  permission: 'read-only' | 'workspace-write'
}

/** 桌面执行明确权限，不继承旧飞书入口的 bypass，也不修改用户 CLI 配置。 */
export const controlledCodexArgs = (input: {
  prompt: string
  promptInput: CliPromptInput
  policy: ControlledCodexPolicy
  model?: string
  sessionId?: string
  reasoningEffort?: string
}): string[] => {
  const args = [
    '--sandbox',
    input.policy.permission,
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=false',
  ]

  if (process.platform === 'win32') args.push('-c', 'windows.sandbox="mxc"')
  args.push('exec')
  if (input.sessionId) args.push('resume')
  args.push('--json', '--ignore-user-config', '--ignore-rules')
  if (input.model) args.push('--model', input.model)
  if (input.reasoningEffort)
    args.push(
      '-c',
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    )
  if (input.sessionId) args.push(input.sessionId)
  args.push(input.promptInput === 'stdin' ? '-' : input.prompt)
  return args
}
