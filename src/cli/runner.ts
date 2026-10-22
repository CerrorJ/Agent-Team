import { spawnCli } from './spawn-cli.js'
import { cliEnvironment } from './execution-environment.js'
import type { ChildProcess } from 'node:child_process'
import { terminateCli, type ProcessStopReport } from './process-stop.js'
import { armTimeout, envTimeoutMs } from './timeout.js'
import { promptInputForPlatform } from './types.js'
import { readBoundedLines } from './bounded-lines.js'
import type {
  CliAdapter,
  CliEvent,
  CliRunResult,
  CliToolCall,
} from './types.js'
import { setTimeout as delay } from 'node:timers/promises'
import {
  classifyProviderError,
  extractProviderErrorDetails,
  getProviderErrorPolicy,
  providerFailureLabel,
  type ProviderFailure,
} from '../core/provider-error.js'
import {
  backendEndpoint,
  sessionLimitTracker,
} from '../core/session-limit-tracker.js'

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000

// CLI 收尾时可能再包一层通用 429/执行失败，不能覆盖更具体的余额或额度原因。
const failurePriority = (failure: ProviderFailure): number => {
  if (failure.type === 'unknown') return 0
  const specific = !['rate_limit', 'service_unavailable'].includes(failure.type)
  return (specific ? 4 : 1) + (failure.code ? 1 : 0)
}

// 只返回调用标识与入参，去掉事件上的其他字段
const toToolCalls = (calls: Map<string, CliToolCall>): CliToolCall[] =>
  [...calls.values()].map((call) => ({
    toolUseId: call.toolUseId,
    toolName: call.toolName,
    input: call.input,
  }))

export interface RunCliOptions {
  environment?: 'inherit' | 'isolated'
  onProcessStop?: (result: ProcessStopReport) => void
  /** 宿主可替换进程终止端口以验证系统失败；桌面生产路径始终使用默认实现。 */
  stopProcess?: (child: ChildProcess) => Promise<boolean>
  onProcessStart?: (pid: number) => void
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

export class ProviderCliError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly sessionId?: string,
    readonly performedWork = false,
  ) {
    super(failure.message)
    this.name = 'ProviderCliError'
  }
}

// 所有执行入口共用分类/冷却；只有未执行工具或产生结果的轮次可以自动重试。
export const runCli = async (options: RunCliOptions): Promise<CliRunResult> => {
  options.signal?.throwIfAborted()
  const policy = getProviderErrorPolicy()

  const unavailable = sessionLimitTracker.getLimitInfo(
    options.adapter.id,
    options.env,
  )

  if (unavailable.failure)
    throw new ProviderCliError(unavailable.failure, options.sessionId)

  const deadline =
    Date.now() +
    (options.timeoutMs ?? envTimeoutMs(options.adapter) ?? DEFAULT_TIMEOUT_MS)

  let sessionId = options.sessionId
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      throw new Error(`${options.adapter.displayName} 执行超时`)
    try {
      return await runCliOnce({
        ...options,
        ...(sessionId ? { sessionId } : {}),
        timeoutMs: remaining,
      })
    } catch (error) {
      if (!(error instanceof ProviderCliError) || options.signal?.aborted)
        throw error
      sessionId = error.sessionId ?? sessionId

      const retryDelay =
        error.failure.retryAfterMs ?? policy.baseDelayMs * 2 ** attempt

      if (
        !error.performedWork &&
        error.failure.retryable &&
        attempt < policy.maxRetries &&
        retryDelay <= policy.maxRetryDelayMs &&
        Date.now() + retryDelay < deadline
      ) {
        options.onEvent?.({
          type: 'retry',
          attempt: attempt + 1,
          delayMs: retryDelay,
          reason: providerFailureLabel(error.failure.type),
        })
        await delay(retryDelay, undefined, { signal: options.signal })
        continue
      }
      sessionLimitTracker.markFailure(
        options.adapter.id,
        options.env,
        error.failure,
      )
      throw error
    }
  }
}

