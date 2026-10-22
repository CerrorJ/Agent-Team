import { z } from 'zod'
import { ApprovalRequestSchema } from '../core/approval.js'
import { ClarificationRequestSchema } from '../core/clarification.js'

const id = z.string().uuid()
const version = z.number().int().positive()
const text = z.string().trim().min(1).max(20_000)

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

/** 三类人工处理有不同的决定，不能把交付验收或停止请求混入审批。 */
export const humanPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('clarification'),
      request: ClarificationRequestSchema,
    })
    .strict(),
  z.object({ kind: z.literal('plan'), title: text, summary: text }).strict(),
  z
    .object({ kind: z.literal('operation'), request: ApprovalRequestSchema })
    .strict(),
])

export const humanDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approved') }).strict(),
  z.object({ decision: z.literal('rejected'), reason: text }).strict(),
  z
    .object({
      decision: z.literal('answered'),
      answers: z
        .array(
          z
            .object({ questionId: z.string().min(1).max(32), answer: text })
            .strict(),
        )
        .min(1)
        .max(5),
    })
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
export type HumanPayload = z.infer<typeof humanPayloadSchema>
export type HumanDecision = z.infer<typeof humanDecisionSchema>
export type HumanActor = NonNullable<HumanRequest['actor']>
