import { z } from 'zod'

const id = z.string().uuid()
const text = z.string().trim().min(1).max(20_000)
const title = z.string().trim().min(1).max(200)
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)

export const teamCommandSchemas = [
  z
    .object({
      type: z.literal('team.createTask'),
      teamId: id,
      expectedTeamVersion: z.number().int().positive(),
      projectId: id,
      title,
      goal: text,
      acceptanceCriteria: text,
      steps: z
        .array(
          z
            .object({
              key,
              roleId: id,
              title,
              goal: text,
              acceptanceCriteria: text,
              dependsOn: z.array(key).max(12),
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({
      type: z.literal('team.start'),
      taskId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
] as const
