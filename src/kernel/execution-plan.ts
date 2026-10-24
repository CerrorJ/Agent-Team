import { createHash } from 'node:crypto'
import {
  projectSchema,
  runSchema,
  type BusinessCommand,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { PreflightInput } from './preflight-contracts.js'
import {
  taskForStart,
  teamForStart,
  assertTaskCanStart,
} from './execution-eligibility.js'
import { captureBusinessConfiguration } from './run-snapshots.js'
import { retryFeedback } from './run-feedback.js'
import { inspectProjectExecution } from './git-workspace.js'

type RepositoryState = ReturnType<typeof inspectProjectExecution>

export type ExecutionStartCommand = Extract<
  BusinessCommand,
  { type: 'run.start' | 'run.retry' | 'team.start' }
>

export const preflightCommand = (
  input: PreflightInput,
): ExecutionStartCommand => {
  const expectedVersion = input.expectedVersion
  if (input.operation === 'retry')
    return { type: 'run.retry', runId: input.id, expectedVersion }
  return {
    type: input.operation === 'team' ? 'team.start' : 'run.start',
    taskId: input.id,
    expectedVersion,
  }
}

/** 捕获实际启动会使用的固定配置；无随机 Run、试运行挑战、工作目录或数据库写入。 */
export const executionPlan = (
  store: WorkspaceStore,
  command: ExecutionStartCommand,
  inspectedRepository?: RepositoryState,
) => {
  const tasks =
    command.type === 'team.start'
      ? teamForStart(store, command).children
      : [taskForStart(store, command)]

  const project = store.get('projects', tasks[0]!.projectId, projectSchema)
  const repository = inspectedRepository ?? inspectProjectExecution(project)
  const { baselineCommit } = repository
  const runs = store.list('runs', runSchema)

  const configurations = tasks.map((task) => {
    assertTaskCanStart(store, task)
    return {
      task,
      ...captureBusinessConfiguration(store, task),
      feedbackSnapshot: retryFeedback(
        store,
        runs.filter((run) => run.taskId === task.id).at(-1),
      ),
    }
  })

  const intent =
    command.type === 'run.retry'
      ? {
          type: command.type,
          id: command.runId,
          expectedVersion: command.expectedVersion,
        }
      : {
          type: command.type,
          id: command.taskId,
          expectedVersion: command.expectedVersion,
        }

  const configurationFingerprint = createHash('sha256')
    .update(JSON.stringify({ intent, project, repository, configurations }))
    .digest('hex')

  return {
    project,
    repository,
    baselineCommit,
    configurations,
    configurationFingerprint,
  }
}

/** 事务内只重读业务配置；Git在prepare阶段检查，准备worktree时仍须重新核对。 */
export const assertExecutionFingerprint = (
  store: WorkspaceStore,
  command: ExecutionStartCommand,
  inspectedRepository?: RepositoryState,
): void => {
  if (!command.expectedConfigurationFingerprint) return
  if (!inspectedRepository) throw new Error('PREFLIGHT_CHANGED')
  try {
    if (
      executionPlan(store, command, inspectedRepository)
        .configurationFingerprint === command.expectedConfigurationFingerprint
    )
      return
  } catch {
    // 旧预览失效时先要求重新检查；新预检会给出当前准确的阻塞原因。
  }
  throw new Error('PREFLIGHT_CHANGED')
}
