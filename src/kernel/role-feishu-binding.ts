import { randomUUID } from 'node:crypto'
import type { WorkspaceStore } from './workspace-store.js'
import {
  roleVersionSchema,
  type BusinessCommand,
} from './business-contracts.js'
import { FeishuStore } from './feishu-store.js'
import { type FeishuBinding, feishuBindingSchema } from './feishu-contracts.js'

/** 应用的历史归属也保留，避免旧执行/卡片被另一个角色或工作空间连接领取。 */
export const assertRoleAppAvailable = (input: {
  store: WorkspaceStore
  appId: string
  roleId?: string
}): void => {
  const occupied = input.store
    .list('role_versions', roleVersionSchema)
    .some(
      (role) =>
        role.id !== input.roleId &&
        role.feishuBinding?.appId.toLowerCase() === input.appId.toLowerCase(),
    )

  if (occupied || new FeishuStore(input.store).ownsApp(input.appId))
    throw new Error('FEISHU_APP_IN_USE')
}

/** 省略继承、null明确无渠道；配置变化创建新身份，不改写旧Run中的绑定。 */
export const resolveRoleFeishu = (input: {
  store: WorkspaceStore
  command: Extract<BusinessCommand, { type: 'role.save' }>
  id: string
}): { feishuBinding?: FeishuBinding | null } => {
  const { store, command, id } = input

  const previous = command.id
    ? store.get('role_versions', id, roleVersionSchema).feishuBinding
    : undefined

  if (command.feishu === undefined)
    return previous === undefined ? {} : { feishuBinding: previous }
  if (command.feishu === null) return { feishuBinding: null }
  assertRoleAppAvailable({ store, appId: command.feishu.appId, roleId: id })
  if (previous && sameConfiguration(previous, command.feishu))
    return { feishuBinding: previous }
  return {
    feishuBinding: feishuBindingSchema.parse({
      ...command.feishu,
      id: randomUUID(),
      version: 1,
      updatedAt: new Date().toISOString(),
    }),
  }
}

const sameConfiguration = (
  binding: FeishuBinding,
  input: NonNullable<Extract<BusinessCommand, { type: 'role.save' }>['feishu']>,
): boolean =>
  (Object.keys(input) as (keyof typeof input)[]).every(
    (key) => binding[key] === input[key],
  )
