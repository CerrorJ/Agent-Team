import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProviderCliError, runCli } from '../src/cli/runner.js'
import type { CliAdapter, CliEvent } from '../src/cli/types.js'
import { sessionLimitTracker } from '../src/core/session-limit-tracker.js'

// 使用真实子进程输出可控事件，验证重试次数、取消、工作边界和共享后端拦截。
const fixture = async (events: CliEvent[][]) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-team-recovery-'))

  const env = {
    OPENAI_BASE_URL: `https://fixture.invalid/${cwd}`,
    OPENAI_API_KEY: 'fixture',
  }

  const args = () => [
    '-e',
    `
    const fs = require('node:fs');
    const n = fs.existsSync('attempt') ? Number(fs.readFileSync('attempt', 'utf8')) : 0;
    fs.writeFileSync('attempt', String(n + 1));
    const batches = ${JSON.stringify(events)};
    for (const event of batches[Math.min(n, batches.length - 1)]) console.log(JSON.stringify(event));
  `,
  ]

  const adapter: CliAdapter = {
    id: 'codex',
    command: process.execPath,
    displayName: 'Fixture',
    buildArgs: args,
    buildResumeArgs: args,
    buildCompactPlan: () => {
      throw new Error('unused')
    },
    parseEvents: (line) => [JSON.parse(line) as CliEvent],
  }

  return {
    cwd,
    env,
    adapter,
    count: async () => Number(await readFile(join(cwd, 'attempt'), 'utf8')),
    cleanup: async () => {
      sessionLimitTracker.clearLimit('codex', env)
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

const rateError: CliEvent = {
  type: 'error',
  message: 'rate_limit_error',
  details: { status: 429, retryAfterMs: 1 },
}

const success: CliEvent = {
  type: 'result',
  answer: 'done',
  sessionId: 'fixture-session',
}

test('transient failure retries before work and returns success without blocking backend', async () => {
  const f = await fixture([[rateError], [success]])
  const retries: number[] = []
  try {
    const result = await runCli({
      ...f,
      prompt: 'test',
      onEvent: (event) => {
        if (event.type === 'retry') retries.push(event.delayMs)
      },
    })

    assert.equal(result.answer, 'done')
    assert.deepEqual(retries, [1])
    assert.equal(await f.count(), 2)
    assert.equal(
      sessionLimitTracker.getLimitInfo('codex', f.env).isLimited,
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('persistent transient failure retries at most twice, blocks shared account without respawn', async () => {
  const f = await fixture([[rateError]])
  try {
    await assert.rejects(runCli({ ...f, prompt: 'test' }), ProviderCliError)
    assert.equal(await f.count(), 3)
    await assert.rejects(
      runCli({
        ...f,
        env: { ...f.env, OPENAI_MODEL: 'another' },
        prompt: 'test',
      }),
      ProviderCliError,
    )
    assert.equal(await f.count(), 3)
  } finally {
    await f.cleanup()
  }
})

test('does not retry or repeat tool side effects; preserves session for continuation', async () => {
  const f = await fixture([
    [
      { type: 'session', sessionId: 'existing-work' },
      {
        type: 'tool_start',
        toolUseId: '1',
        toolName: 'Bash',
        label: 'command',
      },
      rateError,
    ],
    [success],
  ])

  try {
    await assert.rejects(runCli({ ...f, prompt: 'test' }), (error: unknown) => {
      assert.ok(error instanceof ProviderCliError)
      assert.equal(error.performedWork, true)
      assert.equal(error.sessionId, 'existing-work')
      return true
    })
    assert.equal(await f.count(), 1)
  } finally {
    await f.cleanup()
  }
})

test('unknown and quota failures do not retry; only quota marks a cooldown', async () => {
  for (const message of [
    'typescript compilation failed',
    'insufficient_quota',
  ]) {
    const f = await fixture([[{ type: 'error', message }]])
    try {
      await assert.rejects(runCli({ ...f, prompt: 'test' }), ProviderCliError)
      assert.equal(await f.count(), 1)
      assert.equal(
        sessionLimitTracker.getLimitInfo('codex', f.env).isLimited,
        message === 'insufficient_quota',
      )
    } finally {
      await f.cleanup()
    }
  }
})

test('honors a long server retry window without shortening it to force a retry', async () => {
  const f = await fixture([
    [{ ...rateError, details: { retryAfterMs: 90_000 } }],
  ])

  try {
    await assert.rejects(runCli({ ...f, prompt: 'test' }), ProviderCliError)
    assert.equal(await f.count(), 1)
    assert.ok(
      (sessionLimitTracker.getLimitInfo('codex', f.env).expireAt ?? 0) >
        Date.now() + 80_000,
    )
  } finally {
    await f.cleanup()
  }
})

test('cancels retry waits immediately without respawning or marking a failure', async () => {
  const f = await fixture([
    [{ ...rateError, details: { retryAfterMs: 10_000 } }],
  ])

  const controller = new AbortController()
  try {
    await assert.rejects(
      runCli({
        ...f,
        prompt: 'test',
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'retry') controller.abort()
        },
      }),
      { name: 'AbortError' },
    )
    assert.equal(await f.count(), 1)
    assert.equal(
      sessionLimitTracker.getLimitInfo('codex', f.env).isLimited,
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('stop tools return their invocation without triggering retry or cooldown', async () => {
  const f = await fixture([
    [
      {
        type: 'tool_call',
        toolUseId: 'approval',
        toolName: 'request_approval',
        input: { operation: 'test' },
      },
    ],
  ])

  try {
    const result = await runCli({
      ...f,
      prompt: 'test',
      stopToolNames: ['request_approval'],
    })

    assert.equal(result.toolCalls?.[0].toolName, 'request_approval')
    assert.equal(await f.count(), 1)
    assert.equal(
      sessionLimitTracker.getLimitInfo('codex', f.env).isLimited,
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('preserves quota cause when CLI wraps it in a generic rate-limit error', async () => {
  const f = await fixture([
    [
      {
        type: 'error',
        message: 'quota exhausted',
        details: { code: 'insufficient_quota', status: 429 },
      },
      rateError,
    ],
  ])

  try {
    await assert.rejects(runCli({ ...f, prompt: 'test' }), (error: unknown) => {
      assert.ok(error instanceof ProviderCliError)
      assert.equal(error.failure.type, 'quota_exhausted')
      return true
    })
    assert.equal(await f.count(), 1)
  } finally {
    await f.cleanup()
  }
})

test('accepts CLI internal transient recovery without replaying the successful task', async () => {
  const f = await fixture([[rateError, success]])
  try {
    assert.equal((await runCli({ ...f, prompt: 'test' })).answer, 'done')
    assert.equal(await f.count(), 1)
    assert.equal(
      sessionLimitTracker.getLimitInfo('codex', f.env).isLimited,
      false,
    )
  } finally {
    await f.cleanup()
  }
})
