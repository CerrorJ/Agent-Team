import { z } from 'zod'

const projectText = z.string().trim().max(20_000)

/** 缺省字段保留旧项目原貌；清空团队必须显式传 null，不接受空白 UUID。 */
export const projectSettingsFields = {
  goal: projectText.optional(),
  description: projectText.optional(),
  defaultTeamId: z.string().uuid().nullable().optional(),
}

export const projectConfigureCommandSchema = z
  .object({
    type: z.literal('project.configure'),
    projectId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    goal: projectText,
    description: projectText,
    defaultTeamId: z.string().uuid().nullable(),
  })
  .strict()

/** Run 只保存业务上下文，不把原仓库路径注入 CLI 提示。 */
export const projectContextSnapshotSchema = z
  .object({
    projectId: z.string().uuid(),
    projectVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    ...projectSettingsFields,
  })
  .strict()
