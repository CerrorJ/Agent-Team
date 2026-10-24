import { z } from 'zod'
import { projectSchema, roleVersionSchema } from './business-contracts.js'
import { configurationFingerprintSchema } from './preflight-fingerprint.js'

export const preflightInputSchema = z
  .object({
    operation: z.enum(['start', 'retry', 'team']),
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const preflightCheckSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().uuid().optional(),
    state: z.enum(['passed', 'blocked', 'waiting', 'unverified']),
    code: z.string().regex(/^[A-Z_]+$/),
  })
  .strict()

export const taskPreflightSchema = z
  .object({
    formatVersion: z.literal(1),
    checkedAt: z.string().datetime(),
    intent: preflightInputSchema,
    canStart: z.boolean(),
    configurationFingerprint: configurationFingerprintSchema.nullable(),
    project: projectSchema
      .extend({
        baselineCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
        currentBranch: z.string().nullable(),
        currentCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .nullable(),
    tasks: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
            title: z.string(),
            goal: z.string(),
            acceptanceCriteria: z.string(),
            parentTaskId: z.string().uuid().nullable(),
            dependencyTaskIds: z.array(z.string().uuid()).max(12),
            role: roleVersionSchema.pick({
              id: true,
              version: true,
              name: true,
              cli: true,
              model: true,
              modelProfileSnapshot: true,
              permission: true,
              skills: true,
              maxConcurrency: true,
              responsibility: true,
              inputRequirements: true,
              deliveryRequirements: true,
            }),
            requirementRef: z
              .object({
                id: z.string().uuid(),
                version: z.number().int().positive(),
              })
              .nullable(),
            feedback: z.string().max(20_000),
          })
          .strict(),
      )
      .max(12),
    checks: z.array(preflightCheckSchema).max(100),
  })
  .strict()

export type PreflightInput = z.infer<typeof preflightInputSchema>
export type PreflightCheck = z.infer<typeof preflightCheckSchema>
export type TaskPreflight = z.infer<typeof taskPreflightSchema>
