import {
  acceptanceSchema,
  deliverySchema,
  runSchema,
  taskSchema,
  type Run,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 排队时等待人工验收；转入准备时一次固定确切交付集合，之后不追随新的查询结果。 */
export const captureRunInputs = (store: WorkspaceStore, run: Run): string[] => {
  const task = store.get('tasks', run.taskId, taskSchema)
  const ids = new Set<string>()
  for (const id of task.dependencyTaskIds ?? []) {
    const delivery = acceptedTaskDelivery(store, run, id)
    for (const source of [...(delivery.inputDeliveryIds ?? []), delivery.id])
      ids.add(source)
  }
  if (ids.size > 12) throw new Error('TEAM_PLAN_INVALID')
  for (const id of ids) assertAcceptedInput(store, run, id)
  return [...ids]
}

const assertAcceptedInput = (
  store: WorkspaceStore,
  run: Run,
  id: string,
): void => {
  const delivery = store.get('deliveries', id, deliverySchema)
  const task = store.get('tasks', delivery.taskId, taskSchema)
  if (task.projectId !== run.projectId)
    throw new Error('DEPENDENCY_PROJECT_MISMATCH')
  if (
    !store
      .list('acceptances', acceptanceSchema)
      .some((item) => item.deliveryId === id && item.decision === 'accepted')
  )
    throw new Error('DEPENDENCY_NOT_ACCEPTED')
}

export const runInputPatches = (store: WorkspaceStore, run: Run): string[] =>
  (run.inputDeliveryIds ?? []).map((id) => {
    const delivery = store.get('deliveries', id, deliverySchema)
    return delivery.contributionDiff ?? delivery.diff
  })

export const runInputContext = (store: WorkspaceStore, run: Run): string => {
  const parts = (run.inputDeliveryIds ?? []).map((id) => {
    const delivery = store.get('deliveries', id, deliverySchema)
    const task = store.get('tasks', delivery.taskId, taskSchema)
    return `\n已验收上游交付 ${id}（${task.title} / v${delivery.version}）：\n${delivery.answer}`
  })

  const context = parts.join('\n')
  return context.length > 20_000
    ? context.slice(0, 20_000) +
        '\n上游说明已截断；代码贡献已应用到当前隔离目录。'
    : context
}

const acceptedTaskDelivery = (store: WorkspaceStore, run: Run, id: string) => {
  const dependency = store.get('tasks', id, taskSchema)
  if (dependency.projectId !== run.projectId || dependency.status !== 'done')
    throw new Error('DEPENDENCY_NOT_ACCEPTED')

  const latest = store
    .list('runs', runSchema)
    .filter((item) => item.taskId === id)
    .at(-1)

  const delivery = store
    .list('deliveries', deliverySchema)
    .find((item) => item.runId === latest?.id)

  if (!delivery || latest?.status !== 'succeeded')
    throw new Error('DEPENDENCY_NOT_ACCEPTED')
  return delivery
}
