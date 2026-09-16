// Anthropic 会话限流检测与追踪器。
// 当 Claude Code 遇到订阅或会话限额时（如 "You've hit your session limit · resets"），
// 记录受限状态，用于自动切换备用 Bot（如 developer -> developer2）。

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

// 严格匹配纯时钟格式：
// 12 小时制带可选时区：如 "2:30pm", "2pm", "2:30pm (Asia/Shanghai)"
// 24 小时制带可选时区：如 "14:30", "14:30 (Asia/Shanghai)"
// 必须从头到尾完整匹配，拒绝 "in 2 hours", "Sep 16, 2:30pm", "tomorrow at 3pm" 等非纯时钟格式
const STRICT_CLOCK_RE =
  /^(?:at\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+|[A-Za-z]+)\))?$/i

export const parseResetDurationMs = (
  resetsText: string | undefined,
  now = new Date(),
): number | undefined => {
  if (!resetsText) return undefined
  const trimmed = resetsText.trim()

  const match = STRICT_CLOCK_RE.exec(trimmed)
  if (!match) return undefined

  let hours = parseInt(match[1], 10)
  const minutes = match[2] ? parseInt(match[2], 10) : 0
  const meridiem = match[3]?.toLowerCase()
  const tzStr = match[4]?.trim()

  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined
    if (meridiem === 'pm' && hours < 12) hours += 12
    if (meridiem === 'am' && hours === 12) hours = 0
  } else {
    // 24 小时制必须带分钟（如 "14:30"），拒绝孤立的单数字如 "2"
    if (match[2] === undefined) return undefined
  }

  let timeZone = 'Asia/Shanghai'
  if (tzStr) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tzStr })
      timeZone = tzStr
    } catch {
      timeZone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    }
  } else {
    timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  }

  // 获取目标时区下的当前小时、分钟、秒
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  )

  const nowTzHour = parseInt(parts.hour, 10) % 24
  const nowTzMinute = parseInt(parts.minute, 10)
  const nowTzSecond = parseInt(parts.second, 10)

  const diffMinutes = hours * 60 + minutes - (nowTzHour * 60 + nowTzMinute)
  let diffMs = diffMinutes * 60 * 1000 - nowTzSecond * 1000

  // 若差值为负且相差很大（如 > 12 小时），说明是跨夜到次日的该时钟点（例如 23:30 -> 02:30）
  if (diffMs < -12 * 60 * 60 * 1000) {
    diffMs += 24 * 60 * 60 * 1000
  }

  // 加上 30 秒缓冲，避免服务端限额尚未完全刷新
  const durationWithBuffer = diffMs + 30 * 1000

  // 若计算出的剩余时间小于等于 0（说明该时钟点已在过去，非有效重置时间），
  // 返回 undefined 以回退到默认 5 小时兜底，防止被立即解除限制
  if (durationWithBuffer <= 0) {
    return undefined
  }

  return durationWithBuffer
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

  // 标记 bot 进入限流状态，根据 reset 时间或默认 5 小时计算过期时间
  markLimit(
    botId: string,
    resetsText?: string,
    durationMs?: number,
    now = new Date(),
  ): void {
    const computedDuration =
      durationMs ?? parseResetDurationMs(resetsText, now) ?? 5 * 60 * 60 * 1000

    this.limits.set(botId, {
      expireAt: Date.now() + computedDuration,
      resetsText,
    })
  }

  // 判断 bot 当前是否处于限流不可用状态
  isLimited(botId: string): boolean {
    const info = this.limits.get(botId)
    if (!info) return false
    if (Date.now() >= info.expireAt) {
      this.limits.delete(botId)
      return false
    }
    return true
  }

  // 获取限流详细信息
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

  // 手动清除限流状态
  clearLimit(botId: string): void {
    this.limits.delete(botId)
  }
}

export const sessionLimitTracker = new SessionLimitTracker()
