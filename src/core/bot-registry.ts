import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CliId } from '../cli/types.js'
import { resolveWorkspacePath } from './workspace.js'
const ProductDeliveryModeSchema = z.enum(['local', 'lark-doc'])

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>
export interface BotConfig {
  id: string
  group?: string
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

export const getBotModelDisplayName = (config: BotConfig): string => {
  return (
    config.cliEnv.ANTHROPIC_MODEL ||
    config.cliEnv.OPENAI_MODEL ||
    config.defaultCliId
  )
}

// Zod 会检查配置文件里的字段和类型，接着检查 id 是否重复，并根据 appIdEnv 和 appSecretEnv 读取真实凭证
// enabled 为 false 的在解析阶段就会过滤掉，所以停用的 bot 不会索取凭证，也不会建立长连接
const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  group: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
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

  const teamLeaderBot = parsed.bots.find((bot) => bot.id === parsed.teamLeader)

  const systemAppId = (
    env.FEISHU_APP_ID ||
    env.APP_ID ||
    (teamLeaderBot ? env[teamLeaderBot.appIdEnv] : '') ||
    env.BOT_A_APP_ID ||
    ''
  ).trim()

  const systemAppSecret = (
    env.FEISHU_APP_SECRET ||
    env.APP_SECRET ||
    (teamLeaderBot ? env[teamLeaderBot.appSecretEnv] : '') ||
    env.BOT_A_APP_SECRET ||
    ''
  ).trim()

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      // 若当前 bot 的凭证环境变量在 .env 中未配置，复用系统级的，不要复用同组的
      const appId = (env[bot.appIdEnv]?.trim() || systemAppId).trim()

      const appSecret =
        (env[bot.appSecretEnv]?.trim() || systemAppSecret).trim()

      if (!appId) {
        throw new Error(
          `bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}，且未配置系统级凭证 (FEISHU_APP_ID / APP_ID)`,
        )
      }
      if (!appSecret) {
        throw new Error(
          `bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}，且未配置系统级凭证 (FEISHU_APP_SECRET / APP_SECRET)`,
        )
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
        group: bot.group,
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
  // lark-doc 是通用的文档读写能力；只有产品方案 Skill 才需要审批交付流程。
  const ownsProductSpecs = config.skills.some((skill) =>
    ['to-spec', 'to-tickets'].includes(skill),
  )

  const productDeliveryPolicy = ownsProductSpecs
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

  // 验证与命令执行规则：确保测试在前台同步阻塞执行并等待结果，严禁后台派发导致卡片提前完成
  const commandExecutionPolicy = [
    '命令与测试执行规则（必须遵守）：',
    '- 严禁将冒烟测试、验证脚本、构建或测试命令放到后台执行（禁止使用 &、nohup、disown，以及 Claude Code 的 run_in_background: true 等后台派发方式）。',
    '- 所有测试与本地命令必须在当前会话前台同步运行，CLI 必须持续阻塞等待本地进程退出并拿到完整输出；严禁在测试进程未返回前提前结束回复。',
    '- 建议对多阶段测试按步骤分步执行命令（如先环境检查、再跑特定模块验证），使飞书卡片能实时展示当前执行阶段与步骤耗时。',
    '- 必须在本地测试进程全部运行完毕并核实测试结果后，方可在最终回复中给出测试结论。',
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
    commandExecutionPolicy,
    `当前任务：${prompt}`,
  ]

  return sections.filter(Boolean).join('\n\n')
}

/**
 * 构造轻量级任务交接提示词（限额代班接力）
 * 核心原则：
 * 1. 节省 Token：严禁把旧窗口的大段历史消息或终端输出盲目塞入提示词。
 * 2. 独立 Session / 新窗口：指示新成员在全新独立会话窗口中继续推进，不要在原窗口纠缠。
 * 3. 继承工作区成果：前序成员已经在工作区进行了代码修改或创建了文件，直接基于现有工作区现场继续，避免从零重复劳动。
 */
export const buildHandoffContinuationPrompt = (options: {
  fallbackFromId: string
  fallbackConfig: BotConfig
  taskText: string
  workspaceDir: string
  resetText?: string
}): string => {
  const { fallbackFromId, fallbackConfig, taskText, workspaceDir, resetText } =
    options

  return [
    '【任务交接接续通知】',
    `原同组成员 ${fallbackFromId} 在推进此任务时触发了会话额度限制${resetText ? `（预计 ${resetText} 重置）` : ''}。`,
    `现由你（${fallbackConfig.id}）在全新的独立会话窗口接替继续推进。`,
    '',
    '【核心任务目标】：',
    taskText,
    '',
    '【极简续跑与节省 Token 规则（必须严格遵守）】：',
    `1. 继承现场：前序成员已在当前工作区 (${workspaceDir}) 完成了部分改动与文件编写。`,
    '2. 避免重复劳动：请直接基于当前工作区的文件现场继续推进，不要从零重写已有有效代码。开始前可简要查看文件或运行必要检查（如 git status）确认当前进度。',
    '3. 独立推进与验证：在当前独立窗口中推进剩余未完成的目标，所有测试与验证命令必须在前台同步执行并等待结果。',
    '4. 精炼交付：完成后提供简要的改动说明与交付结论。',
  ].join('\n')
}
