import { z } from 'zod'
import { businessCommandSchema } from './business-contracts.js'
export * from './business-contracts.js'
export * from './activity-contracts.js'
export * from './product-contracts.js'
export * from './role-contracts.js'
export * from './workspace-contracts.js'
export * from './credential-contracts.js'
export * from './human-contracts.js'

export const PROTOCOL_VERSION = 1 as const
export const KERNEL_VERSION = '0.4.1'
export const DATA_SCHEMA_VERSION = 5

const requestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().uuid(),
}

/** 私有连接也必须校验输入；业务操作使用版本化命令，不接受任意 shell 或文件访问。 */
export const requestSchema = z.discriminatedUnion('method', [
  z.object({ ...requestBase, method: z.literal('kernel.handshake') }).strict(),
  z.object({ ...requestBase, method: z.literal('kernel.health') }).strict(),
  z
    .object({ ...requestBase, method: z.literal('workspace.snapshot') })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.command'),
      key: z.string().uuid(),
      command: businessCommandSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.delivery'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.run'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.activity'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('kernel.events'),
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ ...requestBase, method: z.literal('kernel.shutdown') }).strict(),
])

export const eventSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    eventId: z.string().uuid(),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.enum(['kernel.started', 'kernel.stopped']),
  })
  .strict()

export const handshakeSchema = z
  .object({
    kernelVersion: z.literal(KERNEL_VERSION),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    dataSchemaVersion: z.literal(DATA_SCHEMA_VERSION),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    capabilities: z.array(
      z.enum([
        'health',
        'persistent-events',
        'graceful-shutdown',
        'local-workflow',
        'product-catalog',
        'role-trials',
        'team-workflow',
        'codex-and-claude',
        'human-workflow',
      ]),
    ),
    unavailable: z.array(z.string()),
    runtime: z
      .object({ node: z.string(), platform: z.string(), arch: z.string() })
      .strict(),
  })
  .strict()

export const responseSchema = z.discriminatedUnion('status', [
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: z.string().uuid(),
      status: z.enum(['completed', 'accepted']),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: z.string().uuid().nullable(),
      status: z.literal('rejected'),
      error: z
        .object({
          code: z.string().regex(/^[A-Z_]+$/),
          message: z.string(),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
])

export type KernelRequest = z.infer<typeof requestSchema>
export type KernelResponse = z.infer<typeof responseSchema>
export type KernelEvent = z.infer<typeof eventSchema>
export type KernelHandshake = z.infer<typeof handshakeSchema>
