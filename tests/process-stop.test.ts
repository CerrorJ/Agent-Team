import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runCli } from '../src/cli/runner.js'
import type { CliAdapter, CliEvent } from '../src/cli/types.js'
import type { ProcessStopReport } from '../src/cli/process-stop.js'

test(
  '停止等待真实父子进程结束，不把 abort 请求作为停止证据',
  { timeout: 20_000 },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weftpilot-stop-'))
    const controller = new AbortController()
    const reports: ProcessStopReport[] = []
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
        onProcessStop: (report) => reports.push(report),
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
      if (process.platform === 'win32') {
        assert.equal(reports.length, 1)
        assert.equal(reports[0]?.outcome, 'confirmed')
        assert.equal(reports[0]?.exitCode, 0)
        assert.ok((reports[0]?.durationMs ?? -1) >= 0)
      }
      for (const pid of pids)
        assert.throws(() => process.kill(pid, 0), /ESRCH|找不到/)
    } finally {
      controller.abort()
      rmSync(cwd, { recursive: true, force: true })
    }
  },
)

test(
  '终止端口失败且根进程自然 exit 0，仍保留状态待确认而非谎报整棵树结束',
  { timeout: 10000 },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weftpilot-stop-failure-'))
    const controller = new AbortController()
    let descendant: number | undefined

    const script = `const cp=require('node:child_process');const fs=require('node:fs');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    fs.writeFileSync('descendant',String(child.pid));child.unref();
    console.log(JSON.stringify({type:'session',sessionId:'failure-fixture'}));
    setTimeout(()=>process.exit(0),250);`

    const adapter: CliAdapter = {
      id: 'codex',
      command: process.execPath,
      displayName: '终止失败夹具',
      buildArgs: () => ['-e', script],
      buildResumeArgs: () => ['-e', script],
      parseEvents: (line) => [JSON.parse(line) as CliEvent],
      buildCompactPlan: () => {
        throw new Error('unused')
      },
    }

    try {
      await assert.rejects(
        runCli({
          adapter,
          cwd,
          prompt: 'fixture',
          signal: controller.signal,
          stopProcess: async () => false,
          onEvent: () => controller.abort(),
        }),
        /STATE_UNCERTAIN/,
      )
      descendant = Number(readFileSync(join(cwd, 'descendant'), 'utf8'))
      assert.doesNotThrow(() => process.kill(descendant ?? 0, 0))
    } finally {
      if (!descendant && existsSync(join(cwd, 'descendant')))
        descendant = Number(readFileSync(join(cwd, 'descendant'), 'utf8'))
      if (descendant) {
        try {
          process.kill(descendant)
        } catch {
          /* 只清理本测试创建并持有的进程。 */
        }
        await delay(100)
      }
      rmSync(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    }
  },
)
