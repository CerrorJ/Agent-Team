import { killCli, spawnCli } from './spawn-cli.js'
import { armTimeout, envTimeoutMs } from './timeout.js'
import { promptInputForPlatform } from './types.js'
import { createInterface } from 'node:readline'
import type { CliAdapter, CliEvent, CliRunResult } from './types.js'

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000

export interface RunCliOptions {
  adapter: CliAdapter
  prompt: string
  cwd: string
  sessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
  stopToolNames?: string[]
  env?: Record<string, string>
  // 调用方按需订阅
  onEvent?: (event: CliEvent) => void
}

// Runner 只读取适配器翻译后的 CliEvent，不再关心供应商的原生字段。
export const runCli = (options: RunCliOptions): Promise<CliRunResult> => {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = envTimeoutMs(adapter) ?? DEFAULT_TIMEOUT_MS,
    stopToolNames = [],
    env,
    onEvent,
  } = options

  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform)
  const useStdin = promptInput === 'stdin'

  const model =
    adapter.id === 'claude'
      ? (env?.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL)
      : (env?.OPENAI_MODEL ??
        env?.CODEX_MODEL ??
        process.env.OPENAI_MODEL ??
        process.env.CODEX_MODEL)

  const reasoningEffort =
    adapter.id === 'codex'
      ? (env?.CODEX_REASONING_EFFORT ??
        env?.OPENAI_REASONING_EFFORT ??
        process.env.CODEX_REASONING_EFFORT ??
        process.env.OPENAI_REASONING_EFFORT)
      : undefined

  const cliOptions =
    model || reasoningEffort
      ? {
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }
      : undefined

  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput, cliOptions)
    : adapter.buildArgs(prompt, promptInput, cliOptions)

  return new Promise((resolve, reject) => {
    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // stdin 模式下把 prompt 写入子进程；否则 prompt 已在命令行参数里，stdin 直接收口。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8')
      else child.stdin.end()
    }
    // spawn 的 signal 选项只杀直接子进程（cmd 外壳），Windows 下 claude.exe/codex.exe 会变孤儿；
    // 额外监听 abort 用 killCli 连进程树一起清。
    signal?.addEventListener('abort', () => killCli(child), { once: true })
    const lines = createInterface({ input: child.stdout })
    //记住最近一次出现的会话标识
    let observedSessionId = sessionId
    let observedAnswer: string | undefined
    let observedStats: CliRunResult['stats']

    const observedToolCalls = new Map<
      string,
      NonNullable<CliRunResult['toolCalls']>[number]
    >()

    let finalResult: CliRunResult | undefined
    let stoppedByToolCall:
      NonNullable<CliRunResult['toolCalls']>[number] | undefined
    let resultError: Error | undefined
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = armTimeout(() => {
      timedOut = true
      killCli(child)
    }, timeoutMs)

    const finish = () => clearTimeout(timer)

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }

    lines.on('line', (line) => {
      // 遍历适配器翻译后的事件，先进入onEvent，再进入 Runner 原有会话，错误，最终结果
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event)
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId
        }
        if (event.type === 'error') {
          resultError = new Error(event.message)
          continue
        }
        // 应用层工具调用按 toolUseId 去重收集；调用失败时在 tool_end 剔除，
        // 最终只把成功的调用随结果返回（见下方 finalResult.toolCalls）
        if (event.type === 'tool_call') {
          observedToolCalls.set(event.toolUseId, event)
          if (!stoppedByToolCall && stopToolNames.includes(event.toolName)) {
            stoppedByToolCall = {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
            }
            killCli(child)
          }
          continue
        }
        if (event.type === 'tool_end' && event.failed) {
          observedToolCalls.delete(event.toolUseId)
          continue
        }
        if (event.type === 'stats') {
          observedStats = event.stats
          if (finalResult && !finalResult.stats) {
            finalResult.stats = event.stats
          }
          continue
        }
        if (event.type === 'result') {
          if (event.answer) observedAnswer = event.answer
          if (event.stats) observedStats = event.stats
          if (!observedAnswer) continue
          finalResult = {
            answer: observedAnswer,
            sessionId: event.sessionId ?? observedSessionId,
            ...(observedStats ? { stats: observedStats } : {}),
          }
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`))
        return
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`))
        return
      }
      fail(error)
    })
    child.once('close', (code) => {
      if (settled) return
      if (stoppedByToolCall) {
        settled = true
        finish()
        resolve({
          answer: observedAnswer ?? '',
          sessionId: observedSessionId,
          toolCalls: [stoppedByToolCall],
        })
        return
      }
      if (timedOut) {
        return fail(new Error(`${adapter.displayName} 执行超时`))
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`))
      }
      if (resultError) return fail(resultError)
      if (code !== 0) {
        return fail(
          new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ),
        )
      }
      if (!finalResult) {
        return fail(new Error(`${adapter.displayName} 没有返回最终结果`))
      }
      if (observedStats && !finalResult.stats) {
        finalResult.stats = observedStats
      }
      if (observedToolCalls.size > 0) {
        finalResult.toolCalls = [...observedToolCalls.values()].map((call) => ({
          toolUseId: call.toolUseId,
          toolName: call.toolName,
          input: call.input,
        }))
      }
      settled = true
      finish()
      resolve(finalResult)
    })
  })
}
