import { randomUUID } from 'node:crypto'
import {
  roleVersionSchema,
  type BusinessCommand,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import { assertRoleIdentifierAvailable } from './role-configuration.js'
import { RoleReadinessStore } from './role-readiness-store.js'

/** 在命令账本事务内复制确切的当前配置；不继承证明、执行、审批或渠道身份。 */
export const copyRole = (input: {
  store: WorkspaceStore
  command: Extract<BusinessCommand, { type: 'role.copy' }>
}): { id: string } => {
  const { store, command } = input

  const source = store.get(
    'role_versions',
    command.sourceRoleId,
    roleVersionSchema,
  )

  if (source.version !== command.expectedSourceVersion)
    throw new Error('VERSION_CONFLICT')
  const id = randomUUID()
  assertRoleIdentifierAvailable({ store, id, slug: command.slug })

  const role = roleVersionSchema.parse({
    ...source,
    feishuBinding: null,
    id,
    version: 1,
    name: command.name,
    slug: command.slug,
    inputRequirements: source.inputRequirements ?? '',
    deliveryRequirements: source.deliveryRequirements ?? '',
    maxConcurrency: source.maxConcurrency ?? 1,
    modelProfileSnapshot: source.modelProfileSnapshot ?? null,
    createdAt: new Date().toISOString(),
  })

  // 复制为不可执行草稿，已失效的技能引用也保留供用户修正；真实试运行仍逐项校验。
  store.addRole(role)
  new RoleReadinessStore(store).reset(role)
  store.event('role.copied', {
    id,
    version: 1,
    sourceRoleId: source.id,
    sourceRoleVersion: source.version,
  })
  return { id }
}
