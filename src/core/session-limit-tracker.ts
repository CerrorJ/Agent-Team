/**
 * Anthropic 会话限流检测与追踪器。
 * 当 Claude Code 遇到订阅或会话限额时（如 "You've hit your session limit · resets"），
 * 记录受限状态，用于自动切换备用 Bot（如 developer -> developer2）。
 */

export const isSessionLimitError = (text: string | undefined): boolean => {
  if (!text) return false
  return (
    /you['’]ve hit your session limit/i.test(text) ||
    /hit your session limit.*resets/i.test(text) ||
    /session limit\s*·\s*resets/i.test(text) ||
    (/session limit/i.test(text) && /resets/i.test(text))
  )
}

export const extractResetTime = (
  text: string | undefined,
): string | undefined => {
  if (!text) return undefined
  const match = text.match(/resets\s+([^.\n]+)/i)
  return match ? match[1].trim() : undefined
}

export interface LimitInfo {
  isLimited: boolean
  resetsText?: string
  expireAt?: number
}

export class SessionLimitTracker {
  // 记录每个受限 bot 的解除时间戳和提示文案
  private readonly limits = new Map<
    string,
    { expireAt: number; resetsText?: string }
  >()

  /** 标记 bot 进入限流状态，默认保持 5 小时 */
  markLimit(
    botId: string,
    resetsText?: string,
    durationMs = 5 * 60 * 60 * 1000,
  ): void {
    this.limits.set(botId, {
      expireAt: Date.now() + durationMs,
      resetsText,
    })
  }

  /** 判断 bot 当前是否处于限流不可用状态 */
  isLimited(botId: string): boolean {
    const info = this.limits.get(botId)
    if (!info) return false
    if (Date.now() >= info.expireAt) {
      this.limits.delete(botId)
      return false
    }
    return true
  }

  /** 获取限流详细信息 */
  getLimitInfo(botId: string): LimitInfo {
    const info = this.limits.get(botId)
    if (!info) return { isLimited: false }
    if (Date.now() >= info.expireAt) {
      this.limits.delete(botId)
      return { isLimited: false }
    }
    return {
      isLimited: true,
      resetsText: info.resetsText,
      expireAt: info.expireAt,
    }
  }

  /** 手动清除限流状态 */
  clearLimit(botId: string): void {
    this.limits.delete(botId)
  }
}

export const sessionLimitTracker = new SessionLimitTracker()
