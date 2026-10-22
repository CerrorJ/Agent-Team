import { z } from 'zod'

const identifier = z.string().trim().min(1).max(200)

/** 只保存应用身份和密文引用；应用 secret 永远不进入业务快照。 */
export const feishuBindingSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
    tenantKey: identifier,
    ownerOpenId: z.string().regex(/^ou_[a-zA-Z0-9_-]+$/),
    chatId: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/),
    credentialRef: z.string().regex(/^feishu-[a-f0-9-]{36}$/),
    enabled: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export const feishuCommandSchema = feishuBindingSchema
  .omit({
    id: true,
    version: true,
    updatedAt: true,
  })
  .extend({
    type: z.literal('feishu.save'),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()

export const feishuCredentialBindingSchema = z
  .object({
    reference: z.string().regex(/^feishu-[a-f0-9-]{36}$/),
    appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  })
  .strict()

export type FeishuBinding = z.infer<typeof feishuBindingSchema>
export type FeishuCommand = z.infer<typeof feishuCommandSchema>
export type FeishuCredentialBinding = z.infer<
  typeof feishuCredentialBindingSchema
>

export const feishuStatusSchema = z
  .object({
    state: z.enum([
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'failed',
    ]),
    bindingVersion: z.number().int().positive().nullable(),
    errorCode: z.string().max(100).nullable(),
    pendingNotifications: z.number().int().nonnegative(),
  })
  .strict()
