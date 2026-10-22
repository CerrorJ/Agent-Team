import { z } from 'zod'

export const activitySchema = z
  .object({
    runId: z.string().uuid(),
    label: z.string(),
    occurredAt: z.string().datetime(),
    sequence: z.number().int(),
  })
  .strict()

export type Activity = z.infer<typeof activitySchema>
