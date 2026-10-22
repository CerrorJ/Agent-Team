import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runCli } from '../src/cli/runner.js'
import type { CliAdapter, CliEvent } from '../src/cli/types.js'

test(
  '停止等待真实父子进程结束，不把 abort 请求作为停止证据',
  { timeout: 20_000 },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weftpilot-stop-'))
    const controller = new AbortController()
    const childScript = `setInterval(()=>{},1000)`

    const script = `const cp=require('node:child_process'); const fs=require('node:fs');
    const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});
    fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
    setInterval(()=>{},1000);`

    const adapter: CliAdapter = {
      id: 'codex',
      command: process.execPath,
      displayName: '进程终止夹具',
      buildArgs: () => ['-e', script],
      buildResumeArgs: () => ['-e', script],
      parseEvents: (line) => [JSON.parse(line) as CliEvent],
      buildCompactPlan: () => {
        throw new Error('unused')
      },
    }

    try {
      const executing = runCli({
        adapter,
        cwd,
        prompt: 'fixture',
        signal: controller.signal,
      })

      for (
        let attempt = 0;
        attempt < 100 && !existsSync(join(cwd, 'pids.json'));
        attempt++
      )
        await delay(20)

      const pids = JSON.parse(
        readFileSync(join(cwd, 'pids.json'), 'utf8'),
      ) as number[]

      controller.abort()
      await assert.rejects(executing, /取消/)
      for (const pid of pids)
        assert.throws(() => process.kill(pid, 0), /ESRCH|找不到/)
    } finally {
      controller.abort()
      rmSync(cwd, { recursive: true, force: true })
    }
  },
)
