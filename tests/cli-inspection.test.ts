import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { cliCheckResult } from '../src/kernel/cli-check-result.js'
import { startCliProbe } from '../src/kernel/cli-check-process.js'
import { CliInspection } from '../src/kernel/cli-inspection.js'
import { requestSchema } from '../src/kernel/protocol.js'

const probeOutcome = (output: string, exitCode = 0) => ({
  output,
  exitCode,
  confirmedEnded: true,
})

test('CLI检查只接受固定命令，版本输出需精确匹配且不回传额外账户/路径', () => {
  const request = {
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'kernel.cliCheck',
    input: { cli: 'codex', check: 'version' },
  }

  assert.equal(requestSchema.safeParse(request).success, true)
  for (const input of [
    { cli: 'git', check: 'version' },
    { cli: 'codex', check: 'login' },
    { ...request.input, command: 'whoami' },
    { ...request.input, cwd: '/' },
  ])
    assert.equal(requestSchema.safeParse({ ...request, input }).success, false)

  const codex = cliCheckResult(
    request.input as { cli: 'codex'; check: 'version' },
    probeOutcome('codex-cli 0.163.0\n'),
  )

  assert.equal(codex.version, '0.163.0')
  assert.equal(codex.modelConnection, 'unverified')
  assert.equal(
    cliCheckResult(
      { cli: 'claude', check: 'version' },
      probeOutcome('2.1.309 (Claude Code)'),
    ).version,
    '2.1.309',
  )
  for (const output of [
    'codex-cli 0.163.0\nprivate@example.test',
    'codex-cli arbitrary/path',
    '0.163.0',
  ]) {
    const result = cliCheckResult(
      { cli: 'codex', check: 'version' },
      probeOutcome(output),
    )

    assert.equal(result.state, 'failed')
    assert.equal('output' in result, false)
    assert.equal('version' in result, false)
  }
})

test('登录状态只代表CLI默认账户，JSON身份被丢弃；错误、退出码矛盾及未知格式不冒充成功', () => {
  const fixtures = [
    ['codex', 'Logged in using ChatGPT\n', 0, 'passed'],
    ['codex', 'Logged in using an API key - private-partial-key', 0, 'passed'],
    ['codex', 'Not logged in\n', 1, 'attention'],
    ['codex', 'Logged in using ChatGPT', 1, 'failed'],
    [
      'claude',
      JSON.stringify({
        loggedIn: true,
        email: 'private@example.test',
        configDirectory: '/private/path',
      }),
      0,
      'passed',
    ],
    ['claude', '{"loggedIn":false}', 1, 'attention'],
    ['claude', '{"loggedIn":true}', 1, 'failed'],
    ['claude', 'null', 0, 'failed'],
    ['claude', '{"loggedIn":"true"}', 0, 'failed'],
    ['claude', 'unknown secret', 0, 'failed'],
  ] as const

  for (const [cli, output, exitCode, state] of fixtures) {
    const result = cliCheckResult(
      { cli, check: 'sign-in' },
      probeOutcome(output, exitCode),
    )

    assert.equal(result.state, state)
    assert.equal(result.modelConnection, 'unverified')
    assert.equal(result.accountScope, 'cli-default-account')
    assert.doesNotMatch(JSON.stringify(result), /private|secret/)
  }

  const unknown = cliCheckResult(
    { cli: 'claude', check: 'sign-in' },
    { ...probeOutcome('{"loggedIn":true}'), confirmedEnded: false },
  )

  assert.equal(unknown.state, 'uncertain')
})

test('真实进程探针跨UTF8分块收集并确认结束，不启动模型', async () => {
  let ended = 0

  const session = startCliProbe(
    { cli: 'codex', check: 'version' },
    {
      cwd: process.cwd(),
      onEnded: () => {
        ended++
      },
      spawn: () =>
        spawn(
          process.execPath,
          [
            '-e',
            'process.stdout.write(Buffer.from([0xe4,0xb8])); setTimeout(()=>process.stdout.write(Buffer.from([0xad])),20)',
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          },
        ),
    },
  )

  const result = await session.result
  assert.equal(result.output, '中')
  assert.equal(result.confirmedEnded, true)
  assert.equal(ended, 1)
  assert.equal(await session.stop(), true)
})

