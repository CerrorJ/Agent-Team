import { randomUUID } from 'node:crypto'
import {
  projectSchema,
  taskSchema,
  type BusinessCommand,
  type Task,
} from './business-contracts.js'
import { teamVersionSchema } from './product-contracts.js'
import { ProductStore } from './product-store.js'
import { projectBaseline, inspectProjectExecution } from './git-workspace.js'
import { createTaskRun } from './run-commands.js'
import { teamForStart } from './execution-eligibility.js'
import { assertExecutionFingerprint } from './execution-plan.js'
import type { WorkspaceStore } from './workspace-store.js'

type TeamCommand = Extract<
  BusinessCommand,
  { type: 'team.createTask' | 'team.start' }
>
type Plan = Extract<TeamCommand, { type: 'team.createTask' }>

export const isTeamCommand = (
  command: BusinessCommand,
): command is TeamCommand =>
  command.type === 'team.createTask' || command.type === 'team.start'

/** 整个子任务 DAG 与团队快照同一事务落库；不以部分创建结果充当团队任务。 */
export const prepareTeamCommand = (input: {
  store: WorkspaceStore
  command: TeamCommand
  dataDirectory: string
}): (() => { id: string }) => {
  const { store, command } = input
  if (command.type === 'team.createTask')
    return () => createTeamTask(store, command)
  const { parent } = teamForStart(store, command)

  const project = store.get('projects', parent.projectId, projectSchema)

  const repository = command.expectedConfigurationFingerprint
    ? inspectProjectExecution(project)
    : undefined

  const baselineCommit = repository?.baselineCommit ?? projectBaseline(project)

  return () => {
    assertExecutionFingerprint(store, command, repository)
    const { children } = teamForStart(store, command)
    for (const task of children)
      createTaskRun({
        store,
        task,
        baselineCommit,
        dataDirectory: input.dataDirectory,
      })
    store.updateTask({
      ...parent,
      status: 'in_progress',
      version: parent.version + 1,
    })
    return { id: parent.id }
  }
}

const createTeamTask = (
  store: WorkspaceStore,
  command: Plan,
): { id: string } => {
  const team = new ProductStore(store).get(
    'team_versions',
    { id: command.teamId },
    teamVersionSchema,
  )

  if (team.version !== command.expectedTeamVersion)
    throw new Error('VERSION_CONFLICT')
  const project = store.get('projects', command.projectId, projectSchema)

  if (
    command.expectedProjectVersion !== undefined &&
    project.version !== command.expectedProjectVersion
  )
    throw new Error('VERSION_CONFLICT')
  validatePlan(command, team.roleIds)

  const parent: Task = {
    id: randomUUID(),
    version: 1,
    projectId: command.projectId,
    roleId: team.coordinatorRoleId,
    title: command.title,
    goal: command.goal,
    acceptanceCriteria: command.acceptanceCriteria,
    purpose: 'team_parent',
    teamSnapshot: team,
    status: 'ready',
    createdAt: new Date().toISOString(),
  }

  store.addTask(parent)
  const ids = new Map(command.steps.map((step) => [step.key, randomUUID()]))
  for (const step of command.steps)
    store.addTask({
      id: ids.get(step.key)!,
      version: 1,
      projectId: parent.projectId,
      roleId: step.roleId,
      title: step.title,
      goal: step.goal,
      acceptanceCriteria: step.acceptanceCriteria,
      parentTaskId: parent.id,
      dependencyTaskIds: step.dependsOn.map((key) => ids.get(key)!),
      purpose: 'task',
      status: 'ready',
      createdAt: parent.createdAt,
    })
  return { id: parent.id }
}

const validatePlan = (command: Plan, roleIds: string[]): void => {
  const remaining = new Map(
    command.steps.map((step) => [step.key, step.dependsOn]),
  )

  if (remaining.size !== command.steps.length)
    throw new Error('TEAM_PLAN_INVALID')
  for (const step of command.steps) {
    if (
      !roleIds.includes(step.roleId) ||
      new Set(step.dependsOn).size !== step.dependsOn.length
    )
      throw new Error('TEAM_PLAN_INVALID')
    if (step.dependsOn.some((key) => !remaining.has(key)))
      throw new Error('TEAM_PLAN_INVALID')
  }
  // 拓扑删除同时拒绝环和自依赖，不依赖 UI 顺序或递归深度。
  const completed = new Set<string>()
  while (remaining.size) {
    const ready = [...remaining].find(([, dependencies]) =>
      dependencies.every((key) => completed.has(key)),
    )

    if (!ready) throw new Error('TEAM_DEPENDENCY_CYCLE')
    completed.add(ready[0])
    remaining.delete(ready[0])
  }
}
