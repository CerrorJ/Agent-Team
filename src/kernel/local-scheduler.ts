import { runSchema, taskSchema } from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import { executeQueuedRun, type CliExecutionPort } from './run-execution.js'

/** M1 单执行槽，确保工作目录不并发写；M2 再扩展团队与依赖调度。 */
export class LocalScheduler {
  private active:
    | { runId: string; controller: AbortController; finished: Promise<void> }
    | undefined
  private closing = false
  private faulted = false

  constructor(
    private readonly options: {
      store: WorkspaceStore
      dataDirectory: string
      execute?: CliExecutionPort
    },
  ) {}

  recover(): void {
    const store = this.options.store
    for (const run of store.list('runs', runSchema)) {
      if (!['preparing', 'running', 'stopping'].includes(run.status)) continue
      // 无结束证据时只恢复为待确认，不依据 PID 或心跳宣布死亡，不自动重放。
      store.transaction(() => {
        store.updateRun({
          ...run,
          status: run.status,
          version: run.version + 1,
          processState: 'uncertain',
          failureCode: 'STATE_UNCERTAIN',
        })
      })
    }
    this.kick()
  }

  kick(): void {
    if (this.closing || this.faulted) return
    const store = this.options.store
    if (
      store
        .list('runs', runSchema)
        .some((run) => run.processState === 'uncertain')
    )
      return
    if (this.active) {
      const current = store.get('runs', this.active.runId, runSchema)
      if (current.status === 'stopping') this.active.controller.abort()
      return
    }

    const queued = store
      .list('runs', runSchema)
      .find((run) => run.status === 'queued')

    if (!queued) return
    const controller = new AbortController()

    // 微任务启动，先安装活动句柄；重复 kick 不会重复启动同一 Run。
    const finished = Promise.resolve()
      .then(() =>
        executeQueuedRun(
          {
            store,
            runId: queued.id,
            dataDirectory: this.options.dataDirectory,
            controller,
          },
          this.options.execute,
        ),
      )
      .catch(() => {
        this.faulted = true
      })
      .finally(() => {
        this.active = undefined
        this.kick()
      })

    this.active = { runId: queued.id, controller, finished }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    const store = this.options.store
    if (
      store
        .list('runs', runSchema)
        .some((run) => run.processState === 'uncertain')
    )
      throw new Error('STATE_UNCERTAIN')
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
    this.active?.controller.abort()
    await this.active?.finished
    if (
      this.faulted ||
      store
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
      store.updateTask({ ...task, version: task.version + 1, status: 'ready' })
    })
  }
}
