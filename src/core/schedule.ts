// 定时任务的领域模型：ScheduleRule 分 once / interval / cron 三类，
// ScheduleManageRequestSchema 是 schedule_manage 工具的入参协议（增删改查、手动运行、查日志）。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal('interval'),
    everyMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).default('Asia/Shanghai'),
  }),
])

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>

export const CreateScheduledTaskSchema = z.object({
  creatorOpenId: z.string().min(1),
  chatId: z.string().min(1),
  targetBotId: z.string().min(1),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
})

export type CreateScheduledTask = z.infer<typeof CreateScheduledTaskSchema>

const ScheduleAddSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
})

export const ScheduleManageRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('add'), ...ScheduleAddSchema.shape }),
  z.object({
    action: z.literal('addMany'),
    schedules: z.array(ScheduleAddSchema).min(1).max(20),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().trim().min(1).max(64),
    targetBotId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
      .optional(),
    prompt: z.string().trim().min(1).max(2_000).optional(),
    rule: ScheduleRuleSchema.optional(),
  }),
  z.object({
    action: z.literal('remove'),
    id: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal('removeMany'),
    ids: z.array(z.string().trim().min(1)).min(1).max(100),
  }),
  // removeAll 必须显式带 confirm:true，防止一句误操作清空全部任务
  z.object({ action: z.literal('removeAll'), confirm: z.literal(true) }),
  z.object({ action: z.literal('run'), id: z.string().trim().min(1).max(64) }),
  z.object({
    action: z.literal('pause'),
    id: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal('resume'),
    id: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal('logs'),
    id: z.string().trim().min(1).optional(),
  }),
])

export type ScheduleManageRequest = z.infer<typeof ScheduleManageRequestSchema>

// MCP SDK 的 normalizeObjectSchema 无法识别顶层 z.discriminatedUnion，
// 会静默降级为 { type: 'object', properties: {} } 导致 AI 无法传参。
// 此 Schema 用于向 MCP 暴露具有明确 properties 的顶层对象，运行时仍由 ScheduleManageRequestSchema 做鉴别联合校验。
export const ScheduleManageToolInputSchema = z.object({
  action: z
    .enum([
      'list',
      'add',
      'addMany',
      'update',
      'remove',
      'removeMany',
      'removeAll',
      'run',
      'pause',
      'resume',
      'logs',
    ])
    .describe(
      '管理动作：list 列出全部计划；add 创建一个；addMany 批量创建；update 编辑；remove 删除；removeMany 批量删除；removeAll 删除全部；run 立即执行；pause 暂停；resume 恢复；logs 查看运行记录',
    ),
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('任务ID（用于 update, remove, run, pause, resume, logs）'),
  targetBotId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional()
    .describe('负责执行任务的团队成员 botId（用于 add, update）'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .optional()
    .describe('任务提示词与完整要求（用于 add, update）'),
  rule: ScheduleRuleSchema.optional().describe(
    '调度规则（用于 add, update）：支持 once（一次性，需指定 runAt ISO时间）、interval（固定间隔，everyMs 毫秒）、cron（Cron表达式）',
  ),
  schedules: z
    .array(ScheduleAddSchema)
    .min(1)
    .max(20)
    .optional()
    .describe('批量创建的任务列表（用于 addMany）'),
  ids: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe('批量删除的任务ID数组（用于 removeMany）'),
  confirm: z
    .boolean()
    .optional()
    .describe('删除全部确认标志，必须为 true（用于 removeAll）'),
})

export type ScheduleManageToolInput = z.infer<
  typeof ScheduleManageToolInputSchema
>

export interface ScheduledTask {
  id: string
  creatorOpenId: string
  chatId: string
  targetBotId: string
  prompt: string
  rule: ScheduleRule
  status: 'active' | 'paused' | 'completed'
  nextRunAt?: string
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}

export const createScheduledTask = (
  options: CreateScheduledTask & { id?: string },
): ScheduledTask => {
  const now = new Date().toISOString()
  return {
    id: options.id ?? randomUUID().replaceAll('-', '').slice(0, 12),
    creatorOpenId: options.creatorOpenId,
    chatId: options.chatId,
    targetBotId: options.targetBotId,
    prompt: options.prompt,
    rule: options.rule,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

export const scheduleKindLabel = (rule: ScheduleRule): string => {
  if (rule.kind === 'once') return '一次性'
  if (rule.kind === 'interval') return '固定间隔'
  return 'Cron'
}

export const scheduleDescription = (rule: ScheduleRule): string => {
  if (rule.kind === 'once') return rule.runAt
  if (rule.kind === 'interval')
    return `每 ${Math.round(rule.everyMs / 60_000)} 分钟`
  return `${rule.expression} (${rule.timezone})`
}
