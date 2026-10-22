import { z } from 'zod'
import { ApprovalRequestSchema } from './operation-approval.js'
import { ClarificationRequestSchema } from './clarification-request.js'
const text = z.string().trim().min(1).max(20_000)

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

export type HumanPayload = z.infer<typeof humanPayloadSchema>
export type HumanDecision = z.infer<typeof humanDecisionSchema>
