import { ClaudeAdapter } from '../cli/claude-adapter.js'
import { CodexAdapter } from '../cli/codex-adapter.js'
import type { Run } from './business-contracts.js'

/** CLI 选择来自持久快照；不把 Claude 角色静默交给 Codex 执行。 */
export const executionModel = (run: Run) => {
  const role = run.roleSnapshot
  const profile = role.modelProfileSnapshot
  if (profile && profile.provider !== 'cli-managed')
    throw new Error(
      profile.credentialRef
        ? 'CAPABILITY_UNSUPPORTED'
        : 'MODEL_CREDENTIAL_REQUIRED',
    )
  const policy = { permission: role.permission }

  const adapter =
    role.cli === 'claude' ? new ClaudeAdapter(policy) : new CodexAdapter(policy)

  const modelKey = role.cli === 'claude' ? 'ANTHROPIC_MODEL' : 'CODEX_MODEL'

  const effortKey =
    role.cli === 'claude' ? 'CLAUDE_REASONING_EFFORT' : 'CODEX_REASONING_EFFORT'

  return {
    adapter,
    env: {
      ...(role.model ? { [modelKey]: role.model } : {}),
      ...(profile?.reasoningEffort
        ? { [effortKey]: profile.reasoningEffort }
        : {}),
    },
  }
}
