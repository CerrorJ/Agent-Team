import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { CliAdapter, CliEvent, CliRunResult } from './types.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface RunCliOptions {
  adapter: CliAdapter
  prompt: string
  cwd: string
  sessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
  } = options
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId)
    : adapter.buildArgs(prompt)

  return new Promise((resolve, reject) => {
    const child = spawn(adapter.command, args, {
      cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })
    //记住最近一次出现的会话标识
    let observedSessionId = sessionId
    let finalResult: CliRunResult | undefined
    let resultError: Error | undefined
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
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
        if (event.type === 'result') {
          finalResult = {
            answer: event.answer,
            sessionId: event.sessionId ?? observedSessionId,
            ...(event.stats ? { stats: event.stats } : {}),
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
      settled = true
      finish()
      resolve(finalResult)
    })
  })
}
