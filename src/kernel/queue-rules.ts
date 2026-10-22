import { runSchema, taskSchema, type Run } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 固定两槽、每角色一槽、每项目一位写者；未知进程仅封锁所属项目。 */
export const queueBlocker = (input: {
  store: WorkspaceStore
  run: Run
  reservedIds?: Set<string>
}): Run['waitingReason'] => {
  const { store, run, reservedIds } = input
  const runs = store.list('runs', runSchema)
  if (
    runs.some(
      (item) =>
        item.projectId === run.projectId && item.processState === 'uncertain',
    )
  )
    return 'uncertain_project'
  const task = store.get('tasks', run.taskId, taskSchema)
  if (
    task.dependencyTaskIds?.some(
      (id) => store.get('tasks', id, taskSchema).status !== 'done',
    )
  )
    return 'dependency_acceptance'

  const active = runs.filter(
    (item) =>
      item.id !== run.id &&
      (reservedIds?.has(item.id) ||
        ['preparing', 'running', 'stopping'].includes(item.status)),
  )

  if (active.some((item) => item.projectId === run.projectId))
    return 'project_busy'
  if (active.some((item) => item.roleSnapshot.id === run.roleSnapshot.id))
    return 'role_busy'
  return active.length >= 2 ? 'capacity' : undefined
}

export const projectQueue = (store: WorkspaceStore): Run[] =>
  store
    .list('runs', runSchema)
    .map((run) =>
      run.status === 'queued'
        ? { ...run, waitingReason: queueBlocker({ store, run }) }
        : run,
    )
