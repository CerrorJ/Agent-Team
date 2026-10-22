import { randomUUID } from 'node:crypto'
import {
  projectSchema,
  roleVersionSchema,
  type BusinessCommand,
  type RoleVersion,
  type Task,
} from './business-contracts.js'
import { inspectProjectRepository } from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'

export type CatalogCommand = Extract<
  BusinessCommand,
  { type: 'project.create' | 'role.save' | 'task.create' }
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
      return () => {
        const id = randomUUID()
        store.addProject({
          id,
          version: 1,
          name: command.name,
          defaultBranch: command.defaultBranch,
          repositoryPath: inspected.repositoryPath,
          gitUrl: inspected.gitUrl,
          createdAt: new Date().toISOString(),
        })
        return { id }
      }
    }
    case 'role.save':
      return () => saveRole(store, command)
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

  const role: RoleVersion = {
    id,
    version: command.expectedVersion + 1,
    name: command.name,
    responsibility: command.responsibility,
    cli: command.cli,
    model: command.model,
    permission: command.permission,
    skills: [],
    createdAt: new Date().toISOString(),
  }

  store.addRole(role)
  return { id }
}

const createTask = (
  store: WorkspaceStore,
  command: Extract<BusinessCommand, { type: 'task.create' }>,
) => {
  store.get('projects', command.projectId, projectSchema)
  store.get('role_versions', command.roleId, roleVersionSchema)

  const task: Task = {
    id: randomUUID(),
    version: 1,
    projectId: command.projectId,
    roleId: command.roleId,
    title: command.title,
    goal: command.goal,
    acceptanceCriteria: command.acceptanceCriteria,
    status: 'ready',
    createdAt: new Date().toISOString(),
  }

  store.addTask(task)
  return { id: task.id }
}
