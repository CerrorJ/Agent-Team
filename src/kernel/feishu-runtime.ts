import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceService } from './workspace-service.js'
import { FeishuStore } from './feishu-store.js'
import type {
  FeishuCredentialBinding,
  FeishuBinding,
} from './feishu-contracts.js'
import { z } from 'zod'
import {
  createFeishuTransport,
  type FeishuTransport,
  type FeishuTransportFactory,
} from './feishu-transport.js'
import { applyFeishuAction } from './feishu-actions.js'
import { flushFeishuNotification } from './feishu-notifications.js'
import { publicError } from './public-errors.js'

export type FeishuCredentialResolver = (
  binding: FeishuCredentialBinding,
) => Promise<string>

/** 单连接生命周期与投递队列由内核持有；关闭不意味着撤销尚在途的网络请求。 */
export class FeishuRuntime {
  private transport: FeishuTransport | undefined
  private generation = 0
  private version: number | null = null
  private errorCode: string | null = null
  private busy = false
  private phase: 'disconnected' | 'connecting' | 'failed' = 'disconnected'
  private inFlight: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(
    private readonly options: {
      store: WorkspaceStore
      service: WorkspaceService
      credentials?: FeishuCredentialResolver
      factory?: FeishuTransportFactory
    },
  ) {}

  async connect(): Promise<void> {
    this.close()
    const binding = new FeishuStore(this.options.store).binding()
    if (!binding?.enabled || !this.options.credentials)
      throw new Error('FEISHU_NOT_CONFIGURED')
    const generation = this.generation
    this.version = binding.version
    this.phase = 'connecting'

    const secret = await this.secret(binding, generation)

    if (generation !== this.generation) return
    this.transport = (this.options.factory ?? createFeishuTransport)({
      binding,
      secret,
      onAction: (raw) => this.action({ binding, generation, raw }),
    })
    this.timer = setInterval(() => this.tick(generation), 1000)
    this.timer.unref()
    void this.transport.start().catch(() => {
      if (generation !== this.generation) return
      this.transport?.close()
      this.transport = undefined
      this.phase = 'failed'
      this.errorCode = 'FEISHU_NETWORK_FAILED'
    })
  }

  status() {
    const channel = new FeishuStore(this.options.store)
    const binding = channel.binding()
    return {
      state: this.transport?.state() ?? this.phase,
      bindingVersion: this.version,
      errorCode: this.errorCode,
      pendingNotifications: binding ? channel.pending(binding).length : 0,
    }
  }

  close(): void {
    this.generation++
    clearInterval(this.timer)
    this.transport?.close()
    this.transport = undefined
    this.version = null
    this.errorCode = null
    this.phase = 'disconnected'
  }

  reconcileBinding(): void {
    if (
      this.version !== null &&
      new FeishuStore(this.options.store).binding()?.version !== this.version
    )
      this.close()
  }

  async drain(): Promise<void> {
    await this.inFlight
  }

  private async secret(
    binding: FeishuBinding,
    generation: number,
  ): Promise<string> {
    try {
      return z
        .string()
        .min(1)
        .max(16384)
        .parse(
          await this.options.credentials!({
            reference: binding.credentialRef,
            appId: binding.appId,
          }),
        )
    } catch {
      if (generation === this.generation) {
        this.phase = 'failed'
        this.errorCode = 'FEISHU_NOT_CONFIGURED'
      }
      throw new Error('FEISHU_NOT_CONFIGURED')
    }
  }

  private action(input: {
    binding: FeishuBinding
    generation: number
    raw: unknown
  }) {
    try {
      if (
        input.generation !== this.generation ||
        new FeishuStore(this.options.store).binding()?.version !==
          input.binding.version
      )
        throw new Error('FEISHU_IDENTITY_MISMATCH')
      applyFeishuAction({
        ...this.options,
        binding: input.binding,
        raw: input.raw,
      })
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

  private tick(generation: number): void {
    if (this.inFlight) return
    this.inFlight = this.flush(generation).finally(() => {
      this.inFlight = undefined
    })
  }

  private async flush(generation: number): Promise<void> {
    if (
      this.busy ||
      generation !== this.generation ||
      this.transport?.state() !== 'connected'
    )
      return
    const binding = new FeishuStore(this.options.store).binding()
    if (!binding || binding.version !== this.version || !binding.enabled) {
      this.close()
      return
    }
    this.busy = true
    try {
      await flushFeishuNotification({
        store: this.options.store,
        binding,
        transport: this.transport,
      })
      this.errorCode = null
    } catch (error) {
      this.errorCode = notificationErrorCode(error)
    } finally {
      this.busy = false
    }
  }
}

const notificationErrorCode = (error: unknown): string =>
  error instanceof Error && error.message === 'FEISHU_DELIVERY_UNCERTAIN'
    ? error.message
    : 'FEISHU_NETWORK_FAILED'
