import { z } from 'zod'
import { cliIdSchema, requirementMetadataFields } from './product-contracts.js'

const id = z.string().uuid()
const expectedVersion = z.number().int().nonnegative()
const name = z.string().trim().min(1).max(200)
const text = z.string().trim().min(1).max(20_000)

export const productCommandSchemas = [
  z
    .object({
      type: z.literal('model.save'),
      id: id.optional(),
      expectedVersion,
      name,
      cli: cliIdSchema,
      provider: z.enum([
        'cli-managed',
        'openai-compatible',
        'anthropic-compatible',
      ]),
      model: z.string().trim().max(200),
      baseUrl: z.string().max(2048),
      credentialRef: z
        .string()
        .regex(/^model-[a-f0-9-]{36}$/)
        .nullable(),
      reasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    })
    .strict(),
  z
    .object({
      type: z.literal('requirement.save'),
      id: id.optional(),
      expectedVersion,
      projectId: id,
      title: name,
      body: text,
      acceptanceCriteria: text,
      ...requirementMetadataFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('team.save'),
      id: id.optional(),
      expectedVersion,
      name,
      description: z.string().trim().max(20_000).optional(),
      roleIds: z.array(id).min(1).max(12),
      coordinatorRoleId: id,
    })
    .strict(),
] as const
