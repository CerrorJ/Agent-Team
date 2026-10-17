// 后端故障按账号/模型隔离；不再将某个 Bot 的所有引擎统一封禁。
import { createHash } from 'node:crypto'
import type { CliId } from '../cli/types.js'
import {
  providerFailureGuidance,
  providerFailureLabel,
  type ProviderFailure,
} from './provider-error.js'

export const backendEndpoint = (
  cliId: CliId,
  env: Record<string, string> = {},
): string => {
  const effective = { ...process.env, ...env }
  return (
    (cliId === 'claude'
      ? effective.ANTHROPIC_BASE_URL
      : (effective.OPENAI_BASE_URL ?? effective.CODEX_BASE_URL)) ||
    `${cliId}:default`
  )
}

export const backendScopeKey = (
  cliId: CliId,
  env: Record<string, string> = {},
  scope: 'account' | 'model' = 'account',
): string => {
  const effective = { ...process.env, ...env }

  const credential =
    cliId === 'claude'
      ? effective.ANTHROPIC_AUTH_TOKEN || effective.ANTHROPIC_API_KEY
      : effective.OPENAI_API_KEY || effective.CODEX_API_KEY

  const model =
    cliId === 'claude'
      ? effective.ANTHROPIC_MODEL
      : effective.OPENAI_MODEL || effective.CODEX_MODEL

  // 未显式传凭证时，同 CLI 的本机登录视为共享账号；quota group 可跨端点显式合并。
  const account = effective.AGENT_TEAM_QUOTA_GROUP
    ? ['quota-group', effective.AGENT_TEAM_QUOTA_GROUP]
    : [
        backendEndpoint(cliId, env).replace(/\/$/, ''),
        credential ||
          `${cliId}:local-login:${(cliId === 'codex' ? effective.CODEX_HOME : effective.CLAUDE_CONFIG_DIR) || 'default'}`,
      ]

  return createHash('sha256')
    .update(
      JSON.stringify([
        ...account,
        scope,
        ...(scope === 'model' ? [model || 'default'] : []),
      ]),
    )
    .digest('hex')
}

export interface LimitInfo {
  isLimited: boolean
  resetsText?: string
  expireAt?: number
  reason?: string
  guidance?: string
  failure?: ProviderFailure
}

export class SessionLimitTracker {
  private readonly limits = new Map<
    string,
    { expireAt: number; failure: ProviderFailure }
  >()

  constructor(private readonly now: () => number = Date.now) {}

  markFailure(
    cliId: CliId,
    env: Record<string, string> | undefined,
    failure: ProviderFailure,
  ): void {
    if (failure.type === 'unknown') return
    const key = backendScopeKey(cliId, env, failure.scope)
    const expireAt = this.now() + failure.cooldownMs
    const previous = this.limits.get(key)
    if (!previous || previous.expireAt <= expireAt) {
      this.limits.set(key, { expireAt, failure })
    }
  }

  getLimitInfo(cliId: CliId, env?: Record<string, string>): LimitInfo {
    const entries = (['account', 'model'] as const)
      .flatMap((scope) => {
        const key = backendScopeKey(cliId, env, scope)
        const entry = this.limits.get(key)
        if (!entry) return []
        if (this.now() >= entry.expireAt) {
          this.limits.delete(key)
          return []
        }
        return [entry]
      })
      .sort((a, b) => b.expireAt - a.expireAt)

    const entry = entries[0]
    if (!entry) return { isLimited: false }

    const remaining = Math.max(
      1,
      Math.ceil((entry.expireAt - this.now()) / 1000),
    )

    return {
      isLimited: true,
      expireAt: entry.expireAt,
      failure: entry.failure,
      reason: providerFailureLabel(entry.failure.type),
      guidance: providerFailureGuidance(entry.failure.type),
      resetsText: `${remaining} 秒后可重新尝试（不保证厂家额度已恢复）`,
    }
  }

  clearLimit(cliId: CliId, env?: Record<string, string>): void {
    for (const scope of ['account', 'model'] as const) {
      this.limits.delete(backendScopeKey(cliId, env, scope))
    }
  }
}

export const sessionLimitTracker = new SessionLimitTracker()
