import { randomUUID } from 'node:crypto'
import { configureProject, registerProject } from './project-settings.js'
import {
  projectSchema,
  roleVersionSchema,
  type BusinessCommand,
  type RoleVersion,
  type Task,
} from './business-contracts.js'
import { inspectProjectRepository } from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'
import { ProductStore } from './product-store.js'
import { RoleReadinessStore } from './role-readiness-store.js'
import { SkillStore } from './skill-store.js'
import { resolveRoleConfiguration } from './role-configuration.js'
import { copyRole } from './role-copy.js'
import { resolveRoleFeishu } from './role-feishu-binding.js'
import {
  modelProfileSchema,
  requirementVersionSchema,
} from './product-contracts.js'

export type CatalogCommand = Extract<
  BusinessCommand,
  {
    type:
      | 'project.create'
      | 'project.configure'
      | 'role.save'
      | 'role.copy'
      | 'task.create'
  }
>

/** Git 只读预检在事务外完成；返回的闭包只执行本地业务写入。 */
export const prepareCatalogCommand = (input: {
  store: WorkspaceStore
  command: CatalogCommand
}): (() => { id: string }) => {
  const { command, store } = input
  switch (command.type) {
    case 'project.create': {
      const inspected = inspectProjectRepository(command)
      return () => registerProject({ store, command, inspected })
    }
    case 'project.configure':
      return () => configureProject(store, command)
    case 'role.save':
      return () => saveRole(store, command)
    case 'role.copy':
      return () => copyRole({ store, command })
    case 'task.create':
      return () => createTask(store, command)
  }
}

const saveRole = (
  store: WorkspaceStore,
  command: Extract<BusinessCommand, { type: 'role.save' }>,
) => {
  if (!command.id && command.expectedVersion !== 0)
    throw new Error('VERSION_CONFLICT: 新角色的预期版本必须为零')
  const id = command.id ?? randomUUID()
  const configuration = resolveRoleConfiguration({ store, command, id })

  const profile = resolveRoleModel(store, command)
  const skills = command.skills ?? []
  new SkillStore(store).resolve(skills)

  const role: RoleVersion = {
    ...configuration,
    ...resolveRoleFeishu({ store, command, id }),
    id,
    version: command.expectedVersion + 1,
    name: command.name,
    responsibility: command.responsibility,
    cli: command.cli,
    model: profile?.model ?? command.model,
    modelProfileSnapshot: profile,
    permission: command.permission,
    skills,
    createdAt: new Date().toISOString(),
  }

  store.addRole(role)
  new RoleReadinessStore(store).reset(role)
  return { id }
}

const resolveRoleModel = (
  store: WorkspaceStore,
  command: Extract<BusinessCommand, { type: 'role.save' }>,
) => {
  if (command.modelProfileId && command.modelProfileRef)
    throw new Error('MODEL_CONFIG_INVALID')

  // 新客户端提交表单中看到的确切版本；旧 ID 字段仅保留协议兼容。
  const reference =
    command.modelProfileRef ??
    (command.modelProfileId ? { id: command.modelProfileId } : null)

  const profile = reference
    ? new ProductStore(store).get(
        'model_profiles',
        reference,
        modelProfileSchema,
      )
    : null

  if (profile && profile.cli !== command.cli)
    throw new Error('CLI_MODEL_MISMATCH')

  return profile
}

const createTask = (
  store: WorkspaceStore,
  command: Extract<BusinessCommand, { type: 'task.create' }>,
) => {
  store.get('projects', command.projectId, projectSchema)
  store.get('role_versions', command.roleId, roleVersionSchema)
  if (command.requirementRef) {
    const requirement = new ProductStore(store).get(
      'requirement_versions',
      command.requirementRef,
      requirementVersionSchema,
    )

    if (requirement.projectId !== command.projectId)
      throw new Error('CROSS_PROJECT_REFERENCE')
  }

  const task: Task = {
    id: randomUUID(),
    version: 1,
    projectId: command.projectId,
    roleId: command.roleId,
    title: command.title,
    goal: command.goal,
    acceptanceCriteria: command.acceptanceCriteria,
    requirementRef: command.requirementRef ?? null,
    status: 'ready',
    createdAt: new Date().toISOString(),
  }

  store.addTask(task)
  return { id: task.id }
}
