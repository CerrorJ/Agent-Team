import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CliId } from '../cli/types.js'
import { resolveWorkspacePath } from './workspace.js'
const ProductDeliveryModeSchema = z.enum(['local', 'lark-doc'])

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>
export interface BotConfig {
  id: string
  appId: string
  appSecret: string
  defaultCliId: CliId
  role: string
  skills: string[]
  systemPrompt: string
  workspaceDir: string
  reviewBy?: string
  collaborationMaxRounds: number
  // 键为传给 CLI 的环境变量名，值为 .env 中保存实际值的变量名。
  // 配置文件只保存引用，避免把模型供应商密钥写入 bots.json。
  cliEnv: Record<string, string>
}
export interface AgentTeamConfig {
  teamLeaderId: string
  defaultProductDeliveryMode: ProductDeliveryMode
  bots: BotConfig[]
}
type Environment = Record<string, string | undefined>

// Zod 会检查配置文件里的字段和类型，接着检查 id 是否重复，并根据 appIdEnv 和 appSecretEnv 读取真实凭证
// enabled 为 false 的在解析阶段就会过滤掉，所以停用的 bot 不会索取凭证，也不会建立长连接
const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(['claude', 'codex']),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(''),
  reviewBy: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
  collaborationMaxRounds: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .default(16),
  cliEnv: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    )
    .optional()
    .default({}),
  enabled: z.boolean().optional().default(true),
})

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode:
    ProductDeliveryModeSchema.optional().default('lark-doc'),
  bots: z.array(BotSchema).min(1),
})

export const parseAgentTeamConfig = (
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): AgentTeamConfig => {
  const parsed = BotConfigFileSchema.parse(input)
  const ids = new Set<string>()
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`)
    ids.add(bot.id)
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? ''
      const appSecret = env[bot.appSecretEnv]?.trim() ?? ''
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`)
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`)
      }

      const cliEnv = Object.fromEntries(
        Object.entries(bot.cliEnv).map(([targetName, sourceName]) => {
          const value = env[sourceName]?.trim() ?? ''
          if (!value) {
            throw new Error(
              `bot ${bot.id} 的 CLI 环境变量 ${targetName} 缺少 ${sourceName}`,
            )
          }
          return [targetName, value]
        }),
      )

      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        reviewBy: bot.reviewBy,
        collaborationMaxRounds: bot.collaborationMaxRounds,
        cliEnv,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? '.',
          baseDirectory,
        ),
      }
    })

  if (configs.length === 0) throw new Error('至少需要启用一个 bot')
  const enabledIds = new Set(configs.map((config) => config.id))
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`)
  }
  for (const config of configs) {
    if (config.reviewBy && !enabledIds.has(config.reviewBy)) {
      throw new Error(
        `bot ${config.id} 的 reviewBy 指向未启用的 bot: ${config.reviewBy}`,
      )
    }
    if (config.reviewBy === config.id) {
      throw new Error(`bot ${config.id} 不能把自己配置为 reviewBy`)
    }
  }
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
  }
}
export const parseBotConfigs = (
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): BotConfig[] => {
  return parseAgentTeamConfig(input, env, baseDirectory).bots
}

export const loadAgentTeamConfig = async (
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentTeamConfig> => {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      )
    }
    throw error
  }

  try {
    return parseAgentTeamConfig(JSON.parse(content), env, baseDirectory)
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`)
  }
}

export const loadBotConfigs = async (
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> => {
  return (await loadAgentTeamConfig(filePath, env, baseDirectory)).bots
}

// 把角色说明放到真实任务前面。
export const buildBotPrompt = (
  config: Pick<BotConfig, 'role' | 'skills' | 'systemPrompt'>,
  prompt: string,
  teamContext = '',
  defaultProductDeliveryMode: ProductDeliveryMode = 'lark-doc',
): string => {
  // 只给负责产品文档的 bot 注入交付方式规则，其他角色不感知
  const managesProductDocuments = config.skills.some((skill) =>
    ['to-spec', 'to-tickets', 'lark-doc'].includes(skill),
  )

  const productDeliveryPolicy = managesProductDocuments
    ? [
        '产品方案交付规则（必须遵守）：',
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        '- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。',
        '- 不要为了选择交付格式单独发起澄清。',
        '- 方案产物完成后必须实际调用 request_spec_approval，并提交最终采用的 deliveryMode 与对应产物字段。',
        '- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。',
      ].join('\n')
    : ''

  // 飞书是聊天界面：长产物进文件、决策走澄清工具，避免大段内容刷屏
  const feishuOutputPolicy = [
    '飞书输出规则（必须遵守）：',
    '- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。',
    '- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。',
    '- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。',
    '- 需要用户决策时，必须调用 request_clarification 工具；不要用大段文字列出问题。工具调用后停止继续推断，等待用户回答。',
  ].join('\n')

  const sections = [
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    productDeliveryPolicy,
    // Skill 解析顺序写死在提示词里：工作区版本优先，防止 CLI 直接用全局同名 Skill
    config.skills.length > 0
      ? [
          '项目 Skill 加载规则（优先级不可颠倒）：',
          '- 对配置中声明的每个 Skill，先读取当前工作区 `.agents/skills/<skill>/SKILL.md`。',
          '- 上述路径不存在时，再读取当前工作区 `.claude/skills/<skill>/SKILL.md`。',
          '- 只有两个工作区路径都不存在时，才允许回退到用户级或全局同名 Skill；不得因全局 Skill 同名而跳过工作区版本。',
          `本次任务必须执行的项目 Skill：${config.skills.map((skill) => `$${skill}`).join('、')}`,
        ].join('\n')
      : '',
    feishuOutputPolicy,
    `当前任务：${prompt}`,
  ]

  return sections.filter(Boolean).join('\n\n')
}
