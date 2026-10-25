import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runCli, type RunCliOptions } from '../src/cli/runner.js'
import type { CliAdapter } from '../src/cli/types.js'
import type { ProcessStopReport } from '../src/cli/process-stop.js'

for (const immediate of [true, false])
  test(
    `Windows真实断管：${immediate ? '开始回调取消' : '写入阻塞后取消'}不崩溃且等待默认终止确认`,
    { skip: process.platform !== 'win32', timeout: 15000 },
    async () => {
      await withFixture(async (cwd) => {
        const controller = new AbortController()
        const reports: ProcessStopReport[] = []
        let pid = 0
        await assert.rejects(
          runCli({
            adapter: adapter('setTimeout(()=>process.exit(0),3000)'),
            cwd,
            prompt: 'Z'.repeat(256 * 1024),
            environment: 'isolated',
            signal: controller.signal,
            onProcessStart: (value) => {
              pid = value
              if (immediate) controller.abort()
              else setTimeout(() => controller.abort(), 30)
            },
            onProcessStop: (report) => reports.push(report),
          }),
          /执行已取消/,
        )
        assert.equal(reports.length, 1)
        assert.equal(reports[0]?.outcome, 'confirmed')
        assert.equal(reports[0]?.exitCode, 0)
        assert.throws(() => process.kill(pid, 0), /ESRCH|找不到/)
      })
    },
  )

for (const tool of [false, true])
  test(
    `受控终止确认与真实Windows断管：先打印${tool ? '人工工具及result' : 'result'}也不成功或自动重试`,
    { skip: process.platform !== 'win32', timeout: 15000 },
    async () => {
      await withFixture(async (cwd) => {
        let starts = 0
        let confirmations = 0
        let pid = 0
        await assert.rejects(
          runCli({
            adapter: adapter(earlyCloseScript(300, tool)),
            cwd,
            prompt: 'Z'.repeat(256 * 1024),
            environment: 'isolated',
            stopToolNames: ['request_clarification'],
            onProcessStart: (value) => {
              starts++
              pid = value
            },
            // Node标准输入的EOF可能到自然退出才可见。此夹具无后代，用所持child的close
            // 确认其有限进程，而不把生产taskkill在根消失后的失败改成成功。
            stopProcess: async (child) => {
              confirmations++
              if (child.exitCode === null)
                await new Promise<void>((resolve) =>
                  child.once('close', () => resolve()),
                )
              assert.equal(child.exitCode, 0)
              return true
            },
          }),
          /^Error: CLI_INPUT_FAILED$/,
        )
        assert.equal(starts, 1)
        assert.equal(confirmations, 1)
        assert.throws(() => process.kill(pid, 0), /ESRCH|找不到/)
      })
    },
  )

for (const throwing of [false, true])
  test(
    `Windows真实断管后终止端口${throwing ? '抛错' : '失败'}：根进程自然结束也保留STATE_UNCERTAIN`,
    { skip: process.platform !== 'win32', timeout: 10000 },
    async () => {
      await withFixture(async (cwd) => {
        let calls = 0

        const stopProcess: NonNullable<
          RunCliOptions['stopProcess']
        > = async () => {
          calls++
          if (throwing) throw new Error('SYNTHETIC_PRIVATE_STOP_ERROR')
          return false
        }

        await assert.rejects(
          runCli({
            adapter: adapter(earlyCloseScript(300)),
            cwd,
            prompt: 'Z'.repeat(256 * 1024),
            environment: 'isolated',
            stopProcess,
          }),
          /^Error: STATE_UNCERTAIN$/,
        )
        assert.equal(calls, 1)
      })
    },
  )

test(
  'Windows真实stdin完整送达后人工工具仍可返回，默认停止确认且不误报输入失败',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    await withFixture(async (cwd) => {
      const script = `const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
        process.stdin.on('end',()=>{
          console.log(JSON.stringify({type:'session',sessionId:'fully-delivered'}));
          console.log(JSON.stringify({type:'tool_call',toolUseId:'normal-tool',
            toolName:'request_clarification',input:{receivedBytes:Buffer.concat(chunks).length}}));
          setTimeout(()=>process.exit(0),3000);
        });`

      const reports: ProcessStopReport[] = []
      let pid = 0

      const result = await runCli({
        adapter: adapter(script),
        cwd,
        prompt: 'D'.repeat(65536),
        environment: 'isolated',
        stopToolNames: ['request_clarification'],
        onProcessStart: (value) => {
          pid = value
        },
        onProcessStop: (report) => reports.push(report),
      })

      assert.equal(result.sessionId, 'fully-delivered')
      assert.equal(result.toolCalls?.length, 1)
      assert.equal(result.toolCalls[0]?.toolName, 'request_clarification')
      assert.deepEqual(result.toolCalls[0]?.input, { receivedBytes: 65536 })
      assert.equal(reports[0]?.outcome, 'confirmed')
      assert.equal(reports[0]?.exitCode, 0)
      assert.throws(() => process.kill(pid, 0), /ESRCH|找不到/)
    })
  },
)

const earlyCloseScript = (
  deadline: number,
  tool = false,
) => `require('node:fs').closeSync(0);
  ${tool ? "console.log(JSON.stringify({type:'tool_call',toolUseId:'early-tool',toolName:'request_clarification',input:{question:'synthetic'}}));" : ''}
  console.log(JSON.stringify({type:'result',answer:'UNTRUSTED_RESULT'}));
  setTimeout(()=>process.exit(0),${deadline});`

const adapter = (script: string): CliAdapter => ({
  id: 'codex',
  command: process.execPath,
  displayName: '有界输入进程夹具',
  buildArgs: () => ['-e', script],
  buildResumeArgs: () => ['-e', script],
  parseEvents: (line) => [JSON.parse(line)],
  buildCompactPlan: () => {
    throw new Error('unused')
  },
})

/** 子进程不派生后代且有自然结束上限；只清理本测试创建的目录。 */
const withFixture = async (action: (cwd: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'weftpilot-input-native-'))
  try {
    await action(directory)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('weftpilot-input-native-'))
    await rm(directory, { recursive: true, force: true })
  }
}
