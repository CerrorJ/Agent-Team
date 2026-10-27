import { randomUUID } from 'node:crypto'
import { projectSchema, type BusinessCommand } from './business-contracts.js'
import { ProductStore } from './product-store.js'
import { teamVersionSchema } from './product-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

type CreateCommand = Extract<BusinessCommand, { type: 'project.create' }>
type ConfigureCommand = Extract<BusinessCommand, { type: 'project.configure' }>

const assertTeam = (store: WorkspaceStore, teamId?: string | null): void => {
  if (teamId)
    new ProductStore(store).get(
      'team_versions',
      { id: teamId },
      teamVersionSchema,
    )
}

/** 在命令事务内创建全部配置，避免先建项目再配置导致半成品。 */
export const registerProject = (input: {
  store: WorkspaceStore
  command: CreateCommand
  inspected: { repositoryPath: string; gitUrl: string }
}): { id: string } => {
  const { store, command, inspected } = input

  assertTeam(store, command.defaultTeamId)
  const id = randomUUID()
  const { type: _type, ...fields } = command

  store.addProject(
    projectSchema.parse({
      ...fields,
      id,
      version: 1,
      repositoryPath: inspected.repositoryPath,
      gitUrl: inspected.gitUrl,
      createdAt: new Date().toISOString(),
    }),
  )
  return { id }
}

/** 元数据更新采用 CAS；项目、事件、通知、幂等回执由调用方同一事务提交。 */
export const configureProject = (
  store: WorkspaceStore,
  command: ConfigureCommand,
): { id: string } => {
  const project = store.get('projects', command.projectId, projectSchema)

  if (project.version !== command.expectedVersion)
    throw new Error('VERSION_CONFLICT')
  assertTeam(store, command.defaultTeamId)

  const updated = projectSchema.parse({
    ...project,
    name: command.name,
    goal: command.goal,
    description: command.description,
    defaultTeamId: command.defaultTeamId,
    version: project.version + 1,
  })

  const result = store.database
    .prepare(
      "UPDATE projects SET data=? WHERE id=? AND json_extract(data,'$.version')=?",
    )
    .run(JSON.stringify(updated), project.id, command.expectedVersion)

  if (result.changes !== 1) throw new Error('VERSION_CONFLICT')
  store.event('project.configured', updated)
  return { id: project.id }
}
