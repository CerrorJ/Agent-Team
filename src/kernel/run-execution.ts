import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CodexAdapter } from '../cli/codex-adapter.js'
import { runCli, type RunCliOptions } from '../cli/runner.js'
import type { CliEvent, CliRunResult } from '../cli/types.js'
import { projectSchema, runSchema } from './business-contracts.js'
import { prepareRunWorktree } from './git-workspace.js'
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
    const run = store.get('runs', runId, runSchema)
    const project = store.get('projects', run.projectId, projectSchema)
    prepareRunWorktree({ project, run, dataDirectory: input.dataDirectory })
    // M1 不加载项目自定义 CLI 扩展，避免外部 MCP/Hook 绕过既定工具权限。
    if (existsSync(join(run.workDirectory, '.codex/config.toml')))
      throw new Error('CAPABILITY_UNSUPPORTED')
    controller.signal.throwIfAborted()
    store.transaction(() =>
      store.updateRun({
        ...run,
        version: run.version + 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        processState: 'active',
      }),
    )

    const result = await execute({
      adapter: new CodexAdapter({ permission: run.roleSnapshot.permission }),
      cwd: run.workDirectory,
      signal: controller.signal,
      timeoutMs: 30 * 60_000,
      prompt: `职责：${run.roleSnapshot.responsibility}\n任务：${run.goalSnapshot}\n验收条件：${run.acceptanceSnapshot}`,
      ...(run.roleSnapshot.model
        ? { env: { CODEX_MODEL: run.roleSnapshot.model } }
        : {}),
      onEvent: (event) => recordActivity({ store, runId, event, controller }),
    })

    finishRun({ store, runId, result })
  } catch (error) {
    const failureCode =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'CLI_EXECUTION_FAILED'

    finishRun({ store, runId, failureCode })
  }
}

const prepareState = (store: WorkspaceStore, runId: string): boolean => {
  const run = store.get('runs', runId, runSchema)
  if (run.status === 'cancelled') return false
  if (run.status !== 'queued') throw new Error('RUN_NOT_QUEUED')
  store.transaction(() =>
    store.updateRun({ ...run, status: 'preparing', version: run.version + 1 }),
  )
  return true
}

const recordActivity = (input: {
  store: WorkspaceStore
  runId: string
  event: CliEvent
  controller: AbortController
}): void => {
  try {
    const run = input.store.get('runs', input.runId, runSchema)

    // 只保存归一化类型与工具名称，不持久化工具参数、原始 stderr 或用户内容。
    const label =
      input.event.type === 'tool_start'
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
