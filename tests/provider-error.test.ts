import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyProviderError,
  extractProviderErrorDetails,
  parseProviderErrorPolicy,
  parseResetDurationMs,
  parseRetryAfter,
} from '../src/core/provider-error.js'
import {
  backendScopeKey,
  SessionLimitTracker,
} from '../src/core/session-limit-tracker.js'
import { TeamRegistry } from '../src/core/team-registry.js'
import type { BotConfig } from '../src/core/bot-registry.js'
import { sessionLimitTracker } from '../src/core/session-limit-tracker.js'
import { ClaudeAdapter } from '../src/cli/claude-adapter.js'
import { CodexAdapter } from '../src/cli/codex-adapter.js'

const policy = parseProviderErrorPolicy({})

const classify = (message: string, details = {}) =>
  classifyProviderError({ message, ...details }, '', policy)

test('different vendor messages and status codes classify by cause', () => {
  const cases = [
    [
      "You've hit your session limit · resets 2:30pm (Asia/Shanghai)",
      'quota_exhausted',
    ],
    ['You have exceeded your current quota', 'quota_exhausted'],
    ['今日用量已达上限', 'quota_exhausted'],
    ['请求频率过高，请稍后重试', 'rate_limit'],
    ['API Error: 429 too many requests', 'rate_limit'],
    ['HTTP 401', 'authentication'],
    ['HTTP 402', 'billing'],
    ['HTTP 503', 'service_unavailable'],
    ['余额不足，请充值', 'billing'],
    ['invalid_api_key', 'authentication'],
    ['model_not_found', 'configuration'],
    ['overloaded_error', 'service_unavailable'],
    ['build failed: TypeScript error', 'unknown'],
    ['429 tests passed; file session-limit.ts changed', 'unknown'],
  ] as const

  for (const [message, type] of cases)
    assert.equal(classify(message).type, type, message)
  assert.equal(
    classify('insufficient_quota', { status: 429 }).type,
    'quota_exhausted',
  )
  assert.equal(
    classify('insufficient_balance', { status: 429 }).type,
    'billing',
  )
  assert.equal(
    classify('quota exceeded', { code: 'invalid_api_key', status: 429 }).type,
    'authentication',
  )
  assert.equal(
    classify("You've hit your session limit", {
      code: 'rate_limit',
      status: 429,
    }).type,
    'quota_exhausted',
  )
  assert.equal(classify('unknown error', { status: 429 }).retryable, true)
  assert.equal(classify('insufficient_quota', { status: 429 }).retryable, false)
})

test('structured metadata survives wrappers, numeric vendor codes, and prefixed JSON', () => {
  const details = extractProviderErrorDetails({
    type: 'turn.failed',
    error: {
      code: 'insufficient_quota',
      response: {
        status: 429,
        headers: { 'Retry-After': '12' },
      },
    },
  })

  assert.deepEqual(details, {
    code: 'insufficient_quota',
    status: 429,
    retryAfterMs: 12_000,
  })
  assert.equal(
    extractProviderErrorDetails({ error: { code: 1302 } }).code,
    '1302',
  )
  assert.equal(
    classify('API Error: 429 {"error":{"code":"insufficient_quota"}}').type,
    'quota_exhausted',
  )
  assert.deepEqual(
    extractProviderErrorDetails({ input: { code: 'insufficient_quota' } }),
    {},
  )
})

test('uses retry hints and keeps unknown reset times unknown', () => {
  const now = Date.parse('2026-10-17T04:00:00Z')
  assert.equal(parseRetryAfter('2.5', now), 2500)
  assert.equal(parseRetryAfter('Sat, 17 Oct 2026 04:00:10 GMT', now), 10_000)
  assert.equal(parseRetryAfter('', now), undefined)
  assert.equal(classify('rate limit; retry in 2 seconds').retryAfterMs, 2000)
  assert.equal(classify('请求限流，30秒后重试').retryAfterMs, 30_000)
  assert.equal(parseResetDurationMs('in 2 hours'), 7_200_000)
  assert.equal(
    parseResetDurationMs('2:30pm (Asia/Shanghai)', new Date(now)),
    9_030_000,
  )
  assert.equal(parseResetDurationMs('tomorrow at 3pm'), undefined)
  assert.equal(
    classify('session limit resets someday').cooldownMs,
    policy.quotaCooldownMs,
  )
  assert.equal(classify('unknown failure').cooldownMs, 0)

  const failure = classifyProviderError(
    { message: 'rate limit', resetAt: now + 15_000 },
    '',
    policy,
    now,
  )

  assert.equal(failure.retryAfterMs, 15_000)
})

