import { assertExecutionTransition } from '../domain/run-state.js'
import {
  runSchema,
  taskSchema,
  type BusinessCommand,
  type Run,
} from './business-contracts.js'
import { HumanStore } from './human-store.js'
import type { HumanActor, HumanRequest } from './human-contracts.js'
import {
  assertHumanDecision,
  decidedRequest,
  continuationPrompt,
} from './human-decisions.js'
import type { WorkspaceStore } from './workspace-store.js'

type HumanCommand = Extract<BusinessCommand, { type: 'human.resolve' }>

/** 同一 CommandLedger 事务中裁决；渠道不拥有另一套决定状态。身份由可信宿主注入。 */
export const resolveHumanRequest = (input: {
  store: WorkspaceStore
  command: HumanCommand
  actor: HumanActor
}): { id: string } => {
  const { store, command } = input
  const humans = new HumanStore(store)
  const request = humans.get(command.requestId)
  assertRequestCurrent(request, command)
  const run = currentWaitingRun(store, request)
  assertHumanDecision(request, command.response)

  const decided = decidedRequest({
    request,
    response: command.response,
    actor: input.actor,
  })

  humans.update(decided)
  if (command.response.decision === 'rejected') {
    failWaitingRun(store, run, 'HUMAN_REQUEST_REJECTED')
    return { id: request.id }
  }

  const segment = store.database
    .prepare('SELECT session_id FROM execution_segments WHERE id=?')
    .get(request.segmentId)

  if (typeof segment?.session_id !== 'string' || !segment.session_id)
    throw new Error('HUMAN_SESSION_REQUIRED')
  assertExecutionTransition(run.status, 'queued')
  store.updateRun({
    ...run,
    version: run.version + 1,
    status: 'queued',
    processState: 'not_started',
    pendingHumanRequestId: null,
    continuation: {
      requestId: request.id,
      sessionId: segment.session_id,
      prompt: continuationPrompt(decided),
    },
  })
  return { id: request.id }
}

const assertRequestCurrent = (
  request: HumanRequest,
  command: HumanCommand,
): void => {
  if (
    request.status === 'expired' ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    throw new Error('HUMAN_REQUEST_EXPIRED')
  if (request.status !== 'pending') throw new Error('HUMAN_REQUEST_NOT_PENDING')
  if (
    request.version !== command.expectedVersion ||
    request.digest !== command.expectedDigest
  )
    throw new Error('VERSION_CONFLICT')
}

export const currentWaitingRun = (
  store: WorkspaceStore,
  request: HumanRequest,
): Run => {
  const run = store.get('runs', request.runId, runSchema)
  if (run.taskId !== request.taskId || run.projectId !== request.projectId)
    throw new Error('STALE_HUMAN_REQUEST')
  if (
    run.pendingHumanRequestId !== request.id ||
    !['waiting_input', 'waiting_approval'].includes(run.status)
  )
    throw new Error('STALE_HUMAN_REQUEST')
  if (run.processState !== 'confirmed_ended') throw new Error('STATE_UNCERTAIN')
  return run
}

export const failWaitingRun = (
  store: WorkspaceStore,
  run: Run,
  failureCode: string,
): void => {
  assertExecutionTransition(run.status, 'failed')
  store.updateRun({
    ...run,
    version: run.version + 1,
    status: 'failed',
    failureCode,
    endedAt: new Date().toISOString(),
    pendingHumanRequestId: null,
    continuation: null,
  })
  const task = store.get('tasks', run.taskId, taskSchema)
  store.updateTask({ ...task, version: task.version + 1, status: 'ready' })
}
