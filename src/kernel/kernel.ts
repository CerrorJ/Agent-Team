import { KernelJournal } from './journal.js'
import {
  DATA_SCHEMA_VERSION,
  KERNEL_VERSION,
  PROTOCOL_VERSION,
  handshakeSchema,
  requestSchema,
  type KernelEvent,
  type KernelHandshake,
  type KernelRequest,
  type KernelResponse,
} from './protocol.js'

export interface KernelOptions {
  dataDirectory: string
  sourceCommit: string
  onEvent?: (event: KernelEvent) => void
}

/** 显式创建才打开独立数据目录；导入不读取 .env、不连接飞书或启动 CLI。 */
export const createKernel = (options: KernelOptions): EmbeddedKernel =>
  new EmbeddedKernel(options)

export class EmbeddedKernel {
  private readonly journal: KernelJournal
  private stopped = false
  readonly handshake: KernelHandshake

  constructor(private readonly options: KernelOptions) {
    this.handshake = handshakeSchema.parse({
      kernelVersion: KERNEL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: DATA_SCHEMA_VERSION,
      sourceCommit: options.sourceCommit,
      capabilities: ['health', 'persistent-events', 'graceful-shutdown'],
      unavailable: ['tasks', 'roles', 'projects', 'feishu', 'skills'],
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    })
    this.journal = new KernelJournal(options.dataDirectory)
    this.emit('kernel.started')
  }

  dispatch(input: unknown): KernelResponse {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success)
      return this.reject(
        null,
        'VALIDATION_FAILED',
        '内核命令格式或协议版本不兼容',
      )
    const request = parsed.data
    if (this.stopped && request.method !== 'kernel.shutdown') {
      return this.reject(request.requestId, 'KERNEL_STOPPED', '内核已停止')
    }
    try {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        status: 'completed',
        result: this.execute(request),
      }
    } catch {
      return this.reject(
        request.requestId,
        'INTERNAL_ERROR',
        '内核操作失败，请检查诊断记录',
      )
    }
  }

  private execute(request: KernelRequest): unknown {
    switch (request.method) {
      case 'kernel.handshake':
        return this.handshake
      case 'kernel.health':
        return { state: 'running' }
      case 'kernel.events':
        return this.journal.read(request.after)
      case 'kernel.shutdown':
        return this.shutdown()
    }
  }

  /** M0 尚无执行任务，关闭先记录结束事件，再释放 SQLite 与实例锁。 */
  shutdown(): { state: 'stopped' } {
    if (!this.stopped) {
      this.emit('kernel.stopped')
      this.journal.close()
      this.stopped = true
    }
    return { state: 'stopped' }
  }

  private emit(type: KernelEvent['type']): void {
    const event = this.journal.append(type)
    // 通知异常不能反向改变已提交事件；客户端从游标补读。
    try {
      this.options.onEvent?.(event)
    } catch {
      /* 保留持久事件供重新读取 */
    }
  }

  private reject(
    requestId: string | null,
    code: 'VALIDATION_FAILED' | 'KERNEL_STOPPED' | 'INTERNAL_ERROR',
    message: string,
  ): KernelResponse {
    return {
      protocolVersion: 1,
      requestId,
      status: 'rejected',
      error: { code, message, retryable: false },
    }
  }
}
