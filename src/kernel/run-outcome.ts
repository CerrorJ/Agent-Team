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
import { trialSucceeded } from './role-trial-files.js'
import { finishRoleTrial } from './role-trial-state.js'
import type { WorkspaceStore } from './workspace-store.js'
import { pauseForHuman } from './human-pause.js'

interface RunOutcome {
  store: WorkspaceStore
  runId: string
  result?: CliRunResult
  failureCode?: string
}
interface PreparedOutcome extends RunOutcome {
  current: Run
  stopped: boolean
  delivery: ReturnType<typeof collectRunDelivery> | undefined
}

export const finishRun = (input: RunOutcome): void => {
  const current = input.store.get('runs', input.runId, runSchema)
  if (input.failureCode === 'STATE_UNCERTAIN') {
    markUncertain(input.store, current)
    return
  }
  if (
    input.result &&
    pauseForHuman({
      store: input.store,
      runId: input.runId,
      result: input.result,
    })
  )
    return
  const stopped = current.status === 'stopping'

  const effective =
    !stopped && input.result && !trialSucceeded(current, input.result.answer)
      ? {
          store: input.store,
          runId: input.runId,
          failureCode: 'ROLE_TRIAL_OUTPUT_INVALID',
        }
      : input

  const delivery =
    effective.result && !stopped ? collectRunDelivery(current) : undefined

  input.store.transaction(() =>
    persistOutcome({ ...effective, current, stopped, delivery }),
  )
}

const persistOutcome = (input: PreparedOutcome): void => {
  const { store, stopped, current, delivery } = input
  store.database
    .prepare(
      "UPDATE execution_segments SET ended_at=?,status='ended' WHERE run_id=? AND ended_at IS NULL",
    )
    .run(new Date().toISOString(), current.id)
  const run = store.get('runs', input.runId, runSchema)

  const status: RunStatus = stopped
    ? 'stopped'
    : input.result
      ? 'succeeded'
      : 'failed'

  assertExecutionTransition(run.status, status)
  store.updateRun({
    ...run,
    status,
    version: run.version + 1,
    endedAt: new Date().toISOString(),
    processState: 'confirmed_ended',
    failureCode: stopped ? null : (input.failureCode ?? null),
  })
  const task = store.get('tasks', run.taskId, taskSchema)
  const succeeded = status === 'succeeded'
  store.updateTask({
    ...task,
    version: task.version + 1,
    status: succeeded
      ? run.purpose === 'role_trial'
        ? 'done'
        : 'in_review'
      : 'ready',
  })
  finishRoleTrial(store, run, succeeded, input.failureCode)
  if (succeeded && delivery && input.result)
    saveDelivery({ store, run, result: input.result, delivery })
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
    answer: input.result.answer.slice(0, 200000),
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