test('vendor rules match endpoint and code, override generic HTTP 429', () => {
  const custom = parseProviderErrorPolicy({
    rules: [
      {
        endpointPattern: 'vendor\\.example',
        codePattern: '^1302$',
        type: 'quota_exhausted',
        scope: 'model',
        cooldownMs: 10_000,
      },
    ],
  })

  const input = { message: 'vendor error', code: '1302', status: 429 }

  const failure = classifyProviderError(
    input,
    'https://vendor.example/v1',
    custom,
  )

  assert.equal(failure.type, 'quota_exhausted')
  assert.equal(failure.scope, 'model')
  assert.equal(failure.cooldownMs, 10_000)
  assert.equal(
    classifyProviderError(input, 'https://other.example', custom).type,
    'rate_limit',
  )
  assert.throws(() =>
    parseProviderErrorPolicy({ rules: [{ type: 'billing' }] }),
  )
  assert.throws(() =>
    parseProviderErrorPolicy({
      rules: [{ type: 'billing', messagePattern: '[' }],
    }),
  )
})

test('cooldown follows account/model, expires, clears, and leaves unknown errors available', () => {
  let now = 1000
  const tracker = new SessionLimitTracker(() => now)

  const env = {
    OPENAI_BASE_URL: 'https://test.invalid',
    OPENAI_API_KEY: 'fixture-key',
    OPENAI_MODEL: 'a',
  }

  tracker.markFailure('codex', env, classify('unknown'))
  assert.equal(tracker.getLimitInfo('codex', env).isLimited, false)
  tracker.markFailure('codex', env, classify('quota exhausted'))
  assert.equal(
    tracker.getLimitInfo('codex', { ...env, OPENAI_MODEL: 'b' }).isLimited,
    true,
  )
  assert.equal(
    tracker.getLimitInfo('codex', { ...env, OPENAI_API_KEY: 'other' })
      .isLimited,
    false,
  )
  assert.equal(
    tracker.getLimitInfo('claude', {
      ANTHROPIC_BASE_URL: 'https://other.invalid',
    }).isLimited,
    false,
  )
  now += policy.quotaCooldownMs
  assert.equal(tracker.getLimitInfo('codex', env).isLimited, false)
  tracker.markFailure('codex', env, classify('model_not_found'))
  assert.equal(
    tracker.getLimitInfo('codex', { ...env, OPENAI_MODEL: 'b' }).isLimited,
    false,
  )
  tracker.clearLimit('codex', env)
  assert.equal(tracker.getLimitInfo('codex', env).isLimited, false)
  assert.equal(
    backendScopeKey('codex', { ...env, AGENT_TEAM_QUOTA_GROUP: 'shared' }),
    backendScopeKey('claude', { AGENT_TEAM_QUOTA_GROUP: 'shared' }),
  )
})

test('fallback candidates exclude members sharing the failed backend, reflect model config changes', () => {
  const bot = (id: string, key: string): BotConfig => ({
    id,
    group: 'dev',
    appId: '',
    appSecret: '',
    defaultCliId: 'codex',
    role: 'dev',
    skills: [],
    systemPrompt: '',
    workspaceDir: '.',
    collaborationMaxRounds: 16,
    cliEnv: {
      OPENAI_BASE_URL: 'https://registry-fixture.invalid',
      OPENAI_API_KEY: key,
    },
  })

  const configs = [
    bot('dev', 'same'),
    bot('shared', 'same'),
    bot('independent', 'other'),
  ]

  const registry = new TeamRegistry('dev', configs)
  try {
    sessionLimitTracker.markFailure(
      'codex',
      configs[0].cliEnv,
      classify('insufficient_quota'),
    )
    assert.deepEqual(
      registry.getAvailableFallbackMembers('dev').map((item) => item.id),
      ['independent'],
    )
    configs[1].cliEnv = { ...configs[1].cliEnv, OPENAI_API_KEY: 'new' }
    assert.equal(registry.getAvailability('shared').isLimited, false)
  } finally {
    sessionLimitTracker.clearLimit('codex', configs[0].cliEnv)
  }
})

test('both CLI adapters preserve structured provider errors', () => {
  const codex = new CodexAdapter().parseEvents(
    JSON.stringify({
      type: 'turn.failed',
      error: {
        message: 'vendor failed',
        code: 'insufficient_quota',
        status: 429,
      },
    }),
  )[0]

  assert.equal(codex.type, 'error')
  if (codex.type === 'error')
    assert.equal(codex.details?.code, 'insufficient_quota')

  const claude = new ClaudeAdapter().parseEvents(
    JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'vendor failed',
      error: { code: 'rate_limit_error', retry_after_ms: 50 },
      session_id: 'session-1',
    }),
  )[0]

  assert.equal(claude.type, 'error')
  if (claude.type === 'error') {
    assert.equal(claude.details?.retryAfterMs, 50)
    assert.equal(claude.sessionId, 'session-1')
  }

  const assistantError = new ClaudeAdapter().parseEvents(
    JSON.stringify({
      type: 'assistant',
      error: 'rate_limit',
      session_id: 'limited-session',
      message: {
        content: [{ type: 'text', text: "You've hit your session limit" }],
      },
    }),
  )[0]

  assert.equal(assistantError.type, 'error')
  if (assistantError.type === 'error') {
    assert.equal(
      classify(assistantError.message, assistantError.details).type,
      'quota_exhausted',
    )
  }
})
