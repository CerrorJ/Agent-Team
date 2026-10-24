import type { WorkspaceStore } from './workspace-store.js'
import {
  roleVersionSchema,
  type BusinessCommand,
  type RoleVersion,
} from './business-contracts.js'

type RoleSave = Extract<BusinessCommand, { type: 'role.save' }>

/** 在保存版本的同一事务内保留标识及唯一性；旧客户端省略字段时不能擦除新配置。 */
export const resolveRoleConfiguration = (input: {
  store: WorkspaceStore
  command: RoleSave
  id: string
}) => {
  const { command } = input
  const previous = readPreviousRole(input)

  const inherited = previous ?? {
    inputRequirements: '',
    deliveryRequirements: '',
    maxConcurrency: 1,
  }

  return {
    slug: resolveIdentifier({ ...input, previous }),
    inputRequirements:
      command.inputRequirements ?? inherited.inputRequirements ?? '',
    deliveryRequirements:
      command.deliveryRequirements ?? inherited.deliveryRequirements ?? '',
    maxConcurrency: command.maxConcurrency ?? inherited.maxConcurrency ?? 1,
  }
}

const readPreviousRole = (input: {
  store: WorkspaceStore
  command: RoleSave
  id: string
}): RoleVersion | undefined => {
  if (!input.command.id) return undefined
  const previous = input.store.get('role_versions', input.id, roleVersionSchema)
  if (previous.version !== input.command.expectedVersion)
    throw new Error('VERSION_CONFLICT')
  return previous
}

const resolveIdentifier = (input: {
  store: WorkspaceStore
  command: RoleSave
  id: string
  previous: RoleVersion | undefined
}): string => {
  const { store, command, id } = input
  const saved = input.previous?.slug
  if (saved && command.slug && saved !== command.slug)
    throw new Error('ROLE_IDENTIFIER_IMMUTABLE')
  const slug = saved ?? command.slug ?? `role-${id.replaceAll('-', '')}`
  assertRoleIdentifierAvailable({ store, id, slug })
  return slug
}

/** 历史标识也保留占用；调用者必须在配置写事务内执行，复制角色共用此不变量。 */
export const assertRoleIdentifierAvailable = ({
  store,
  id,
  slug,
}: {
  store: WorkspaceStore
  id: string
  slug: string
}): void => {
  if (
    store
      .list('role_versions', roleVersionSchema)
      .some((role) => role.id !== id && role.slug === slug)
  )
    throw new Error('ROLE_IDENTIFIER_TAKEN')
}
