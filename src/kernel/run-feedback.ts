import {
  deliverySchema,
  acceptanceSchema,
  type Run,
} from './business-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 退回理由固定进新Run；只读取最后一次交付，不改写原验收记录。 */
export const retryFeedback = (
  store: WorkspaceStore,
  previous: Run | undefined,
): string => {
  if (!previous) return ''

  const delivery = store
    .list('deliveries', deliverySchema)
    .find((item) => item.runId === previous.id)

  const acceptance =
    delivery &&
    store
      .list('acceptances', acceptanceSchema)
      .find((item) => item.deliveryId === delivery.id)

  return acceptance?.reason || previous.feedbackSnapshot
}
