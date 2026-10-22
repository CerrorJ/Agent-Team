import { assertExecutionTransition } from '../domain/run-state.js'
import type { Run } from './business-contracts.js'
import { taskSchema } from './business-contracts.js'
import { HumanStore } from './human-store.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 等待态没有活动 CLI，停止直接确认逻辑结束并撤销请求，不能再批准续接。 */
export const stopWaitingRun = (store: WorkspaceStore, run: Run): void => {
  if (run.processState !== 'confirmed_ended') throw new Error('STATE_UNCERTAIN')
  assertExecutionTransition(run.status, 'stopped')
  if (run.pendingHumanRequestId) {
    const humans = new HumanStore(store)
    const request = humans.get(run.pendingHumanRequestId)
    if (request.status === 'pending')
      humans.update({
        ...request,
        version: request.version + 1,
        status: 'cancelled',
        decidedAt: new Date().toISOString(),
        actor: { channel: 'kernel', identity: 'system' },
        resolutionReason: '当前执行已经停止，请求同步撤销',
      })
  }
  store.updateRun({
    ...run,
    version: run.version + 1,
    status: 'stopped',
    endedAt: new Date().toISOString(),
    pendingHumanRequestId: null,
    continuation: null,
  })
  const task = store.get('tasks', run.taskId, taskSchema)
  store.updateTask({ ...task, version: task.version + 1, status: 'ready' })
}
