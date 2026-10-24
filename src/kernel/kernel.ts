import { KernelJournal } from './journal.js'
import { WorkspaceStore } from './workspace-store.js'
import { WorkspaceService } from './workspace-service.js'
import { publicError } from './public-errors.js'
import { inspectWorkspaceEnvironment } from './workspace-diagnostics.js'
import { inspectTaskPreflight } from './task-preflight.js'
import { CliInspection } from './cli-inspection.js'
import type { CliExecutionPort } from './run-execution.js'
import type { CredentialResolver } from './credential-contracts.js'
import {
  FeishuRuntime,
  type FeishuCredentialResolver,
} from './feishu-runtime.js'
import type { FeishuTransportFactory } from './feishu-transport.js'
import type { SkillFetch } from './skill-download.js'
import {
  WorkspaceMaintenance,
  isMaintenanceRequest,
} from './workspace-maintenance.js'
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
  credentials?: CredentialResolver
  feishuCredentials?: FeishuCredentialResolver
  feishuTransport?: FeishuTransportFactory
  skillFetch?: SkillFetch
}

/** 导入不读取 .env 或启动渠道；创建后仅恢复已授权的本机任务。 */
export const createKernel = (options: KernelOptions): EmbeddedKernel =>
  new EmbeddedKernel(options)

export class EmbeddedKernel {
  private readonly journal: KernelJournal
  private readonly store: WorkspaceStore
  private readonly service: WorkspaceService
  private readonly feishu: FeishuRuntime
  private readonly maintenance: WorkspaceMaintenance
  private readonly cliInspection: CliInspection
  private stopped = false
  private stopping: Promise<{ state: 'stopped' }> | undefined
  readonly handshake: KernelHandshake

  constructor(private readonly options: KernelOptions) {
    this.handshake = createHandshake(options.sourceCommit)
    this.cliInspection = new CliInspection({ cwd: options.dataDirectory })
    this.journal = new KernelJournal(options.dataDirectory)
    try {
      this.store = new WorkspaceStore(this.journal.database)
      this.service = new WorkspaceService({
        store: this.store,
        dataDirectory: options.dataDirectory,
        ...(options.execute ? { execute: options.execute } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(options.skillFetch ? { skillFetch: options.skillFetch } : {}),
      })
      this.feishu = new FeishuRuntime({
        store: this.store,
        service: this.service,
        ...(options.feishuCredentials
          ? { credentials: options.feishuCredentials }
          : {}),
        ...(options.feishuTransport
          ? { factory: options.feishuTransport }
          : {}),
      })
      this.maintenance = new WorkspaceMaintenance({
        store: this.store,
        service: this.service,
        dataDirectory: options.dataDirectory,
        sourceCommit: options.sourceCommit,
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
        if (request.command.type === 'feishu.save')
          this.feishu.reconcileBinding()
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
        result: await this.query(request),
      }
    } catch (error) {
      return this.reject(request.requestId, error)
    }
  }

  private query(
    request: Exclude<KernelRequest, { method: 'workspace.command' }>,
  ): unknown {
    if (isMaintenanceRequest(request)) return this.maintenance.dispatch(request)
    if (request.method === 'workspace.preflight')
      return inspectTaskPreflight(this.store, request.input)
    if (request.method === 'kernel.cliCheck')
      return this.cliInspection.inspect(request.input)
    if (request.method.startsWith('feishu.'))
      return this.channelRequest(request)
    return this.execute(request)
  }

  private execute(
    request: Exclude<KernelRequest, { method: 'workspace.command' }>,
  ): unknown {
    switch (request.method) {
      case 'kernel.handshake':
        return this.handshake
      case 'kernel.health':
        return { state: 'running' }
      case 'kernel.diagnostics':
        return inspectWorkspaceEnvironment({
          store: this.store,
          dataDirectory: this.options.dataDirectory,
        })
      case 'kernel.events':
        return this.journal.read(request.after)
      case 'workspace.snapshot':
        return this.store.snapshot()
      case 'workspace.delivery':
        return this.store.get('deliveries', request.id, deliverySchema)
      case 'workspace.run':
        return this.store.get('runs', request.id, runSchema)
      case 'workspace.activity':
        this.store.get('runs', request.id, runSchema)
        return this.store.activity(request.id)
      case 'kernel.shutdown':
        return this.shutdown()
    }
  }

  private channelRequest(request: KernelRequest): unknown {
    switch (request.method) {
      case 'feishu.connect':
        return this.feishu.connect().then(() => this.feishu.status())
      case 'feishu.disconnect':
        this.feishu.close()
        return this.feishu.status()
      case 'feishu.status':
        return this.feishu.status()
      default:
        throw new Error('VALIDATION_FAILED')
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
      this.feishu.close()
      await this.service.shutdown()
      await this.cliInspection.shutdown()
      await this.feishu.drain()
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

const createHandshake = (sourceCommit: string): KernelHandshake => {
  return handshakeSchema.parse({
    kernelVersion: KERNEL_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    sourceCommit: sourceCommit,
    capabilities: [
      'health',
      'persistent-events',
      'graceful-shutdown',
      'local-workflow',
      'product-catalog',
      'role-trials',
      'role-configuration',
      'role-copy',
      'task-preflight',
      'team-workflow',
      'codex-and-claude',
      'human-workflow',
      'feishu-channel',
      'skills',
      'workspace-backup',
      'environment-diagnostics',
      'cli-checks',
    ],
    unavailable: [],
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  })
}
