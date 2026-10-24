import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { spawnCli } from '../cli/spawn-cli.js'
import { terminateCli } from '../cli/process-stop.js'
import type { CliCheckInput } from './cli-check-contracts.js'
import type { CliProbeOutcome } from './cli-check-result.js'

type ProbeChild = ChildProcessByStdio<null, Readable, Readable>
export interface CliProbeSession {
  result: Promise<CliProbeOutcome>
  stop: () => Promise<boolean>
}
export interface CliProbeOptions {
  cwd: string
  onEnded: () => void
  timeoutMs?: number
  spawn?: (input: CliCheckInput, cwd: string) => ProbeChild
  terminate?: (child: ProbeChild) => Promise<boolean>
}

const startChild = (input: CliCheckInput, cwd: string): ProbeChild => {
  const args =
    input.check === 'version'
      ? ['--version']
      : input.cli === 'codex'
        ? ['login', 'status']
        : ['auth', 'status', '--json']

  return spawnCli(input.cli, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 所有探针进程归内核持有。超时返回未知时继续持有，不能以请求已返回代替进程结束。 */
export const startCliProbe = (
  input: CliCheckInput,
  options: CliProbeOptions,
): CliProbeSession => {
  try {
    const child = (options.spawn ?? startChild)(input, options.cwd)
    return new ProbeTracker(child, options)
  } catch {
    options.onEnded()
    return {
      result: Promise.resolve({
        exitCode: null,
        output: '',
        failure: 'unavailable',
        confirmedEnded: true,
      }),
      stop: () => Promise.resolve(true),
    }
  }
}

class ProbeTracker implements CliProbeSession {
  private chunks: Buffer[] = []
  private bytes = 0
  private ended = false
  private resolved = false
  private interrupted = false
  private failure: CliProbeOutcome['failure']
  private stopping: Promise<boolean> | undefined
  private complete: (result: CliProbeOutcome) => void = () => undefined
  private readonly timer: ReturnType<typeof setTimeout>
  readonly result: Promise<CliProbeOutcome>

  constructor(
    private readonly child: ProbeChild,
    private readonly options: CliProbeOptions,
  ) {
    this.result = new Promise((resolve) => {
      this.complete = resolve
    })
    this.timer = setTimeout(() => {
      void this.interrupt('timeout')
    }, options.timeoutMs ?? 10_000)
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.receive(chunk))
    child.once('error', () => this.errored())
    child.once('close', (code) => {
      // 请求终止后的root close不能掩盖整树终止失败；保留未知并阻止退出成功。
      if (!this.interrupted) this.finish(code, true)
    })
  }

  readonly stop = (): Promise<boolean> => {
    if (this.ended) return Promise.resolve(true)
    this.interrupted = true
    this.failure ??= 'failed'
    this.stopping ??= (this.options.terminate ?? terminateCli)(this.child)
      .catch(() => false)
      .then((confirmed) => {
        this.finish(null, confirmed)
        return confirmed
      })
    return this.stopping
  }

  private finish(exitCode: number | null, confirmedEnded: boolean): void {
    if (confirmedEnded && !this.ended) {
      this.ended = true
      this.options.onEnded()
    }
    if (this.resolved) return
    this.resolved = true
    clearTimeout(this.timer)
    this.complete({
      exitCode,
      output: Buffer.concat(this.chunks).toString('utf8'),
      confirmedEnded,
      ...(this.failure ? { failure: this.failure } : {}),
    })
    this.chunks = []
  }

  private async interrupt(
    reason: NonNullable<CliProbeOutcome['failure']>,
  ): Promise<void> {
    this.failure ??= reason
    await this.stop()
  }

  private receive(chunk: Buffer): void {
    if (this.resolved || this.interrupted) return
    this.bytes += chunk.byteLength
    if (this.bytes > 32_768) {
      void this.interrupt('output-limit')
      return
    }
    this.chunks.push(chunk)
  }

  private errored(): void {
    this.failure ??= 'unavailable'
    // spawn失败没有pid；运行期错误不能据此断言进程树已经结束。
    if (!this.child.pid) this.finish(null, true)
    else void this.interrupt('failed')
  }
}
