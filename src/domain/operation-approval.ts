import { z } from 'zod'

export const ApprovalRequestSchema = z.object({
  operation: z.string().trim().min(1).max(120),
  detail: z.string().trim().min(1).max(2_000),
  impact: z.string().trim().min(1).max(500),
  rollback: z.string().trim().min(1).max(500),
  timeoutSeconds: z.number().int().min(60).max(3_600).optional(),
})

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
