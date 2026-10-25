import { z } from 'zod'

export const projectInspectionInputSchema = z
  .object({ projectId: z.string().uuid() })
  .strict()
const commit = z.string().regex(/^[a-f0-9]{40,64}$/)

/** 只读瞬时Git快照；不是执行授权或第二份项目/任务状态。 */
export const projectInspectionSchema = z
  .object({
    formatVersion: z.literal(1),
    projectId: z.string().uuid(),
    projectVersion: z.number().int().positive(),
    checkedAt: z.string().datetime(),
    repositoryPath: z.string().min(1).max(4096),
    defaultBranch: z.string().min(1).max(200),
    gitUrl: z.string().max(4096),
    git: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('verified'),
          dirty: z.boolean(),
          currentBranch: z.string().max(4096).nullable(),
          currentCommit: commit,
          defaultCommit: commit,
        })
        .strict(),
      z
        .object({
          state: z.literal('unavailable'),
          code: z.string().regex(/^[A-Z_]+$/),
        })
        .strict(),
    ]),
  })
  .strict()

export type ProjectInspection = z.infer<typeof projectInspectionSchema>