// Runner 只读取适配器翻译后的 CliEvent，不再关心供应商的原生字段。
const runCliOnce = (options: RunCliOptions): Promise<CliRunResult> => {
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
      : (env?.CLAUDE_REASONING_EFFORT ?? process.env.CLAUDE_REASONING_EFFORT)

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
    if (signal?.aborted) {
      reject(new Error(`${adapter.displayName} 执行已取消`))
      return
    }

    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      env:
        env || options.environment === 'isolated'
          ? { ...cliEnvironment(options.environment), ...env }
          : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (child.pid) options.onProcessStart?.(child.pid)
    let termination: Promise<boolean> | undefined

    const terminate = () => {
      termination ??= options.stopProcess
        ? options.stopProcess(child)
        : terminateCli(child, options.onProcessStop)
    }

    // stdin 模式下把 prompt 写入子进程；否则 prompt 已在命令行参数里，stdin 直接收口。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8')
      else child.stdin.end()
    }
    // spawn 的 signal 选项只杀直接子进程（cmd 外壳），Windows 下 claude.exe/codex.exe 会变孤儿；
    // 额外监听 abort 用 killCli 连进程树一起清。
    const abort = terminate
    signal?.addEventListener('abort', abort, { once: true })
    let outputOverflow = false
    //记住最近一次出现的会话标识
    let observedSessionId = sessionId
    let observedAnswer: string | undefined
    let observedStats: CliRunResult['stats']

    const observedToolCalls = new Map<string, CliToolCall>()
    const rejectedToolCalls = new Map<string, CliToolCall>()

    let finalResult: CliRunResult | undefined
    let stoppedByToolCall: CliToolCall | undefined
    let resultError: ProviderCliError | undefined
    let performedWork = false
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = armTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }

    const onLine = (line: string) => {
      // 遍历适配器翻译后的事件，先进入onEvent，再进入 Runner 原有会话，错误，最终结果
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event)
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId
        }
        if (event.type === 'error') {
          const failure = classifyProviderError(
            { ...event.details, message: event.message },
            backendEndpoint(adapter.id, env),
          )

          if (
            !resultError ||
            failurePriority(failure) >= failurePriority(resultError.failure)
          ) {
            resultError = new ProviderCliError(
              failure,
              observedSessionId,
              performedWork,
            )
          }
          continue
        }
        if (
          event.type === 'tool_start' ||
          event.type === 'tool_call' ||
          event.type === 'result'
        ) {
          performedWork = true
        }
        // 应用层工具调用按 toolUseId 去重收集；调用失败时在 tool_end 移入 rejected，
        // 成功与被拒的调用分别随结果返回（见下方 finalResult.toolCalls）
        if (event.type === 'tool_call') {
          observedToolCalls.set(event.toolUseId, event)
          if (!stoppedByToolCall && stopToolNames.includes(event.toolName)) {
            stoppedByToolCall = {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
            }
            terminate()
          }
          continue
        }
        if (event.type === 'tool_end' && event.failed) {
          const rejected = observedToolCalls.get(event.toolUseId)
          if (rejected) {
            observedToolCalls.delete(event.toolUseId)
            rejectedToolCalls.set(event.toolUseId, rejected)
          }
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
          // CLI 自己已从临时网络/限流错误恢复，后续成功结果不应被旧错误覆盖。
          if (resultError?.failure.retryable) resultError = undefined
          if (event.answer) observedAnswer = event.answer
          if (event.stats) observedStats = event.stats
          if (!observedAnswer) continue
          const resultSessionId = event.sessionId ?? observedSessionId
          finalResult = {
            answer: observedAnswer,
            ...(event.humanRequest ? { humanRequest: event.humanRequest } : {}),
            ...(resultSessionId ? { sessionId: resultSessionId } : {}),
            ...(observedStats ? { stats: observedStats } : {}),
          }
        }
      }
    }

    readBoundedLines({
      stream: child.stdout,
      onLine,
      onOverflow: () => {
        outputOverflow = true
        terminate()
      },
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-65_536)
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
    child.once('close', async (code) => {
      if (settled) return
      if (termination && !(await termination)) {
        fail(new Error('STATE_UNCERTAIN'))
        return
      }
      if (outputOverflow) return fail(new Error('CLI_OUTPUT_LIMIT'))
      if (stoppedByToolCall) {
        settled = true
        finish()
        resolve({
          answer: observedAnswer ?? '',
          ...(observedSessionId ? { sessionId: observedSessionId } : {}),
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
      // 正常退出且已有成功结果时，stderr 只作为诊断日志，不影响成功状态。
      if (stderr.trim() && (code !== 0 || !finalResult || resultError)) {
        const stderrFailure = classifyProviderError(
          {
            ...extractProviderErrorDetails(stderr.trim()),
            message: stderr.trim(),
          },
          backendEndpoint(adapter.id, env),
        )

        if (
          !resultError ||
          failurePriority(stderrFailure) > failurePriority(resultError.failure)
        ) {
          resultError = new ProviderCliError(
            stderrFailure,
            observedSessionId,
            performedWork,
          )
        }
      }
      if (resultError)
        return fail(
          new ProviderCliError(
            resultError.failure,
            observedSessionId,
            performedWork,
          ),
        )
      if (code !== 0) {
        return fail(
          new ProviderCliError(
            classifyProviderError(
              {
                ...extractProviderErrorDetails(stderr.trim()),
                message:
                  stderr.trim() ||
                  `${adapter.displayName} 退出，状态码 ${code}`,
              },
              backendEndpoint(adapter.id, env),
            ),
            observedSessionId,
            performedWork,
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
        finalResult.toolCalls = toToolCalls(observedToolCalls)
      }
      if (rejectedToolCalls.size > 0) {
        finalResult.rejectedToolCalls = toToolCalls(rejectedToolCalls)
      }
      settled = true
      finish()
      resolve(finalResult)
    })
  })
}
