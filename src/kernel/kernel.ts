import { KernelJournal } from './journal.js'
import { WorkspaceStore } from './workspace-store.js'
import { WorkspaceService } from './workspace-service.js'
import { publicError } from './public-errors.js'
import type { CliExecutionPort } from './run-execution.js'
import {
  DATA_SCHEMA_VERSION,
  KERNEL_VERSION,
  PROTOCOL_VERSION,
  deliverySchema,
  runSchema,
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
  execute?: CliExecutionPort
}

/** 导入不读取 .env 或启动渠道；创建后仅恢复已授权的本机任务。 */
export const createKernel = (options: KernelOptions): EmbeddedKernel =>
  new EmbeddedKernel(options)

export class EmbeddedKernel {
  private readonly journal: KernelJournal
  private readonly store: WorkspaceStore
  private readonly service: WorkspaceService
  private stopped = false
  private stopping: Promise<{ state: 'stopped' }> | undefined
  readonly handshake: KernelHandshake

  constructor(private readonly options: KernelOptions) {
    this.handshake = handshakeSchema.parse({
      kernelVersion: KERNEL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: DATA_SCHEMA_VERSION,
      sourceCommit: options.sourceCommit,
      capabilities: [
        'health',
        'persistent-events',
        'graceful-shutdown',
        'local-workflow',
      ],
      unavailable: ['feishu', 'skills', 'teams'],
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    })
    this.journal = new KernelJournal(options.dataDirectory)
    try {
      this.store = new WorkspaceStore(this.journal.database)
      this.service = new WorkspaceService({
        store: this.store,
        dataDirectory: options.dataDirectory,
        ...(options.execute ? { execute: options.execute } : {}),
      })
      this.emit('kernel.started')
    } catch (error) {
      this.journal.close()
      throw error
    }
  }

  async dispatch(input: unknown): Promise<KernelResponse> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success)
      return this.reject(null, new Error('VALIDATION_FAILED'))
    const request = parsed.data
    if (
      (this.stopped || this.stopping) &&
      request.method !== 'kernel.shutdown'
    ) {
      return this.reject(request.requestId, new Error('KERNEL_STOPPED'))
    }
    try {
      if (request.method === 'workspace.command') {
        const outcome = this.service.command(request)
        return {
          protocolVersion: 1,
          requestId: request.requestId,
          status: outcome.status,
          result: { id: outcome.id },
        }
      }
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        status: 'completed',
        result: await this.execute(request),
      }
    } catch (error) {
      return this.reject(request.requestId, error)
    }
  }

  private execute(
    request: Exclude<KernelRequest, { method: 'workspace.command' }>,
  ): unknown {
    switch (request.method) {
      case 'kernel.handshake':
        return this.handshake
      case 'kernel.health':
        return { state: 'running' }
      case 'kernel.events':
        return this.journal.read(request.after)
      case 'workspace.snapshot':
        return this.store.snapshot()
      case 'workspace.delivery':
        return this.store.get('deliveries', request.id, deliverySchema)
      case 'workspace.run':
        return this.store.get('runs', request.id, runSchema)
      case 'kernel.shutdown':
        return this.shutdown()
    }
  }

  /** 等待 CLI 执行/停止结果落盘后才确认关闭，超时由宿主显示状态待确认。 */
  shutdown(): Promise<{ state: 'stopped' }> {
    if (this.stopping) return this.stopping
    this.stopping = this.close().catch((error: unknown) => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }

  private async close(): Promise<{ state: 'stopped' }> {
    if (!this.stopped) {
      await this.service.shutdown()
      this.emit('kernel.stopped')
      this.journal.close()
      this.stopped = true
    }
    return { state: 'stopped' }
  }

  private emit(type: KernelEvent['type']): void {
    const event = this.journal.append(type)
    try {
      this.options.onEvent?.(event)
    } catch {
      /* 客户端通过游标补读已提交事件。 */
    }
  }

  private reject(requestId: string | null, error: unknown): KernelResponse {
    return {
      protocolVersion: 1,
      requestId,
      status: 'rejected',
      error: publicError(error),
    }
  }
}
