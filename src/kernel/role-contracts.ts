import { z } from 'zod'

const id = z.string().uuid()
export const roleReadinessSchema = z
  .object({
    roleId: id,
    roleVersion: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    state: z.enum(['draft', 'trial_running', 'ready', 'disabled']),
    enabled: z.boolean(),
    latestTrialRunId: id.nullable(),
    failureCode: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export const roleTrialSchema = z
  .object({
    challenge: id,
    inputFile: z.string().regex(/^[a-z0-9.-]+$/),
    outputFile: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .nullable(),
  })
  .strict()

export const roleCommandSchemas = [
  z
    .object({
      type: z.literal('role.trial'),
      roleId: id,
      expectedRoleVersion: z.number().int().positive(),
      projectId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal('role.setEnabled'),
      roleId: id,
      expectedRoleVersion: z.number().int().positive(),
      expectedReadinessVersion: z.number().int().nonnegative(),
      enabled: z.boolean(),
    })
    .strict(),
] as const

export type RoleReadiness = z.infer<typeof roleReadinessSchema>
export type RoleTrial = z.infer<typeof roleTrialSchema>
