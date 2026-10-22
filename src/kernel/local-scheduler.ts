import { runSchema, taskSchema } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import { executeQueuedRun, type CliExecutionPort } from './run-execution.js'
import { finishRoleTrial } from './role-trial-state.js'
import { queueBlocker } from './queue-rules.js'
import { refreshTeamProgress } from './team-progress.js'
import type { CredentialResolver } from './credential-contracts.js'

type ActiveExecution = { controller: AbortController; finished: Promise<void> }

/** 活动句柄在微任务前登记，避免连续命令重复启动；恢复不依赖旧 PID 猜测进程死亡。 */
export class LocalScheduler {
  private readonly active = new Map<string, ActiveExecution>()
  private closing = false
  private faulted = false

  constructor(
    private readonly options: {
      store: WorkspaceStore
      dataDirectory: string
      execute?: CliExecutionPort
      credentials?: CredentialResolver
    },
  ) {}

  recover(): void {
    const store = this.options.store
    for (const run of store.list('runs', runSchema)) {
      if (!['preparing', 'running', 'stopping'].includes(run.status)) continue
      store.transaction(() =>
        store.updateRun({
          ...run,
          version: run.version + 1,
          processState: 'uncertain',
          failureCode: 'STATE_UNCERTAIN',
        }),
      )
    }
    this.kick()
  }

  kick(): void {
    if (this.closing || this.faulted) return
    const store = this.options.store
    refreshTeamProgress(store)
    for (const [id, execution] of this.active) {
      if (store.get('runs', id, runSchema).status === 'stopping')
        execution.controller.abort()
    }
    for (const run of store.list('runs', runSchema)) {
      if (run.status !== 'queued' || this.active.has(run.id)) continue
      if (
        queueBlocker({ store, run, reservedIds: new Set(this.active.keys()) })
      )
        continue
      this.start(run.id)
    }
  }

  private start(runId: string): void {
    const controller = new AbortController()

    const finished = Promise.resolve()
      .then(() =>
        executeQueuedRun(
          {
            store: this.options.store,
            runId,
            dataDirectory: this.options.dataDirectory,
            controller,
            ...(this.options.credentials
              ? { credentials: this.options.credentials }
              : {}),
          },
          this.options.execute,
        ),
      )
      .catch(() => {
        this.faulted = true
      })
      .finally(() => {
        this.active.delete(runId)
        this.kick()
      })

    this.active.set(runId, { controller, finished })
  }

  async shutdown(): Promise<void> {
    this.closing = true
    const store = this.options.store
    this.assertKnown()
    for (const run of store.list('runs', runSchema)) {
      if (run.status === 'queued') this.cancelQueued(run.id)
      else if (run.status === 'running' || run.status === 'preparing') {
        store.transaction(() =>
          store.updateRun({
            ...run,
            status: 'stopping',
            version: run.version + 1,
          }),
        )
      }
    }
    for (const execution of this.active.values()) execution.controller.abort()
    await Promise.all(
      [...this.active.values()].map((execution) => execution.finished),
    )
    this.assertKnown()
  }

  private assertKnown(): void {
    if (
      this.faulted ||
      this.options.store
        .list('runs', runSchema)
        .some((run) => run.processState === 'uncertain')
    )
      throw new Error('STATE_UNCERTAIN')
  }

  private cancelQueued(runId: string): void {
    const store = this.options.store
    const run = store.get('runs', runId, runSchema)
    store.transaction(() => {
      store.updateRun({
        ...run,
        status: 'cancelled',
        version: run.version + 1,
        endedAt: new Date().toISOString(),
        processState: 'confirmed_ended',
      })
      const task = store.get('tasks', run.taskId, taskSchema)
      finishRoleTrial(store, run, false)
      store.updateTask({ ...task, version: task.version + 1, status: 'ready' })
    })
  }
}
