import { randomUUID } from 'node:crypto'
import { assertExecutionTransition } from '../domain/run-state.js'
import type { CliRunResult } from '../cli/types.js'
import { runSchema, taskSchema, type RunStatus } from './business-contracts.js'
import { collectRunDelivery } from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'

export const finishRun = (input: {
  store: WorkspaceStore
  runId: string
  result?: CliRunResult
  failureCode?: string
}): void => {
  const current = input.store.get('runs', input.runId, runSchema)
  const stopped = current.status === 'stopping'

  const delivery =
    input.result && !stopped ? collectRunDelivery(current) : undefined

  input.store.transaction(() => {
    const run = input.store.get('runs', input.runId, runSchema)

    const status: RunStatus = stopped
      ? 'stopped'
      : input.result
        ? 'succeeded'
        : 'failed'

    assertExecutionTransition(run.status, status)
    input.store.updateRun({
      ...run,
      status,
      version: run.version + 1,
      endedAt: new Date().toISOString(),
      processState: 'confirmed_ended',
      failureCode: input.failureCode ?? null,
    })
    const task = input.store.get('tasks', run.taskId, taskSchema)
    input.store.updateTask({
      ...task,
      version: task.version + 1,
      status: status === 'succeeded' ? 'in_review' : 'ready',
    })
    if (status === 'succeeded' && delivery && input.result)
      input.store.addDelivery({
        id: randomUUID(),
        version: 1,
        runId: run.id,
        taskId: run.taskId,
        answer: input.result.answer.slice(0, 200_000),
        ...delivery,
        createdAt: new Date().toISOString(),
      })
  })
}
