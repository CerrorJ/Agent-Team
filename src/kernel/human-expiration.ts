import { HumanStore } from './human-store.js'
import { currentWaitingRun, failWaitingRun } from './human-commands.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 到期是独立的持久决定，不能在随后被拒命令的回滚中丢失，也不能自动放行。 */
export const expireHumanRequests = (
  store: WorkspaceStore,
  now = Date.now(),
): void => {
  const humans = new HumanStore(store)
  for (const request of humans.list()) {
    if (request.status !== 'pending' || Date.parse(request.expiresAt) > now)
      continue
    store.transaction(() => {
      const run = currentWaitingRun(store, request)
      humans.update({
        ...request,
        version: request.version + 1,
        status: 'expired',
        actor: { channel: 'kernel', identity: 'system' },
        resolutionReason: '请求已过期，系统拒绝继续放行',
        decidedAt: new Date(now).toISOString(),
      })
      failWaitingRun(store, run, 'HUMAN_REQUEST_EXPIRED')
    })
  }
}
