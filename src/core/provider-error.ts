import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

export const ProviderFailureTypeSchema = z.enum([
  'rate_limit',
  'quota_exhausted',
  'billing',
  'authentication',
  'configuration',
  'service_unavailable',
  'unknown',
])

export type ProviderFailureType = z.infer<typeof ProviderFailureTypeSchema>
export type FailureScope = 'account' | 'model'

// CLI 可能隐藏 HTTP 响应；只保留实际暴露的字段，不根据 CLI 名称猜测厂家。
export interface ProviderErrorDetails {
  status?: number
  code?: string
  retryAfterMs?: number
  resetAt?: number
}

export interface ProviderFailure extends ProviderErrorDetails {
  type: ProviderFailureType
  scope: FailureScope
  message: string
  retryable: boolean
  cooldownMs: number
}

const RuleSchema = z
  .object({
    endpointPattern: z.string().optional(),
    messagePattern: z.string().optional(),
    codePattern: z.string().optional(),
    status: z.number().int().min(100).max(599).optional(),
    type: ProviderFailureTypeSchema,
    scope: z.enum(['account', 'model']).default('account'),
    cooldownMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000)
      .optional(),
  })
  .refine(
    (rule) => rule.messagePattern || rule.codePattern || rule.status,
    '错误规则至少需要 messagePattern、codePattern 或 status',
  )

const PolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(5).default(2),
  baseDelayMs: z.number().int().positive().max(60_000).default(1_000),
  maxRetryDelayMs: z.number().int().positive().max(60_000).default(30_000),
  rateLimitCooldownMs: z.number().int().positive().default(60_000),
  quotaCooldownMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  configurationCooldownMs: z.number().int().positive().default(60_000),
  serviceCooldownMs: z.number().int().positive().default(30_000),
  rules: z.array(RuleSchema).default([]),
})

export type ProviderErrorPolicy = z.infer<typeof PolicySchema>

export const parseProviderErrorPolicy = (
  input: unknown,
): ProviderErrorPolicy => {
  const policy = PolicySchema.parse(input)
  for (const rule of policy.rules) {
    for (const pattern of [
      rule.endpointPattern,
      rule.messagePattern,
      rule.codePattern,
    ]) {
      if (pattern !== undefined) new RegExp(pattern, 'i')
    }
  }
  return policy
}

let cachedPolicy: ProviderErrorPolicy | undefined

export const getProviderErrorPolicy = (): ProviderErrorPolicy => {
  if (cachedPolicy) return cachedPolicy

  const path =
    process.env.PROVIDER_ERROR_CONFIG || 'config/provider-errors.json'

  if (process.env.PROVIDER_ERROR_CONFIG || existsSync(path)) {
    cachedPolicy = parseProviderErrorPolicy(
      JSON.parse(readFileSync(path, 'utf8')),
    )
  } else {
    cachedPolicy = parseProviderErrorPolicy({})
  }
  return cachedPolicy
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const positiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export const parseRetryAfter = (
  value: unknown,
  now = Date.now(),
): number | undefined => {
  const seconds = positiveNumber(value)
  if (seconds !== undefined) return seconds * 1000
  if (typeof value !== 'string') return undefined
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

// 只遍历错误/响应包装，不扫描工具输入和任意用户内容。
export const extractProviderErrorDetails = (
  input: unknown,
  now = Date.now(),
  depth = 0,
): ProviderErrorDetails => {
  if (depth > 5) return {}
  if (typeof input === 'string') {
    try {
      return extractProviderErrorDetails(JSON.parse(input), now, depth + 1)
    } catch {
      const start = input.indexOf('{')
      const end = input.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          return extractProviderErrorDetails(
            JSON.parse(input.slice(start, end + 1)),
            now,
            depth + 1,
          )
        } catch {
          return {}
        }
      }
      return {}
    }
  }
  const data = record(input)
  if (!data) return {}

  const nested = ['error', 'errors', 'response', 'details'].flatMap((key) =>
    (Array.isArray(data[key]) ? data[key] : [data[key]]).map((value: unknown) =>
      extractProviderErrorDetails(value, now, depth + 1),
    ),
  )

  const headers = record(data.headers) ?? {}

  const header = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]

  const status = positiveNumber(
    data.status ?? data.status_code ?? data.statusCode,
  )

  const code = data.code ?? data.error_code ?? data.type

  const retryAfterMs =
    positiveNumber(data.retry_after_ms ?? data.retryAfterMs) ??
    parseRetryAfter(
      data.retry_after ?? data.retryAfter ?? header('retry-after'),
      now,
    )

  const reset = data.reset_at ?? data.resetAt

  const resetAt =
    typeof reset === 'string' && !/^\d+(?:\.\d+)?$/.test(reset)
      ? Date.parse(reset)
      : positiveNumber(reset)

  return {
    ...Object.assign({}, ...nested),
    ...(status !== undefined && status >= 100 && status <= 599
      ? { status }
      : {}),
    // event.type=error/turn.failed 是事件类型，不应覆盖内部的厂家错误码。
    ...((typeof code === 'string' || typeof code === 'number') &&
    !['error', 'turn.failed', 'result'].includes(String(code))
      ? { code: String(code) }
      : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined && Number.isFinite(resetAt)
      ? { resetAt: resetAt < 1e12 ? resetAt * 1000 : resetAt }
      : {}),
  }
}

