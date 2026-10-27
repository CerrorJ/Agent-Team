import { z } from 'zod'

const identifier = z.string().trim().min(1).max(200)
export const feishuAppIdSchema = z.string().regex(/^cli_[0-9a-fA-F]{16}$/)

/** 只保存应用身份和密文引用；应用 secret 永远不进入业务快照。 */
export const feishuBindingSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    // 历史宽松绑定保持可读；新保存及连接前按锁定 SDK 的严格格式校验。
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
    appId: feishuAppIdSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()

/** 角色提交配置而非自报绑定身份；身份由保存版本的事务生成。 */
export const roleFeishuInputSchema = feishuCommandSchema.omit({
  type: true,
  expectedVersion: true,
})

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

export const roleFeishuStatusSchema = z
  .object({
    roleId: z.string().uuid(),
    roleVersion: z.number().int().positive(),
    connections: z.array(
      feishuStatusSchema
        .omit({ bindingVersion: true })
        .extend({ appId: feishuAppIdSchema }),
    ),
  })
  .strict()
