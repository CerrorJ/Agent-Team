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
