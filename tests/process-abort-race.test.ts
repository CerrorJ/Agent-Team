import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { runCli } from '../src/cli/runner.js'
import type { CliAdapter } from '../src/cli/types.js'

test(
  '进程开始回调中的取消也必须经过终止端口，不能因尚未注册abort监听而丢失',
  { timeout: 10000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'weftpilot-abort-race-'))
    const controller = new AbortController()
    let calls = 0

    const adapter: CliAdapter = {
      id: 'codex',
      command: process.execPath,
      displayName: 'Abort fixture',
      // 即使旧实现漏掉终止也会自然结束，回归失败不会遗留无限运行的进程。
      buildArgs: () => ['-e', 'setTimeout(()=>process.exit(0),100)'],
      buildResumeArgs: () => [],
      parseEvents: () => [],
      buildCompactPlan: () => {
        throw new Error('unused')
      },
    }

    const stopProcess = async (child: ChildProcess): Promise<boolean> => {
      calls++

      const closed = new Promise<boolean>((done) =>
        child.once('close', () => done(true)),
      )

      child.kill()
      return closed
    }

    try {
      await assert.rejects(
        runCli({
          adapter,
          cwd,
          prompt: 'fixture',
          signal: controller.signal,
          onProcessStart: () => controller.abort(),
          stopProcess,
        }),
        /取消/,
      )
      assert.equal(calls, 1, '已取消的进程必须通过终止端口确认结束')
    } finally {
      assert.equal(dirname(resolve(cwd)), resolve(tmpdir()))
      assert.ok(basename(cwd).startsWith('weftpilot-abort-race-'))
      await rm(cwd, { recursive: true, force: true })
    }
  },
)
