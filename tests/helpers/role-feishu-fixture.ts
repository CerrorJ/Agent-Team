import { randomUUID } from 'node:crypto'
import type { FeishuBinding } from '../../src/kernel/feishu-contracts.js'
import type { RoleVersion, Run } from '../../src/kernel/business-contracts.js'
import { HumanStore } from '../../src/kernel/human-store.js'
import { humanRequestSchema } from '../../src/kernel/human-contracts.js'
import { workspaceFixture } from './run-fixture.js'

export const syntheticBinding = (suffix: string): FeishuBinding => ({
  id: randomUUID(),
  version: 1,
  appId: `cli_${suffix.repeat(16)}`,
  tenantKey: `synthetic-${suffix}`,
  ownerOpenId: `ou_${suffix}`,
  chatId: `oc_${suffix}`,
  credentialRef: `feishu-${randomUUID()}`,
  enabled: true,
  updatedAt: new Date().toISOString(),
})

/** 仅用于状态/渠道边界的合成等待态，不冒充CLI或真实租户执行证据。 */
export const addWaitingRoleRun = (input: {
  fixture: ReturnType<typeof workspaceFixture>
  binding: FeishuBinding
  role?: RoleVersion
}) => {
  const { fixture, binding } = input

  const role: RoleVersion = input.role ?? {
    ...fixture.run.roleSnapshot,
    id: randomUUID(),
    feishuBinding: binding,
  }

  const taskId = randomUUID()
  const requestId = randomUUID()

  const run = {
    ...fixture.run,
    id: randomUUID(),
    taskId,
    roleSnapshot: role,
    status: 'waiting_approval' as const,
    processState: 'confirmed_ended' as const,
    pendingHumanRequestId: requestId,
  }

  const request = waitingRequest(run, requestId)
  fixture.store.transaction(() => {
    if (!input.role) fixture.store.addRole(role)
    fixture.store.addTask({
      id: taskId,
      version: 1,
      projectId: run.projectId,
      roleId: role.id,
      title: '合成渠道任务',
      goal: '核验路由',
      acceptanceCriteria: '人工验收',
      status: 'in_progress',
      createdAt: new Date().toISOString(),
    })
    fixture.store.addRun(run)
    new HumanStore(fixture.store).add(request)
  })
  return { run, request, role, binding }
}

const waitingRequest = (run: Run, requestId: string) =>
  humanRequestSchema.parse({
    id: requestId,
    version: 1,
    runId: run.id,
    taskId: run.taskId,
    projectId: run.projectId,
    segmentId: randomUUID(),
    payload: { kind: 'plan', title: '合成方案', summary: '真实状态机边界' },
    digest: 'a'.repeat(64),
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    decidedAt: null,
    decision: null,
    actor: null,
  })

export const syntheticAction = (
  input: ReturnType<typeof addWaitingRoleRun>,
) => ({
  event_id: randomUUID(),
  app_id: input.binding.appId,
  tenant_key: input.binding.tenantKey,
  operator: {
    open_id: input.binding.ownerOpenId,
    tenant_key: input.binding.tenantKey,
  },
  context: { open_chat_id: input.binding.chatId },
  action: {
    value: {
      bindingVersion: input.binding.version,
      bindingId: input.binding.id,
      requestId: input.request.id,
      expectedVersion: input.request.version,
      expectedDigest: input.request.digest,
      decision: 'rejected',
    },
    form_value: { reason: '合成拒绝，验证唯一人工用例' },
  },
})
