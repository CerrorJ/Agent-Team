import { createHash, randomUUID } from 'node:crypto'
import type { CliRunResult } from '../cli/types.js'
import { runSchema, type Run } from './business-contracts.js'
import {
  humanPayloadSchema,
  type HumanPayload,
  type HumanRequest,
} from './human-contracts.js'
import { HumanStore } from './human-store.js'
import type { WorkspaceStore } from './workspace-store.js'
import { assertExecutionTransition } from '../domain/run-state.js'

/** CLI 进程已确认结束才发布可处理请求；停止失败仍走 STATE_UNCERTAIN，不允许提前批准。 */
export const pauseForHuman = (input: {
  store: WorkspaceStore
  runId: string
  result: CliRunResult
}): boolean => {
  const payload = input.result.humanRequest ?? findHumanPayload(input.result)
  if (!payload) return false
  const { store } = input
  const run = store.get('runs', input.runId, runSchema)
  if (run.status === 'stopping') return false
  if (run.purpose === 'role_trial') throw new Error('TASK_NOT_EXECUTABLE')

  const segment = store.database
    .prepare(
      'SELECT id,session_id FROM execution_segments WHERE run_id=? ORDER BY rowid DESC LIMIT 1',
    )
    .get(run.id)

  const sessionId = input.result.sessionId ?? segment?.session_id
  if (!segment || typeof sessionId !== 'string' || !sessionId)
    throw new Error('HUMAN_SESSION_REQUIRED')
  const request = createRequest(run, String(segment.id), payload)
  store.transaction(() => {
    const status =
      payload.kind === 'clarification' ? 'waiting_input' : 'waiting_approval'

    assertExecutionTransition(run.status, status)
    store.database
      .prepare(
        "UPDATE execution_segments SET ended_at=?,status='ended',session_id=? WHERE id=?",
      )
      .run(new Date().toISOString(), sessionId, String(segment.id))
    new HumanStore(store).add(request)
    store.updateRun({
      ...run,
      version: run.version + 1,
      status,
      processState: 'confirmed_ended',
      pendingHumanRequestId: request.id,
      continuation: null,
    })
  })
  return true
}

const createRequest = (
  run: Run,
  segmentId: string,
  payload: HumanPayload,
): HumanRequest => {
  const timeout =
    payload.kind === 'operation'
      ? (payload.request.timeoutSeconds ?? 300)
      : 86400

  return {
    id: randomUUID(),
    version: 1,
    runId: run.id,
    taskId: run.taskId,
    projectId: run.projectId,
    segmentId,
    payload,
    digest: createHash('sha256')
      .update(JSON.stringify({ runId: run.id, segmentId, payload }))
      .digest('hex'),
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeout * 1000).toISOString(),
    decidedAt: null,
    decision: null,
    actor: null,
    resolutionReason: null,
  }
}

const findHumanPayload = (result: CliRunResult): HumanPayload | undefined => {
  for (const call of result.toolCalls ?? []) {
    const name = call.toolName.replace(/^mcp__agent_team__/, '')
    if (name === 'request_clarification')
      return humanPayloadSchema.parse({
        kind: 'clarification',
        request: call.input,
      })
    if (name === 'request_approval')
      return humanPayloadSchema.parse({
        kind: 'operation',
        request: call.input,
      })
    if (
      name === 'request_plan_review' &&
      typeof call.input === 'object' &&
      call.input
    )
      return humanPayloadSchema.parse({ ...call.input, kind: 'plan' })
  }
  return undefined
}
