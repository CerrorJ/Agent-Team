import { randomUUID } from 'node:crypto'
import {
  deliverySchema,
  runSchema,
  taskSchema,
  type BusinessCommand,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 验收针对确切交付；旧交付、旧任务版本和重复决定不能改变新执行。 */
export const acceptDelivery = (input: {
  store: WorkspaceStore
  command: Extract<BusinessCommand, { type: 'delivery.accept' }>
}): { id: string } => {
  const { store, command } = input
  const delivery = store.get('deliveries', command.deliveryId, deliverySchema)
  const task = store.get('tasks', delivery.taskId, taskSchema)
  if (task.version !== command.expectedTaskVersion)
    throw new Error('VERSION_CONFLICT: 任务已改变')
  if (task.status !== 'in_review')
    throw new Error('DELIVERY_NOT_PENDING: 当前任务没有等待验收的交付')

  const latest = store
    .list('runs', runSchema)
    .filter((run) => run.taskId === task.id)
    .at(-1)

  if (latest?.id !== delivery.runId || latest.status !== 'succeeded')
    throw new Error('STALE_DELIVERY: 旧交付不能改变新执行')
  if (command.decision === 'returned' && !command.reason)
    throw new Error('REASON_REQUIRED: 退回必须填写原因')
  const id = randomUUID()
  store.addAcceptance({
    id,
    deliveryId: delivery.id,
    taskId: task.id,
    decision: command.decision,
    reason: command.reason,
    actor: 'local-owner',
    createdAt: new Date().toISOString(),
  })
  store.updateTask({
    ...task,
    version: task.version + 1,
    status: command.decision === 'accepted' ? 'done' : 'ready',
  })
  return { id }
}