test('真实长进程超时、输出超限均终止本次树后确认，不用root消失替代整树证据', async () => {
  for (const excessive of [false, true]) {
    let ended = 0

    const session = startCliProbe(
      { cli: 'codex', check: 'version' },
      {
        cwd: process.cwd(),
        onEnded: () => {
          ended++
        },
        timeoutMs: excessive ? 3000 : 400,
        spawn: () =>
          spawn(
            process.execPath,
            [
              '-e',
              `${excessive ? "process.stdout.write('x'.repeat(40000));" : ''}setInterval(()=>{},1000)`,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: process.platform !== 'win32',
            },
          ),
      },
    )

    const outcome = await session.result
    assert.equal(outcome.confirmedEnded, true)
    assert.equal(outcome.failure, excessive ? 'output-limit' : 'timeout')
    assert.equal(ended, 1)
    assert.ok(Buffer.byteLength(outcome.output) <= 32768)
  }
})

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 123456,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessByStdio<null, Readable, Readable>

test('受控终止失败后即使root close也保留未知；检查防重、退出拒绝均不把它当业务Run', async () => {
  const child = fakeChild()
  let ended = 0

  const inspection = new CliInspection({
    cwd: process.cwd(),
    start: (input, options) =>
      startCliProbe(input, {
        ...options,
        timeoutMs: 10,
        spawn: () => child,
        terminate: async () => {
          child.emit('close', 0)
          return false
        },
        onEnded: () => {
          ended++
          options.onEnded()
        },
      }),
  })

  const resultPromise = inspection.inspect({ cli: 'codex', check: 'version' })
  assert.throws(
    () => inspection.inspect({ cli: 'codex', check: 'sign-in' }),
    /CLI_CHECK_BUSY/,
  )
  const result = await resultPromise
  assert.equal(result.state, 'uncertain')
  assert.equal(ended, 0)
  child.emit('close', 0)
  assert.throws(
    () => inspection.inspect({ cli: 'codex', check: 'version' }),
    /CLI_CHECK_BUSY/,
  )
  await assert.rejects(inspection.shutdown(), /STATE_UNCERTAIN/)
})

test('受控正常关闭释放同CLI检查槽位，退出后禁止新请求', async () => {
  let calls = 0

  const inspection = new CliInspection({
    cwd: process.cwd(),
    start: (input, options) => {
      calls++
      return startCliProbe(input, {
        ...options,
        spawn: () => {
          const child = fakeChild()
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('codex-cli 0.163.0'))
            child.emit('close', 0)
          })
          return child
        },
      })
    },
  })

  assert.equal(
    (await inspection.inspect({ cli: 'codex', check: 'version' })).state,
    'passed',
  )
  assert.equal(
    (await inspection.inspect({ cli: 'codex', check: 'version' })).state,
    'passed',
  )
  assert.equal(calls, 2)
  await inspection.shutdown()
  assert.throws(
    () => inspection.inspect({ cli: 'claude', check: 'version' }),
    /KERNEL_STOPPED/,
  )
})

test('受控检查在途退出需等待本次树终止证明，不能先返回kernel停止', async () => {
  let stopReached = false
  let allowStop: (value: boolean) => void = () => undefined

  const proof = new Promise<boolean>((resolve) => {
    allowStop = resolve
  })

  const inspection = new CliInspection({
    cwd: process.cwd(),
    start: (input, options) =>
      startCliProbe(input, {
        ...options,
        spawn: fakeChild,
        terminate: () => {
          stopReached = true
          return proof
        },
      }),
  })

  const check = inspection.inspect({ cli: 'codex', check: 'version' })
  let stopped = false

  const shutdown = inspection.shutdown().then(() => {
    stopped = true
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stopReached, true)
  assert.equal(stopped, false)
  allowStop(true)
  await shutdown
  assert.equal((await check).processState, 'confirmed_ended')
})
