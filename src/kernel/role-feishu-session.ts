import { z } from 'zod'
import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceService } from './workspace-service.js'
import type { FeishuBinding } from './feishu-contracts.js'
import type { FeishuCredentialResolver } from './feishu-runtime.js'
import {
  createFeishuTransport,
  type FeishuTransportFactory,
  type FeishuTransport,
} from './feishu-transport.js'
import { RoleFeishuStore } from './role-feishu-store.js'
import { flushRoleFeishuNotification } from './role-feishu-notifications.js'
import { roleActionBinding } from './feishu-action-route.js'
import { applyFeishuAction } from './feishu-actions.js'
import { publicError } from './public-errors.js'

export interface RoleFeishuSessionOptions {
  store: WorkspaceStore
  service: WorkspaceService
  binding: FeishuBinding
  credentials: FeishuCredentialResolver
  factory?: FeishuTransportFactory
}

/** 每个应用只持有一条认证连接；同应用的历史配置按请求自身快照验证身份。 */
export class RoleFeishuSession {
  private transport: FeishuTransport | undefined
  private closed = false
  private phase: 'disconnected' | 'connecting' | 'failed' = 'disconnected'
  private errorCode: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined

  constructor(private readonly options: RoleFeishuSessionOptions) {}

  async start(): Promise<void> {
    if (this.closed) return
    this.phase = 'connecting'
    let secret: string
    try {
      secret = z
        .string()
        .min(1)
        .max(16384)
        .parse(
          await this.options.credentials({
            reference: this.options.binding.credentialRef,
            appId: this.options.binding.appId,
          }),
        )
    } catch {
      if (!this.closed) {
        this.phase = 'failed'
        this.errorCode = 'FEISHU_NOT_CONFIGURED'
      }
      throw new Error('FEISHU_NOT_CONFIGURED')
    }
    if (this.closed) return
    this.transport = (this.options.factory ?? createFeishuTransport)({
      binding: this.options.binding,
      secret,
      onAction: (raw) => this.action(raw),
    })
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
    void this.transport.start().catch(() => this.networkFailed())
  }

  status() {
    const channel = new RoleFeishuStore(this.options.store)
    return {
      appId: this.options.binding.appId,
      state: this.transport?.state() ?? this.phase,
      errorCode: this.errorCode,
      pendingNotifications: this.bindings().reduce(
        (total, binding) => total + channel.pending(binding).length,
        0,
      ),
    }
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
    this.transport?.close()
    this.transport = undefined
    this.phase = 'disconnected'
    this.errorCode = null
  }

  async drain(): Promise<void> {
    await this.inFlight
  }

  private bindings(): FeishuBinding[] {
    return new RoleFeishuStore(this.options.store)
      .bindings()
      .filter(
        (binding) =>
          binding.appId.toLowerCase() ===
          this.options.binding.appId.toLowerCase(),
      )
  }

  private action(raw: unknown) {
    try {
      if (this.closed) throw new Error('FEISHU_IDENTITY_MISMATCH')

      const binding = roleActionBinding({
        store: this.options.store,
        appId: this.options.binding.appId,
        raw,
      })

      applyFeishuAction({ ...this.options, binding, raw })
      return {
        toast: {
          type: 'success',
          content: '决定已提交，请以纬舟中的最新状态为准',
        },
      }
    } catch (error) {
      return { toast: { type: 'error', content: publicError(error).message } }
    }
  }

  private tick(): void {
    if (this.inFlight || this.closed || this.transport?.state() !== 'connected')
      return
    this.inFlight = this.flush()
      .catch(() => {
        if (!this.closed) this.errorCode = 'INTERNAL_ERROR'
      })
      .finally(() => {
        this.inFlight = undefined
      })
  }

  private async flush(): Promise<void> {
    let failure: string | null = null
    for (const binding of this.bindings()) {
      if (this.closed || !this.transport) return
      try {
        await flushRoleFeishuNotification({
          store: this.options.store,
          binding,
          transport: this.transport,
        })
      } catch (error) {
        failure =
          error instanceof Error &&
          error.message === 'FEISHU_DELIVERY_UNCERTAIN'
            ? error.message
            : 'FEISHU_NETWORK_FAILED'
      }
    }
    this.errorCode = failure
  }

  private networkFailed(): void {
    if (this.closed) return
    this.transport?.close()
    this.transport = undefined
    this.phase = 'failed'
    this.errorCode = 'FEISHU_NETWORK_FAILED'
  }
}
