import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  businessCommandSchema,
  type BusinessCommand,
} from './business-contracts.js'
import type { FeishuBinding } from './feishu-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceService } from './workspace-service.js'
import { HumanStore } from './human-store.js'

const actionSchema = z
  .object({
    bindingVersion: z.number().int().positive(),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approved', 'rejected', 'answered']),
  })
  .strict()

// SDK 长连接经过认证后将 header 与 event 展平；仍逐项校验应用、租户、所有者和会话。
const callbackSchema = z.object({
  event_id: z.string().min(1).max(200),
  app_id: z.string(),
  tenant_key: z.string(),
  operator: z.object({ open_id: z.string(), tenant_key: z.string() }),
  context: z.object({ open_chat_id: z.string() }),
  action: z.object({
    value: actionSchema,
    form_value: z.record(z.string(), z.unknown()).default({}),
  }),
})

export const applyFeishuAction = (options: {
  binding: FeishuBinding
  raw: unknown
  store: WorkspaceStore
  service: WorkspaceService
}): void => {
  const event = callbackSchema.parse(options.raw)
  const { binding } = options
  if (
    !binding.enabled ||
    event.app_id !== binding.appId ||
    event.tenant_key !== binding.tenantKey ||
    event.operator.tenant_key !== binding.tenantKey ||
    event.operator.open_id !== binding.ownerOpenId ||
    event.context.open_chat_id !== binding.chatId ||
    event.action.value.bindingVersion !== binding.version
  )
    throw new Error('FEISHU_IDENTITY_MISMATCH')
  const command = decisionCommand(options.store, event.action)
  // 同一平台事件必须产生同一命令键；状态与回执在共享事务提交，重投不会再次续接。
  options.service.command(
    { key: callbackKey(binding, event.event_id), command },
    {
      channel: 'feishu',
      identity: 'local-owner',
    },
  )
}

const decisionCommand = (
  store: WorkspaceStore,
  action: z.infer<typeof callbackSchema>['action'],
): BusinessCommand => {
  const request = new HumanStore(store).get(action.value.requestId)
  const { bindingVersion: _binding, decision, ...fields } = action.value

  const response =
    decision === 'answered'
      ? {
          decision,
          answers:
            request.payload.kind === 'clarification'
              ? request.payload.request.questions.map((question) => ({
                  questionId: question.id,
                  answer: z
                    .string()
                    .trim()
                    .min(1)
                    .max(1000)
                    .parse(action.form_value[`answer_${question.id}`]),
                }))
              : [],
        }
      : decision === 'rejected'
        ? {
            decision,
            reason: z
              .string()
              .trim()
              .min(1)
              .max(1000)
              .parse(action.form_value.reason),
          }
        : { decision }

  return businessCommandSchema.parse({
    type: 'human.resolve',
    ...fields,
    response,
  })
}

const callbackKey = (binding: FeishuBinding, eventId: string): string => {
  const hex = createHash('sha256')
    .update(`${binding.appId}:${binding.version}:${eventId}`)
    .digest('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
