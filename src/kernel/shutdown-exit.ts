import {
  requestSchema,
  shutdownAcknowledgementSchema,
  type KernelResponse,
} from './protocol.js'

/** 进程退出与消息投递没有先后保证；等待宿主收讫，避免把正常停机误报为断线。 */
export class ShutdownExit {
  private pending: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly exit: (code: number) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  receive(input: unknown): boolean {
    const ack = shutdownAcknowledgementSchema.safeParse(input)
    if (!ack.success) return false
    if (ack.data.requestId === this.pending) {
      clearTimeout(this.timer)
      this.pending = undefined
      this.exit(0)
    }
    return true
  }

  responded(input: unknown, response: KernelResponse): void {
    const request = requestSchema.safeParse(input)
    if (!request.success || request.data.method !== 'kernel.shutdown') return
    if (response.status !== 'completed' || !isStopped(response.result)) return
    // 未请求新传输能力的旧宿主仍按原入口行为退出。
    if (!request.data.acknowledgeExit) {
      setImmediate(() => this.exit(0))
      return
    }
    if (this.pending) return
    this.pending = request.data.requestId
    this.timer = setTimeout(() => {
      this.pending = undefined
      this.exit(1)
    }, this.timeoutMs)
  }
}

const isStopped = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'state' in value &&
  value.state === 'stopped'
