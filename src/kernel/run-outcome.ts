import { randomUUID } from 'node:crypto'
import { assertExecutionTransition } from '../domain/run-state.js'
import type { CliRunResult } from '../cli/types.js'
import {
  runSchema,
  taskSchema,
  type RunStatus,
  type Run,
} from './business-contracts.js'
import { collectRunDelivery } from './git-workspace.js'
import type { WorkspaceStore } from './workspace-store.js'

export const finishRun = (input: {
  store: WorkspaceStore
  runId: string
  result?: CliRunResult
  failureCode?: string
}): void => {
  const current = input.store.get('runs', input.runId, runSchema)
  if (input.failureCode === 'STATE_UNCERTAIN') {
    markUncertain(input.store, current)
    return
  }
  const stopped = current.status === 'stopping'

  const delivery =
    input.result && !stopped ? collectRunDelivery(current) : undefined

  input.store.transaction(() => {
    input.store.database
      .prepare(
        "UPDATE execution_segments SET ended_at=?,status='ended' WHERE run_id=?",
      )
      .run(new Date().toISOString(), current.id)
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
      failureCode: stopped ? null : (input.failureCode ?? null),
    })
    const task = input.store.get('tasks', run.taskId, taskSchema)
    input.store.updateTask({
      ...task,
      version: task.version + 1,
      status: status === 'succeeded' ? 'in_review' : 'ready',
    })
    if (status === 'succeeded' && delivery && input.result)
      saveDelivery({ store: input.store, run, result: input.result, delivery })
  })
}

const saveDelivery = (input: {
  store: WorkspaceStore
  run: Run
  result: CliRunResult
  delivery: ReturnType<typeof collectRunDelivery>
}): void => {
  input.store.addDelivery({
    id: randomUUID(),
    version: input.run.attempt,
    runId: input.run.id,
    taskId: input.run.taskId,
    answer: input.result.answer.slice(0, 200_000),
    ...input.delivery,
    createdAt: new Date().toISOString(),
  })
}

const markUncertain = (store: WorkspaceStore, run: Run): void => {
  store.transaction(() =>
    store.updateRun({
      ...run,
      version: run.version + 1,
      processState: 'uncertain',
      failureCode: 'STATE_UNCERTAIN',
    }),
  )
}
