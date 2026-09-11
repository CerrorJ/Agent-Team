import { createInterface } from 'node:readline'
import type { CliAdapter, CliCompactPlan } from './types.js'
import { killCli, spawnCli } from './spawn-cli.js'
import { armTimeout, envTimeoutMs } from './timeout.js'

// 压缩也是一次真实 CLI 执行，与 runCli 同样的超时语义：env 覆盖 → 默认 2 小时。
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000

export interface CompactCliSessionOptions {
  adapter: CliAdapter
  sessionId: string
  cwd: string
  instructions?: string
  signal?: AbortSignal
  timeoutMs?: number
  env?: Record<string, string>
}

export interface CompactCliSessionResult {
  sessionId: string
  compacted: boolean
  message?: string
}

interface JsonMessage {
  id?: unknown
  method?: unknown
  result?: unknown
  error?: unknown
  params?: unknown
  type?: unknown
  subtype?: unknown
  is_error?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const parseJson = (line: string): JsonMessage | undefined => {
  try {
    const value = JSON.parse(line) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const protocolError = (message: JsonMessage): string | undefined => {
  if (!isRecord(message.error)) return undefined
  return typeof message.error.message === 'string'
    ? message.error.message
    : '原生上下文整理失败'
}

// Claude Code 分支恢复当前会话并执行原生 /compact，收到 compact_boundary 才算真正完成
const runClaudeCompact = (
  plan: Extract<CliCompactPlan, { protocol: 'claude-stream-json' }>,
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> => {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`))
      return
    }

    const child = spawnCli(plan.command, plan.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // `-p -` 走 stdin，把 /compact 指令写入子进程后收口，否则 Claude 会空等 stdin。
    if (child.stdin) {
      child.stdin.write(`${plan.prompt}\n`, 'utf8')
      child.stdin.end()
    }
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    let completed = false
    let resultMessage: string | undefined
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      killCli(child)
      reject(error)
    }

    const abort = () =>
      fail(new Error(`${options.adapter.displayName} 上下文整理已取消`))

    const timer = armTimeout(
      () => fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? envTimeoutMs(options.adapter) ?? DEFAULT_TIMEOUT_MS,
    )

    options.signal?.addEventListener('abort', abort, { once: true })

    lines.on('line', (line) => {
      const message = parseJson(line)
      if (!message) return
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        completed = true
      }
      if (message.type === 'result' && message.is_error === true) {
        const result =
          typeof message.result === 'string'
            ? message.result
            : 'Claude Code 原生上下文整理失败'

        fail(new Error(result))
        return
      }
      if (message.type === 'result' && typeof message.result === 'string') {
        resultMessage = message.result.trim() || undefined
      }
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => fail(error))
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) {
        fail(new Error(stderr.trim() || `Claude Code 退出，状态码 ${code}`))
        return
      }
      if (!completed) {
        if (resultMessage === 'Not enough messages to compact.') {
          settled = true
          cleanup()
          resolve({
            sessionId: options.sessionId,
            compacted: false,
            message: '当前上下文还不需要整理。继续使用一段时间后再试。',
          })
          return
        }
        fail(new Error('Claude Code 没有返回上下文整理完成事件'))
        return
      }
      settled = true
      cleanup()
      resolve({ sessionId: options.sessionId, compacted: true })
    })
  })
}

// Codex 分支依次完成 app-server 初始化、恢复 thread、发起 thread/compact/start，随后等待 contextCompaction 完成事件。
const runCodexCompact = (
  plan: Extract<CliCompactPlan, { protocol: 'codex-app-server' }>,
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> => {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`))
      return
    }

    const child = spawnCli(plan.command, plan.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    let settled = false

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      killCli(child)
      reject(error)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      killCli(child)
      resolve({ sessionId: options.sessionId, compacted: true })
    }

    const abort = () =>
      fail(new Error(`${options.adapter.displayName} 上下文整理已取消`))

    const timer = armTimeout(
      () => fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? envTimeoutMs(options.adapter) ?? DEFAULT_TIMEOUT_MS,
    )

    options.signal?.addEventListener('abort', abort, { once: true })

    lines.on('line', (line) => {
      const message = parseJson(line)
      if (!message) return
      const error = protocolError(message)
      if (error) {
        fail(new Error(error))
        return
      }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} })
        send({
          id: 2,
          method: 'thread/resume',
          params: { threadId: plan.sessionId },
        })
        return
      }
      if (message.id === 2) {
        send({
          id: 3,
          method: 'thread/compact/start',
          params: { threadId: plan.sessionId },
        })
        return
      }
      if (message.method !== 'item/completed' || !isRecord(message.params)) {
        return
      }
      const item = message.params.item
      if (isRecord(item) && item.type === 'contextCompaction') succeed()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => fail(error))
    child.once('close', (code) => {
      if (settled) return
      fail(
        new Error(stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`),
      )
    })

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agent_team',
          title: 'Agent Team',
          version: '0.1.0',
        },
      },
    })
  })
}

// 在已有 CLI 会话内执行原生压缩：按适配器给出的计划分发到对应协议实现，
// 成功时会话 ID 不变（压缩发生在会话内部），message 非空表示 CLI 认为无需压缩
export const compactCliSession = (
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> => {
  const plan = options.adapter.buildCompactPlan(
    options.sessionId,
    options.instructions,
  )

  return plan.protocol === 'claude-stream-json'
    ? runClaudeCompact(plan, options)
    : runCodexCompact(plan, options)
}