export const parseResetDurationMs = (
  text: string | undefined,
  now = new Date(),
): number | undefined => {
  if (!text) return undefined

  const relative =
    /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|秒|分钟|小时)(?:后)?$/i.exec(
      text.trim(),
    )

  if (relative) {
    const unit = relative[2].toLowerCase()
    return (
      Number(relative[1]) *
      (/^(h|hour|hr|小时)/.test(unit)
        ? 3_600_000
        : /^(m|min|分钟)/.test(unit)
          ? 60_000
          : 1000)
    )
  }

  const clock =
    /^(?:at\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+|[A-Za-z]+)\))?$/i.exec(
      text.trim(),
    )

  if (!clock) return undefined
  let hours = Number(clock[1])
  const meridiem = clock[3]?.toLowerCase()
  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0)
  } else if (clock[2] === undefined) return undefined
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: clock[4] || Intl.DateTimeFormat().resolvedOptions().timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    )

    let duration =
      (hours * 60 +
        Number(clock[2] ?? 0) -
        ((Number(parts.hour) % 24) * 60 + Number(parts.minute))) *
        60_000 -
      Number(parts.second) * 1000
    if (duration < -12 * 3_600_000) duration += 24 * 3_600_000
    return duration > 0 ? duration + 30_000 : undefined
  } catch {
    return undefined
  }
}

const textRetryDelay = (text: string, now: number): number | undefined => {
  const header = /retry-after\s*[=:]\s*([^\r\n]+)/i.exec(text)
  if (header) {
    const delay = parseRetryAfter(header[1].trim(), now)
    if (delay !== undefined) return delay
  }

  const relative =
    /(?:retry|try again|resets?)\s+(?:after\s+|in\s+)?(\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h))\b/i.exec(
      text,
    ) ?? /(\d+(?:\.\d+)?\s*(?:秒|分钟|小时))后(?:重试|恢复|重置)/.exec(text)

  if (relative) {
    const milliseconds = /^(\d+(?:\.\d+)?)\s*(?:milliseconds?|ms)$/i.exec(
      relative[1],
    )

    return milliseconds
      ? Number(milliseconds[1])
      : parseResetDurationMs(relative[1], new Date(now))
  }
  const reset = /resets\s+([^\r\n·]+)/i.exec(text)
  return reset
    ? parseResetDurationMs(reset[1].trim(), new Date(now))
    : undefined
}

// 余额和额度类别在 429 前判断，避免将无法短时恢复的问题自动重试。
const builtInRules: Array<{
  type: ProviderFailureType
  pattern: RegExp
  statuses: number[]
}> = [
  {
    type: 'billing',
    statuses: [402],
    pattern:
      /insufficient[_ -](?:balance|credit|funds)|credit balance.*(?:low|exhaust)|payment[_ -]required|billing[_ -](?:error|hard_limit)|余额不足|欠费|充值/i,
  },
  {
    type: 'quota_exhausted',
    statuses: [],
    pattern:
      /insufficient[_ -]quota|quota[_ -](?:exceeded|exhausted)|exceeded.*?(?:current )?quota|quota.*?(?:exceeded|exhausted)|usage[_ -]limit[_ -](?:reached|exceeded)|(?:hit|reached|exceeded).*?(?:session|usage|weekly|monthly|daily) limit|(?:session|usage|weekly|monthly|daily) limit.*(?:resets|reached|exceeded)|(?:额度|配额|用量).*(?:不足|耗尽|用尽|超限|已达|达到|超过)|(?:已达|达到|超过).*(?:额度|配额|用量)/i,
  },
  {
    type: 'authentication',
    statuses: [401],
    pattern:
      /invalid[_ -](?:api[_ -]?key|token)|authentication[_ -](?:error|failed)|unauthorized|认证失败|无效.*(?:密钥|令牌)|(?:密钥|令牌).*(?:无效|过期)/i,
  },
  {
    type: 'configuration',
    statuses: [403],
    pattern:
      /model[_ -]not[_ -]found|permission[_ -]denied|access[_ -]denied|模型不存在|无权访问|权限不足/i,
  },
  {
    type: 'rate_limit',
    statuses: [429],
    pattern:
      /rate[_ -]limit|too many requests|requests? per (?:minute|second)|tokens? per minute|请求.*(?:过于频繁|太频繁)|限流|频率.*(?:限制|超限|超过|过高)|并发.*(?:限制|超限|超过)/i,
  },
  {
    type: 'service_unavailable',
    statuses: [500, 502, 503, 504],
    pattern:
      /overloaded|service[_ -]unavailable|temporarily unavailable|server[_ -]error|bad gateway|服务.*(?:繁忙|暂不可用|暂时不可用)|系统繁忙/i,
  },
]

