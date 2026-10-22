import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { executionModel } from './model-runtime.js'
import { prepareTrialInput, executionPrompt } from './role-trial-files.js'
import { runCli, type RunCliOptions } from '../cli/runner.js'
import type { ProcessStopReport } from '../cli/process-stop.js'
import type { CliEvent, CliRunResult } from '../cli/types.js'
import { projectSchema, runSchema, type Run } from './business-contracts.js'
import { prepareRunWorktree, applyRunInputPatches } from './git-workspace.js'
import {
  captureRunInputs,
  runInputContext,
  runInputPatches,
} from './run-inputs.js'
import { finishRun } from './run-outcome.js'
import type { WorkspaceStore } from './workspace-store.js'

export type CliExecutionPort = (options: RunCliOptions) => Promise<CliRunResult>

/** 执行准备意图先提交；Git 与 CLI 在事务外执行，结束证据返回后再落终态。 */
export const executeQueuedRun = async (
  input: {
    store: WorkspaceStore
    runId: string
    dataDirectory: string
    controller: AbortController
  },
  execute: CliExecutionPort = runCli,
): Promise<void> => {
  const { store, runId, controller } = input
  try {
    if (!prepareState(store, runId)) return
    let run = store.get('runs', runId, runSchema)
    const runtime = executionModel(run)
    const project = store.get('projects', run.projectId, projectSchema)
    prepareRunWorktree({ project, run, dataDirectory: input.dataDirectory })
    run = prepareInputs(store, run)
    prepareTrialInput(run)
    // M1 不加载项目自定义 CLI 扩展，避免外部 MCP/Hook 绕过既定工具权限。
    if (
      run.roleSnapshot.cli === 'codex' &&
      existsSync(join(run.workDirectory, '.codex/config.toml'))
    )
      throw new Error('CAPABILITY_UNSUPPORTED')
    controller.signal.throwIfAborted()
    markRunning(store, run)

    const result = await execute({
      ...runtime,
      cwd: run.workDirectory,
      signal: controller.signal,
      timeoutMs: 30 * 60_000,
      prompt: executionPrompt(run) + runInputContext(store, run),
      onEvent: (event) => recordActivity({ store, runId, event, controller }),
      onProcessStart: (pid) => recordProcess({ store, runId, pid, controller }),
      onProcessStop: (report) =>
        recordStop({ store, runId, controller, report }),
    })

    finishRun({ store, runId, result })
  } catch (error) {
    const failureCode =
      error instanceof Error
        ? (error.message.match(/^([A-Z][A-Z_]+)(?::|$)/)?.[1] ??
          'CLI_EXECUTION_FAILED')
        : 'CLI_EXECUTION_FAILED'

    finishRun({ store, runId, failureCode })
  }
}

const markRunning = (store: WorkspaceStore, run: Run): void => {
  store.transaction(() => {
    store.database
      .prepare('INSERT INTO execution_segments(id,run_id) VALUES(?,?)')
      .run(run.id, run.id)
    store.updateRun({
      ...run,
      version: run.version + 1,
      status: 'running',
      startedAt: new Date().toISOString(),
      processState: 'active',
    })
  })
}

const recordProcess = (input: {
  store: WorkspaceStore
  runId: string
  pid: number
  controller: AbortController
}): void => {
  try {
    input.store.database
      .prepare(
        "UPDATE execution_segments SET pid=?,started_at=?,status='running' WHERE id=?",
      )
      .run(input.pid, new Date().toISOString(), input.runId)
  } catch {
    input.controller.abort()
  }
}

const prepareState = (store: WorkspaceStore, runId: string): boolean => {
  const run = store.get('runs', runId, runSchema)
  if (run.status === 'cancelled') return false
  if (run.status !== 'queued') throw new Error('RUN_NOT_QUEUED')
  store.transaction(() =>
    store.updateRun({
      ...run,
      status: 'preparing',
      version: run.version + 1,
      inputDeliveryIds: captureRunInputs(store, run),
    }),
  )
  return true
}

const prepareInputs = (store: WorkspaceStore, run: Run): Run => {
  const inputTree = applyRunInputPatches(run, runInputPatches(store, run))
  const prepared = { ...run, inputTree, version: run.version + 1 }
  store.transaction(() => store.updateRun(prepared))
  return prepared
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
        .prepare('UPDATE execution_segments SET session_id=? WHERE run_id=?')
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
