import { z } from 'zod'

const id = z.string().uuid()
const name = z.string().trim().min(1).max(200)
const text = z.string().trim().min(1).max(20_000)
const version = z.number().int().positive()
export const cliIdSchema = z.enum(['codex', 'claude'])

/** 凭据只保存主进程分配的不透明引用，不能把密钥或任意环境变量写入业务对象。 */
export const modelProfileSchema = z
  .object({
    id,
    version,
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
    createdAt: z.string().datetime(),
  })
  .strict()

export const requirementVersionSchema = z
  .object({
    id,
    version,
    projectId: id,
    title: name,
    body: text,
    acceptanceCriteria: text,
    createdAt: z.string().datetime(),
  })
  .strict()

export const teamVersionSchema = z
  .object({
    id,
    version,
    name,
    roleIds: z.array(id).min(1).max(12),
    coordinatorRoleId: id,
    createdAt: z.string().datetime(),
  })
  .strict()

export const requirementRefSchema = z.object({ id, version }).strict()
export type ModelProfile = z.infer<typeof modelProfileSchema>
export type RequirementVersion = z.infer<typeof requirementVersionSchema>
export type TeamVersion = z.infer<typeof teamVersionSchema>
