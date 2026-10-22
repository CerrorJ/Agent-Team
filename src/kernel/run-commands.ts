import { randomUUID } from 'node:crypto'
import {
  assertRetryableExecution,
  assertExecutionTransition,
} from '../domain/run-state.js'
import {
  projectSchema,
  runSchema,
  taskSchema,
  deliverySchema,
  acceptanceSchema,
  type BusinessCommand,
  type Run,
  type Task,
} from './business-contracts.js'
import { projectBaseline, runWorkDirectory } from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'
import { captureTaskConfiguration } from './run-snapshots.js'
import { assertRoleCanExecute } from './role-execution-guard.js'
import { finishRoleTrial } from './role-trial-state.js'
import { stopWaitingRun } from './human-stop.js'

export type RunCommand = Extract<
  BusinessCommand,
  { type: 'run.start' | 'run.retry' | 'run.stop' }
>

export const prepareRunCommand = (input: {
  store: WorkspaceStore
  command: RunCommand
  dataDirectory: string
}): (() => { id: string }) => {
  const { store, command } = input
  if (command.type === 'run.stop') return () => stopRun(store, command)
  const task = taskForStart(store, command)
  const project = store.get('projects', task.projectId, projectSchema)
  const baselineCommit = projectBaseline(project)
  return () =>
    createTaskRun({
      store,
      task,
      baselineCommit,
      dataDirectory: input.dataDirectory,
    })
}

const taskForStart = (
  store: WorkspaceStore,
  command: Exclude<RunCommand, { type: 'run.stop' }>,
): Task => {
  if (command.type === 'run.start') {
    const task = store.get('tasks', command.taskId, taskSchema)
    assertTeamStarted(store, task)
    if (task.purpose === 'role_trial' || task.purpose === 'team_parent')
      throw new Error('TASK_NOT_EXECUTABLE')
    if (task.version !== command.expectedVersion)
      throw new Error('VERSION_CONFLICT: 任务已改变')
    return task
  }
  const run = store.get('runs', command.runId, runSchema)
  if (run.purpose === 'role_trial') throw new Error('TASK_NOT_EXECUTABLE')
  if (run.version !== command.expectedVersion)
    throw new Error('VERSION_CONFLICT: 执行已改变')
  assertRetryableExecution({
    state: run.status,
    processState: run.processState,
  })

  const latest = store
    .list('runs', runSchema)
    .filter((item) => item.taskId === run.taskId)
    .at(-1)

  if (latest?.id !== run.id) throw new Error('STALE_RUN: 请从最新一次执行重试')
  return store.get('tasks', run.taskId, taskSchema)
}

const assertTeamStarted = (store: WorkspaceStore, task: Task): void => {
  if (
    task.parentTaskId &&
    store.get('tasks', task.parentTaskId, taskSchema).status === 'ready'
  )
    throw new Error('TEAM_NOT_STARTED')
}

export const createTaskRun = (input: {
  store: WorkspaceStore
  task: Task
  baselineCommit: string
  dataDirectory: string
}) => {
  const { store, task } = input
  assertTaskCanStart(store, task)

  const previous = store
    .list('runs', runSchema)
    .filter((run) => run.taskId === task.id)

  const id = randomUUID()

  const run: Run = {
    id,
    version: 1,
    taskId: task.id,
    projectId: task.projectId,
    attempt: previous.length + 1,
    retryOfRunId: previous.at(-1)?.id ?? null,
    status: 'queued',
    ...captureTaskConfiguration(store, task, id),
    baselineCommit: input.baselineCommit,
    feedbackSnapshot: retryFeedback(store, previous.at(-1)),
    executionBranch: `weftpilot/run-${id}`,
    workDirectory: runWorkDirectory({
      dataDirectory: input.dataDirectory,
      runId: id,
    }),
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    processState: 'not_started',
    failureCode: null,
  }

  store.addRun(run)
  store.updateTask({
    ...task,
    status: 'in_progress',
    version: task.version + 1,
  })
  return { id }
}

const retryFeedback = (
  store: WorkspaceStore,
  previous: Run | undefined,
): string => {
  if (!previous) return ''

  const delivery = store
    .list('deliveries', deliverySchema)
    .find((item) => item.runId === previous.id)

  const acceptance =
    delivery &&
    store
      .list('acceptances', acceptanceSchema)
      .find((item) => item.deliveryId === delivery.id)

  return acceptance?.reason || previous.feedbackSnapshot
}

const assertTaskCanStart = (store: WorkspaceStore, task: Task): void => {
  if (task.status !== 'ready')
    throw new Error('TASK_NOT_READY: 任务尚不可执行；请先验收或退回交付')
  if (task.purpose !== 'role_trial') assertRoleCanExecute(store, task.roleId)

  const uncertain = store
    .list('runs', runSchema)
    .some(
      (run) =>
        run.projectId === task.projectId && run.processState === 'uncertain',
    )

  if (uncertain) throw new Error('STATE_UNCERTAIN: 项目存在状态待确认的旧执行')
}

const stopRun = (
  store: WorkspaceStore,
  command: Extract<RunCommand, { type: 'run.stop' }>,
) => {
  const run = store.get('runs', command.runId, runSchema)
  if (run.version !== command.expectedVersion)
    throw new Error('VERSION_CONFLICT: 执行已改变')
  if (run.processState === 'uncertain') throw new Error('STATE_UNCERTAIN')
  if (['waiting_input', 'waiting_approval'].includes(run.status)) {
    stopWaitingRun(store, run)
    return { id: run.id }
  }
  const status = run.status === 'queued' ? 'cancelled' : 'stopping'
  assertExecutionTransition(run.status, status)
  store.updateRun({
    ...run,
    status,
    version: run.version + 1,
    endedAt: status === 'cancelled' ? new Date().toISOString() : null,
    processState: status === 'cancelled' ? 'confirmed_ended' : run.processState,
  })
  if (status === 'cancelled') {
    finishRoleTrial(store, run, false)
    const task = store.get('tasks', run.taskId, taskSchema)
    store.updateTask({ ...task, version: task.version + 1, status: 'ready' })
  }
  return { id: run.id }
}
