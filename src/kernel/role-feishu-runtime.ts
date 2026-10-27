import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceService } from './workspace-service.js'
import type { FeishuCredentialResolver } from './feishu-runtime.js'
import { feishuAppIdSchema, type FeishuBinding } from './feishu-contracts.js'
import type { FeishuTransportFactory } from './feishu-transport.js'
import { roleVersionSchema, runSchema } from './business-contracts.js'
import { RoleFeishuSession } from './role-feishu-session.js'
import { RoleFeishuStore } from './role-feishu-store.js'

/** 与旧工作空间连接并存；每个应用的历史归属唯一，连接不自动启用执行角色。 */
export class RoleFeishuRuntime {
  private readonly sessions = new Map<
    string,
    { roleId: string; session: RoleFeishuSession }
  >()
  private readonly retiring = new Set<Promise<void>>()

  constructor(
    private readonly options: {
      store: WorkspaceStore
      service: WorkspaceService
      credentials?: FeishuCredentialResolver
      factory?: FeishuTransportFactory
    },
  ) {}

  async connect(input: {
    roleId: string
    expectedRoleVersion: number
  }): Promise<void> {
    const role = this.options.store.get(
      'role_versions',
      input.roleId,
      roleVersionSchema,
    )

    if (role.version !== input.expectedRoleVersion)
      throw new Error('VERSION_CONFLICT')
    if (!this.options.credentials) throw new Error('FEISHU_NOT_CONFIGURED')
    const bindings = this.pendingBindings(input.roleId)
    if (role.feishuBinding?.enabled)
      bindings.set(role.feishuBinding.appId.toLowerCase(), role.feishuBinding)
    if (!bindings.size) throw new Error('FEISHU_NOT_CONFIGURED')

    // 各应用独立结果；一个应用失败不撤销其他已连通渠道，也不改业务配置。
    const results = await Promise.allSettled(
      [...bindings.values()].map((binding) =>
        this.connectApp(input.roleId, binding),
      ),
    )

    if (results.some((result) => result.status === 'rejected'))
      throw new Error('FEISHU_NOT_CONFIGURED')
  }

  status(roleId: string) {
    const role = this.options.store.get(
      'role_versions',
      roleId,
      roleVersionSchema,
    )

    return {
      roleId,
      roleVersion: role.version,
      connections: [...this.sessions.values()]
        .filter((entry) => entry.roleId === roleId)
        .map((entry) => entry.session.status()),
    }
  }

  disconnect(roleId: string): void {
    for (const [appId, entry] of this.sessions) {
      if (entry.roleId !== roleId) continue
      entry.session.close()
      this.retire(entry.session)
      this.sessions.delete(appId)
    }
  }

  close(): void {
    for (const entry of this.sessions.values()) {
      entry.session.close()
      this.retire(entry.session)
    }
    this.sessions.clear()
  }

  async drain(): Promise<void> {
    await Promise.all(this.retiring)
  }

  private pendingBindings(roleId: string): Map<string, FeishuBinding> {
    const channel = new RoleFeishuStore(this.options.store)
    const bindings = new Map<string, FeishuBinding>()
    for (const run of this.options.store.list('runs', runSchema)) {
      const binding = run.roleSnapshot.feishuBinding
      if (
        run.roleSnapshot.id === roleId &&
        binding?.enabled &&
        run.purpose !== 'role_trial' &&
        (![
          'succeeded',
          'failed',
          'stopped',
          'cancelled',
          'interrupted',
        ].includes(run.status) ||
          channel.pending(binding).length > 0)
      )
        bindings.set(binding.appId.toLowerCase(), binding)
    }
    return bindings
  }

  private async connectApp(
    roleId: string,
    binding: FeishuBinding,
  ): Promise<void> {
    if (!feishuAppIdSchema.safeParse(binding.appId).success)
      throw new Error('FEISHU_NOT_CONFIGURED')
    const appKey = binding.appId.toLowerCase()
    const previous = this.sessions.get(appKey)
    previous?.session.close()

    const session = new RoleFeishuSession({
      ...this.options,
      binding,
      credentials: this.options.credentials!,
    })

    this.sessions.set(appKey, { roleId, session })
    if (previous) await this.retire(previous.session)
    await session.start()
  }

  private retire(session: RoleFeishuSession): Promise<void> {
    const pending = session.drain().finally(() => {
      this.retiring.delete(pending)
    })

    this.retiring.add(pending)
    return pending
  }
}
