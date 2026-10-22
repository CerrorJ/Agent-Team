import { z } from 'zod'
import {
  humanPayloadSchema,
  humanDecisionSchema,
} from '../domain/human-request.js'
export {
  humanPayloadSchema,
  humanDecisionSchema,
  type HumanPayload,
  type HumanDecision,
} from '../domain/human-request.js'

const id = z.string().uuid()
const version = z.number().int().positive()

const humanActorSchema = z.union([
  z
    .object({
      channel: z.enum(['desktop', 'feishu']),
      identity: z.literal('local-owner'),
    })
    .strict(),
  z
    .object({ channel: z.literal('kernel'), identity: z.literal('system') })
    .strict(),
])

export const humanRequestSchema = z
  .object({
    id,
    version,
    runId: id,
    taskId: id,
    projectId: id,
    segmentId: id,
    payload: humanPayloadSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      'pending',
      'approved',
      'answered',
      'rejected',
      'expired',
      'cancelled',
    ]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    decision: humanDecisionSchema.nullable(),
    actor: humanActorSchema.nullable(),
    resolutionReason: z.string().max(20_000).nullable().default(null),
  })
  .strict()

export const humanCommandSchemas = [
  z
    .object({
      type: z.literal('human.resolve'),
      requestId: id,
      expectedVersion: version,
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
      response: humanDecisionSchema,
    })
    .strict(),
] as const

export type HumanRequest = z.infer<typeof humanRequestSchema>
export type HumanActor = NonNullable<HumanRequest['actor']>
