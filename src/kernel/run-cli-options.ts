import type { RunCliOptions } from '../cli/runner.js'
import type { ProcessStopReport } from '../cli/process-stop.js'
import type { CliEvent } from '../cli/types.js'
import { runSchema, type Run } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { executionModel } from './model-runtime.js'
import { executionPrompt } from './role-trial-files.js'
import { runInputContext } from './run-inputs.js'

/** 每段使用固定Run快照，进程证据只写入当前段，不回写已结束的历史段。 */
export const buildRunCliOptions = (input: {
  store: WorkspaceStore
  run: Run
  controller: AbortController
  segmentId: string
  runtime: Awaited<ReturnType<typeof executionModel>>
}): RunCliOptions => {
  const { store, run, controller, segmentId, runtime } = input
  const runId = run.id
  return {
    ...runtime,
    cwd: run.workDirectory,
    signal: controller.signal,
    timeoutMs: 30 * 60_000,
    prompt:
      run.continuation?.prompt ??
      executionPrompt(run) + runInputContext(store, run),
    ...(run.continuation ? { sessionId: run.continuation.sessionId } : {}),
    stopToolNames: [
      'request_clarification',
      'request_approval',
      'request_plan_review',
      'mcp__agent_team__request_clarification',
      'mcp__agent_team__request_approval',
      'mcp__agent_team__request_plan_review',
    ],
    onEvent: (event) => recordActivity({ store, runId, event, controller }),
    onProcessStart: (pid) =>
      recordProcess({ store, segmentId, pid, controller }),
    onProcessStop: (report) => recordStop({ store, runId, controller, report }),
  }
}

const recordProcess = (input: {
  store: WorkspaceStore
  segmentId: string
  pid: number
  controller: AbortController
}): void => {
  try {
    input.store.database
      .prepare(
        "UPDATE execution_segments SET pid=?,started_at=?,status='running' WHERE id=?",
      )
      .run(input.pid, new Date().toISOString(), input.segmentId)
  } catch {
    input.controller.abort()
  }
}

const recordActivity = (input: {
  store: WorkspaceStore
  runId: string
  event: CliEvent
  controller: AbortController
}): void => {
  try {
    const run = input.store.get('runs', input.runId, runSchema)

    const total = Number(
      input.store.database
        .prepare(
          "SELECT COUNT(*) AS total FROM workspace_events WHERE aggregate_id=? AND type='run.activity'",
        )
        .get(run.id)?.total,
    )

    if (total > 500) return
    if (input.event.type === 'session')
      input.store.database
        .prepare(
          'UPDATE execution_segments SET session_id=? WHERE run_id=? AND ended_at IS NULL',
        )
        .run(input.event.sessionId, run.id)

    // 只保存归一化类型与工具名称，不持久化工具参数、原始 stderr 或用户内容。
    const label =
      total === 500
        ? '日志已达到保留上限'
        : input.event.type === 'tool_start'
          ? input.event.toolName
          : input.event.type

    input.store.transaction(() =>
      input.store.event('run.activity', {
        id: run.id,
        version: run.version,
        label,
      }),
    )
  } catch {
    input.controller.abort()
  }
}

const recordStop = (input: {
  store: WorkspaceStore
  runId: string
  controller: AbortController
  report: ProcessStopReport
}): void => {
  const { store, runId, report, controller } = input
  try {
    const run = store.get('runs', runId, runSchema)
    store.transaction(() =>
      store.event('run.activity', {
        id: runId,
        version: run.version,
        label: `process_stop:${report.outcome}:${report.exitCode ?? report.errorCode ?? 'none'}:${report.durationMs}ms`,
      }),
    )
  } catch {
    controller.abort()
  }
}