export const classifyProviderError = (
  input: ProviderErrorDetails & { message: string },
  endpoint = '',
  policy = getProviderErrorPolicy(),
  now = Date.now(),
): ProviderFailure => {
  const structured = extractProviderErrorDetails(input.message, now)
  const details = { ...structured, ...input }
  details.status ??=
    Number(
      /(?:HTTP(?:\/\d(?:\.\d)?)?|API Error|status(?: code)?|状态码)\s*[:=]?\s*(\d{3})\b/i.exec(
        input.message,
      )?.[1],
    ) || undefined

  const matches = (pattern: string | undefined, value: string) =>
    pattern === undefined || new RegExp(pattern, 'i').test(value)

  const rule = policy.rules.find(
    (rule) =>
      matches(rule.endpointPattern, endpoint) &&
      matches(rule.messagePattern, input.message) &&
      matches(rule.codePattern, details.code ?? '') &&
      (rule.status === undefined || rule.status === details.status),
  )

  // 明确的厂家错误码优先；没有可识别代码时，再检查文案与 HTTP 状态。
  const codeType = builtInRules.find((rule) =>
    rule.pattern.test(details.code ?? ''),
  )?.type

  const statusType = builtInRules.find((rule) =>
    rule.statuses.includes(details.status ?? 0),
  )?.type

  const messageType = builtInRules.find((rule) =>
    rule.pattern.test(input.message),
  )?.type

  const specific = (type: ProviderFailureType | undefined) =>
    type && !['rate_limit', 'service_unavailable'].includes(type)
      ? type
      : undefined

  const type: ProviderFailureType =
    rule?.type ??
    specific(codeType) ??
    specific(statusType) ??
    specific(messageType) ??
    codeType ??
    statusType ??
    messageType ??
    'unknown'

  const retryAfterMs =
    details.retryAfterMs ??
    (details.resetAt !== undefined && details.resetAt > now
      ? details.resetAt - now
      : undefined) ??
    textRetryDelay(input.message, now)

  const defaultCooldown =
    type === 'rate_limit'
      ? policy.rateLimitCooldownMs
      : type === 'quota_exhausted'
        ? policy.quotaCooldownMs
        : type === 'service_unavailable'
          ? policy.serviceCooldownMs
          : policy.configurationCooldownMs

  return {
    ...details,
    type,
    message: input.message,
    scope: rule?.scope ?? (type === 'configuration' ? 'model' : 'account'),
    retryable: type === 'rate_limit' || type === 'service_unavailable',
    retryAfterMs,
    cooldownMs:
      type === 'unknown'
        ? 0
        : Math.max(1000, retryAfterMs ?? rule?.cooldownMs ?? defaultCooldown),
  }
}

export const providerFailureLabel = (type: ProviderFailureType): string =>
  ({
    rate_limit: '短时限流',
    quota_exhausted: '额度耗尽',
    billing: '余额或计费异常',
    authentication: '认证失败',
    configuration: '模型或权限配置异常',
    service_unavailable: '服务暂时不可用',
    unknown: '未识别的执行错误',
  })[type]

export const providerFailureGuidance = (type: ProviderFailureType): string =>
  ({
    rate_limit: '等待重试窗口后再尝试，或切换独立后端。',
    quota_exhausted: '等待服务商额度恢复，或切换独立额度的账号。',
    billing: '请检查账户余额与计费状态。',
    authentication: '请检查或更新模型服务凭证。',
    configuration: '请检查模型名称和访问权限。',
    service_unavailable: '稍后重试，或切换可用的模型服务。',
    unknown: '请查看原始错误后决定下一步。',
  })[type]
