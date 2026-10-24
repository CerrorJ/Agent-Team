import { randomUUID } from 'node:crypto'
import { assertExecutionTransition } from '../domain/run-state.js'
import {
  projectSchema,
  runSchema,
  taskSchema,
  type BusinessCommand,
  type Run,
  type Task,
} from './business-contracts.js'
import {
  projectBaseline,
  runWorkDirectory,
  inspectProjectExecution,
} from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'
import { captureTaskConfiguration } from './run-snapshots.js'
import { assertTaskCanStart, taskForStart } from './execution-eligibility.js'
import { retryFeedback } from './run-feedback.js'
import { assertExecutionFingerprint } from './execution-plan.js'
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

  const repository = command.expectedConfigurationFingerprint
    ? inspectProjectExecution(project)
    : undefined

  const baselineCommit = repository?.baselineCommit ?? projectBaseline(project)
  return () => {
    assertExecutionFingerprint(store, command, repository)
    return createTaskRun({
      store,
      task,
      baselineCommit,
      dataDirectory: input.dataDirectory,
    })
  }
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
