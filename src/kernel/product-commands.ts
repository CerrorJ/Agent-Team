import { randomUUID } from 'node:crypto'
import { normalizeProviderUrl } from './credential-contracts.js'
import {
  projectSchema,
  roleVersionSchema,
  type BusinessCommand,
} from './business-contracts.js'
import { ProductStore } from './product-store.js'
import {
  modelProfileSchema,
  requirementVersionSchema,
  teamVersionSchema,
} from './product-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

export type ProductCommand = Extract<
  BusinessCommand,
  { type: 'model.save' | 'requirement.save' | 'team.save' }
>

export const isProductCommand = (
  command: BusinessCommand,
): command is ProductCommand =>
  command.type === 'model.save' ||
  command.type === 'requirement.save' ||
  command.type === 'team.save'

/** 仅做领域验证和数据库追加，副作用与凭据兑换不在此事务中进行。 */
export const saveProductObject = (input: {
  store: WorkspaceStore
  command: ProductCommand
}): { id: string } => {
  const { command, store } = input
  if (!command.id && command.expectedVersion !== 0)
    throw new Error('VERSION_CONFLICT')
  const id = command.id ?? randomUUID()
  const { type, expectedVersion, ...fields } = command

  const value = {
    ...fields,
    id,
    version: expectedVersion + 1,
    createdAt: new Date().toISOString(),
  }

  const products = new ProductStore(store)
  switch (command.type) {
    case 'model.save':
      validateModel(command)
      products.append(
        'model_profiles',
        modelProfileSchema.parse(value),
        'model.saved',
      )
      break
    case 'requirement.save':
      validateRequirement({ store, products, command })
      products.append(
        'requirement_versions',
        requirementVersionSchema.parse(value),
        'requirement.saved',
      )
      break
    case 'team.save':
      validateTeam(store, command)
      products.append(
        'team_versions',
        teamVersionSchema.parse(value),
        'team.saved',
      )
      break
  }
  return { id }
}

const validateModel = (
  command: Extract<ProductCommand, { type: 'model.save' }>,
) => {
  if (command.provider === 'cli-managed') {
    if (command.baseUrl || command.credentialRef)
      throw new Error('MODEL_CONFIG_INVALID')
    return
  }

  const provider =
    command.cli === 'codex' ? 'openai-compatible' : 'anthropic-compatible'

  if (command.provider !== provider) throw new Error('MODEL_CONFIG_INVALID')
  if (!command.model) throw new Error('MODEL_CONFIG_INVALID')
  normalizeProviderUrl(command.baseUrl)
}

const validateRequirement = (input: {
  store: WorkspaceStore
  products: ProductStore
  command: Extract<ProductCommand, { type: 'requirement.save' }>
}) => {
  const { command, products, store } = input
  store.get('projects', command.projectId, projectSchema)
  if (!command.id) return

  const previous = products.get(
    'requirement_versions',
    { id: command.id },
    requirementVersionSchema,
  )

  if (previous.projectId !== command.projectId)
    throw new Error('CROSS_PROJECT_REFERENCE')
}

const validateTeam = (
  store: WorkspaceStore,
  command: Extract<ProductCommand, { type: 'team.save' }>,
) => {
  if (
    new Set(command.roleIds).size !== command.roleIds.length ||
    !command.roleIds.includes(command.coordinatorRoleId)
  )
    throw new Error('TEAM_CONFIG_INVALID')
  for (const id of command.roleIds)
    store.get('role_versions', id, roleVersionSchema)
}
