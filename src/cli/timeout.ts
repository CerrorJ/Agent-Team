import type { CliAdapter } from './types.js'

// Node 的 setTimeout 延迟上限是 32 位有符号整数（2^31-1 ≈ 24.8 天），
// 超限不报错，只发 TimeoutOverflowWarning 然后把延迟改成 1ms 立即触发。
// 统一在这里布防：timeoutMs <= 0 视为不限时（不设防），正数钳制在上限内。
export const TIMEOUT_MAX_MS = 2_147_483_647

export const armTimeout = (
  onTimeout: () => void,
  timeoutMs: number,
): NodeJS.Timeout | undefined => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
  return setTimeout(onTimeout, Math.min(Math.trunc(timeoutMs), TIMEOUT_MAX_MS))
}

// CLI 超时环境变量：`${CLAUDE|CODEX}_TIMEOUT_MS`，或用 CLI_TIMEOUT_MS 统一配置；
// 设 0 或非法值视为未配置，回退各调用方的默认值（run 与 compact 两条路径共用）。
export const envTimeoutMs = (adapter: CliAdapter): number | undefined => {
  const raw =
    process.env[`${adapter.id.toUpperCase()}_TIMEOUT_MS`] ??
    process.env.CLI_TIMEOUT_MS

  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
