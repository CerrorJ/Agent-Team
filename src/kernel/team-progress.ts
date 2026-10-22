import { taskSchema, type Task } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 父任务只在全部子任务获得人工验收后完成；执行成功本身不能完成团队任务。 */
export const refreshTeamProgress = (store: WorkspaceStore): void => {
  const tasks = store.list('tasks', taskSchema)
  for (const parent of tasks.filter((task) => task.purpose === 'team_parent')) {
    const children = tasks.filter((task) => task.parentTaskId === parent.id)
    const status = aggregateStatus(parent, children)
    if (status === parent.status) continue
    store.transaction(() =>
      store.updateTask({ ...parent, status, version: parent.version + 1 }),
    )
  }
}

const aggregateStatus = (parent: Task, children: Task[]): Task['status'] => {
  if (!children.length || parent.status === 'ready') return parent.status
  if (children.every((task) => task.status === 'done')) return 'done'
  return children.every((task) => ['done', 'in_review'].includes(task.status))
    ? 'in_review'
    : 'in_progress'
}
