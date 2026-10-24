import { assertRetryableExecution } from '../domain/run-state.js'
import {
  runSchema,
  taskSchema,
  type BusinessCommand,
  type Task,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import { assertRoleCanExecute } from './role-execution-guard.js'

export type TaskStartCommand = Extract<
  BusinessCommand,
  { type: 'run.start' | 'run.retry' }
>

/** 预检与真正启动共用关系/版本检查；重试只能指向最新Run，不能续接旧审批。 */
export const taskForStart = (
  store: WorkspaceStore,
  command: TaskStartCommand,
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

/** 只读检查不能更改任务或“修复”未知进程；实际命令仍在写事务中再次执行这些规则。 */
export const assertTaskCanStart = (store: WorkspaceStore, task: Task): void => {
  if (task.status !== 'ready')
    throw new Error('TASK_NOT_READY: 任务尚不可执行；请先验收或退回交付')
  if (task.purpose !== 'role_trial') assertRoleCanExecute(store, task.roleId)
  if (
    store
      .list('runs', runSchema)
      .some(
        (run) =>
          run.projectId === task.projectId && run.processState === 'uncertain',
      )
  )
    throw new Error('STATE_UNCERTAIN: 项目存在状态待确认的旧执行')
}

export const teamForStart = (
  store: WorkspaceStore,
  input: { taskId: string; expectedVersion: number },
) => {
  const parent = store.get('tasks', input.taskId, taskSchema)
  if (parent.purpose !== 'team_parent') throw new Error('TASK_NOT_TEAM')
  if (parent.version !== input.expectedVersion)
    throw new Error('VERSION_CONFLICT')
  if (parent.status !== 'ready') throw new Error('TASK_NOT_READY')

  const children = store
    .list('tasks', taskSchema)
    .filter((task) => task.parentTaskId === parent.id)

  if (!children.length) throw new Error('TEAM_PLAN_INVALID')
  return { parent, children }
}
