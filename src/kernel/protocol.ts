import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const KERNEL_VERSION = '0.1.0'
export const DATA_SCHEMA_VERSION = 1

const requestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().uuid(),
}

/** 私有连接也必须校验输入；M0 仅开放诊断，不接受任意命令或路径。 */
export const requestSchema = z.discriminatedUnion('method', [
  z.object({ ...requestBase, method: z.literal('kernel.handshake') }).strict(),
  z.object({ ...requestBase, method: z.literal('kernel.health') }).strict(),
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
      z.enum(['health', 'persistent-events', 'graceful-shutdown']),
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
      status: z.literal('completed'),
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
          code: z.enum([
            'VALIDATION_FAILED',
            'KERNEL_STOPPED',
            'INTERNAL_ERROR',
          ]),
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
