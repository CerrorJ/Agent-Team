import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { executionModel } from './model-runtime.js'
import { prepareTrialInput } from './role-trial-files.js'
import { runCli, type RunCliOptions } from '../cli/runner.js'
import type { CliRunResult } from '../cli/types.js'
import { projectSchema, runSchema, type Run } from './business-contracts.js'
import {
  prepareRunWorktree,
  applyRunInputPatches,
  validateRunContinuation,
} from './git-workspace.js'
import { captureRunInputs, runInputPatches } from './run-inputs.js'
import { finishRun } from './run-outcome.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { CredentialResolver } from './credential-contracts.js'
import { buildRunCliOptions } from './run-cli-options.js'
import { prepareRunSkills, verifyRunSkills } from './run-skills.js'

export type CliExecutionPort = (options: RunCliOptions) => Promise<CliRunResult>

/** 执行准备意图先提交；Git 与 CLI 在事务外执行，结束证据返回后再落终态。 */
export const executeQueuedRun = async (
  input: {
    store: WorkspaceStore
    runId: string
    dataDirectory: string
    controller: AbortController
    credentials?: CredentialResolver
  },
  execute: CliExecutionPort = runCli,
): Promise<void> => {
  const { store, runId, controller } = input
  try {
    if (!prepareState(store, runId)) return
    let run = store.get('runs', runId, runSchema)
    const runtime = await executionModel(run, input.credentials)
    run = prepareExecutionDirectory({
      store,
      run,
      dataDirectory: input.dataDirectory,
    })
    prepareRunSkills({ store, run, dataDirectory: input.dataDirectory })
    // M1 不加载项目自定义 CLI 扩展，避免外部 MCP/Hook 绕过既定工具权限。
    if (
      run.roleSnapshot.cli === 'codex' &&
      existsSync(join(run.workDirectory, '.codex/config.toml'))
    )
      throw new Error('CAPABILITY_UNSUPPORTED')
    controller.signal.throwIfAborted()
    const segmentId = markRunning(store, run)

    const result = await execute(
      buildRunCliOptions({ store, run, controller, segmentId, runtime }),
    )

    verifyRunSkills(store, run)

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

const markRunning = (store: WorkspaceStore, run: Run): string =>
  store.transaction(() => {
    const segmentId = run.continuation ? randomUUID() : run.id
    store.database
      .prepare(
        'INSERT INTO execution_segments(id,run_id,session_id) VALUES(?,?,?)',
      )
      .run(segmentId, run.id, run.continuation?.sessionId ?? null)
    store.updateRun({
      ...run,
      version: run.version + 1,
      status: 'running',
      startedAt: run.startedAt ?? new Date().toISOString(),
      processState: 'active',
      continuation: null,
    })
    return segmentId
  })

const prepareState = (store: WorkspaceStore, runId: string): boolean => {
  const run = store.get('runs', runId, runSchema)
  if (run.status === 'cancelled') return false
  if (run.status !== 'queued') throw new Error('RUN_NOT_QUEUED')
  store.transaction(() =>
    store.updateRun({
      ...run,
      status: 'preparing',
      version: run.version + 1,
      inputDeliveryIds: run.continuation
        ? run.inputDeliveryIds
        : captureRunInputs(store, run),
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

const prepareExecutionDirectory = (input: {
  store: WorkspaceStore
  run: Run
  dataDirectory: string
}): Run => {
  const { store, run, dataDirectory } = input
  const project = store.get('projects', run.projectId, projectSchema)
  if (run.continuation) {
    validateRunContinuation({ project, run, dataDirectory })
    return run
  }
  prepareRunWorktree({ project, run, dataDirectory })
  const prepared = prepareInputs(store, run)
  prepareTrialInput(prepared)
  return prepared
}
