import { z } from 'zod'

const id = z.string().uuid()

/** 新字段允许旧配置缺省；旧Run快照读取时不补写这些字段。 */
export const roleConfigurationFields = {
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  inputRequirements: z.string().trim().max(20_000).optional(),
  deliveryRequirements: z.string().trim().max(20_000).optional(),
  maxConcurrency: z.number().int().min(1).max(2).optional(),
}
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
      type: z.literal('role.copy'),
      sourceRoleId: id,
      expectedSourceVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(200),
      slug: roleConfigurationFields.slug.unwrap(),
    })
    .strict(),
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
