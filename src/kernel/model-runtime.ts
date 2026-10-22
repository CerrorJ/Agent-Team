import { ClaudeAdapter } from '../cli/claude-adapter.js'
import { CodexAdapter } from '../cli/codex-adapter.js'
import type { Run } from './business-contracts.js'
import type { ModelProfile } from './product-contracts.js'
import type { CliAdapter } from '../cli/types.js'
import {
  credentialBindingSchema,
  type CredentialResolver,
} from './credential-contracts.js'

/** CLI 和模型来自不可变快照；只有运行时向可信宿主解析密钥，业务存储不接触明文。 */
export const executionModel = async (
  run: Run,
  credentials?: CredentialResolver,
): Promise<{
  adapter: CliAdapter
  env: Record<string, string>
  environment?: 'isolated'
}> => {
  const role = run.roleSnapshot
  const profile = role.modelProfileSnapshot
  const custom = await resolveProvider({ profile, cli: role.cli, credentials })
  const policy = { permission: role.permission }

  const adapter =
    role.cli === 'claude'
      ? new ClaudeAdapter(policy)
      : new CodexAdapter({
          ...policy,
          ...(custom ? { providerBaseUrl: custom.baseUrl } : {}),
        })

  const modelKey = role.cli === 'claude' ? 'ANTHROPIC_MODEL' : 'OPENAI_MODEL'

  const effortKey =
    role.cli === 'claude' ? 'CLAUDE_REASONING_EFFORT' : 'CODEX_REASONING_EFFORT'

  return {
    adapter,
    ...(custom ? { environment: 'isolated' as const } : {}),
    env: {
      ...(role.model ? { [modelKey]: role.model } : {}),
      ...(profile?.reasoningEffort
        ? { [effortKey]: profile.reasoningEffort }
        : {}),
      ...custom?.env,
    },
  }
}

const resolveProvider = async (input: {
  profile: ModelProfile | null | undefined
  cli: Run['roleSnapshot']['cli']
  credentials: CredentialResolver | undefined
}) => {
  const { profile, cli, credentials } = input
  if (!profile || profile.provider === 'cli-managed') return undefined

  const expected =
    cli === 'codex' ? 'openai-compatible' : 'anthropic-compatible'

  if (profile.cli !== cli || profile.provider !== expected)
    throw new Error('CLI_MODEL_MISMATCH')
  if (!profile.credentialRef || !credentials)
    throw new Error('MODEL_CREDENTIAL_REQUIRED')

  const binding = credentialBindingSchema.parse({
    reference: profile.credentialRef,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
  })

  const secret = validateSecret(await credentials(binding))

  const env: Record<string, string> =
    cli === 'codex'
      ? { WEFTPILOT_MODEL_SECRET: secret, OPENAI_BASE_URL: binding.baseUrl }
      : {
          ANTHROPIC_API_KEY: secret,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_BASE_URL: binding.baseUrl,
        }

  env.AGENT_TEAM_QUOTA_GROUP = ''

  return {
    baseUrl: binding.baseUrl,
    env,
  }
}

const validateSecret = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 16384)
    throw new Error('MODEL_CREDENTIAL_REQUIRED')
  return value
}
