import { z } from 'zod'
import type { WorkspaceStore } from './workspace-store.js'
import type { FeishuBinding } from './feishu-contracts.js'
import { HumanStore } from './human-store.js'
import { runSchema } from './business-contracts.js'

/** 请求先找到所属Run，再取不可变路由；回调自报应用身份不能决定业务归属。 */
export const roleActionBinding = (input: {
  store: WorkspaceStore
  appId: string
  raw: unknown
}): FeishuBinding => {
  const parsed = z
    .object({
      action: z.object({ value: z.object({ requestId: z.string().uuid() }) }),
    })
    .parse(input.raw)

  const binding = requestBinding(input.store, parsed.action.value.requestId)
  if (!binding || binding.appId.toLowerCase() !== input.appId.toLowerCase())
    throw new Error('FEISHU_IDENTITY_MISMATCH')
  return binding
}

export const assertFeishuActionRoute = (input: {
  store: WorkspaceStore
  binding: FeishuBinding
  requestId: string
  bindingId: string | undefined
}): void => {
  const route = requestBinding(input.store, input.requestId)
  if (route === undefined && input.bindingId === undefined) return
  if (!route || route.id !== input.binding.id || input.bindingId !== route.id)
    throw new Error('FEISHU_IDENTITY_MISMATCH')
}

const requestBinding = (store: WorkspaceStore, requestId: string) => {
  const request = new HumanStore(store).get(requestId)
  return store.get('runs', request.runId, runSchema).roleSnapshot.feishuBinding
}
