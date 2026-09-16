import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { watchFile } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { BotConfig } from './bot-registry.js'
import {
  type CliId,
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
} from '../cli/types.js'

export { CODEX_REASONING_EFFORTS, type CodexReasoningEffort }

export interface CliModelOverride {
  baseUrl?: string
  apiKey?: string
  model?: string
  thinkingLevel?: string
  updatedAt: string
}

export type BotModelOverride = Partial<Record<CliId, CliModelOverride>>
export type BotModelOverrides = Record<string, BotModelOverride>

const SingleCliOverrideSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    thinkingLevel: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict()

const ModernBotOverrideSchema = z
  .object({
    claude: SingleCliOverrideSchema.optional(),
    codex: SingleCliOverrideSchema.optional(),
  })
  .strict()

const BotEntryOverrideSchema = z.union([
  ModernBotOverrideSchema,
  SingleCliOverrideSchema,
])

const BotModelOverridesFileSchema = z.record(z.string(), BotEntryOverrideSchema)

const cleanOptString = (val: unknown): string | undefined => {
  if (typeof val !== 'string') return undefined
  const trimmed = val.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export type ConfigSource = 'override' | 'env' | 'default'
export type ApiKeySource = 'override' | 'env' | 'none'

export const CLAUDE_THINKING_PRESETS = [
  'low',
  'medium',
  'high',
  'max',
  'ultrathink',
  'off',
  'none',
  '0',
] as const

export interface ThinkingLevelValidationResult {
  valid: boolean
  normalized?: string
  error?: string
}

export const validateThinkingLevel = (
  cliId: CliId,
  value: string | undefined,
): ThinkingLevelValidationResult => {
  if (!value || !value.trim()) {
    return { valid: true, normalized: undefined }
  }
  const raw = value.trim()
  const lower = raw.toLowerCase()

  if (cliId === 'codex') {
    if ((CODEX_REASONING_EFFORTS as readonly string[]).includes(lower)) {
      return { valid: true, normalized: lower }
    }
    return {
      valid: false,
      error: `Codex 推理等级仅支持 ${CODEX_REASONING_EFFORTS.join('、')}（当前输入: "${raw}"）`,
    }
  }

  // cliId === 'claude'
  if ((CLAUDE_THINKING_PRESETS as readonly string[]).includes(lower)) {
    return { valid: true, normalized: lower }
  }
  if (/^\d+$/.test(raw)) {
    const num = Number.parseInt(raw, 10)
    if (num >= 0 && num <= 1_000_000) {
      return { valid: true, normalized: raw }
    }
  }
  return {
    valid: false,
    error: `Claude 思考等级仅支持 low、high、max 或正整数 Token 预算（当前输入: "${raw}"）`,
  }
}

export interface EffectiveBotModelConfig {
  baseUrl: string
  hasApiKey: boolean
  maskedApiKey: string
  model: string
  thinkingLevel: string
  customOverride?: {
    baseUrl?: string
    hasApiKey: boolean
    maskedApiKey?: string
    model?: string
    thinkingLevel?: string
  }
  source: {
    baseUrl: ConfigSource
    apiKey: ApiKeySource
    model: ConfigSource
    thinkingLevel: ConfigSource
  }
}

export interface AccessCheckResult {
  allowed: boolean
  reason?: string
}

export const checkModelConfigAccess = (
  operatorOpenId: string,
  ownerOpenId: string | undefined = process.env.OWNER_OPEN_ID,
): AccessCheckResult => {
  const configuredOwner = ownerOpenId?.trim()
  if (!configuredOwner) {
    return {
      allowed: false,
      reason:
        '系统未配置 OWNER_OPEN_ID 管理员凭据，禁止调整模型配置。请先在 .env 中设置 OWNER_OPEN_ID。',
    }
  }

  if (operatorOpenId.trim() !== configuredOwner) {
    return {
      allowed: false,
      reason: '只有管理员可以配置角色模型与端点。',
    }
  }

  return { allowed: true }
}

export const maskApiKey = (key: string | undefined): string => {
  if (!key) return ''
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '********'
  const start = trimmed.slice(0, 3)
  const end = trimmed.slice(-4)
  return `${start}******${end}`
}

export class JsonModelConfigStore {
  private overrides: BotModelOverrides = {}
  private readonly originalCliEnvs = new Map<string, Record<string, string>>()
  private writeQueue: Promise<void> = Promise.resolve()
  private watching = false

  constructor(private readonly filePath: string) {}

  async load(botConfigs: BotConfig[]): Promise<void> {
    for (const config of botConfigs) {
      if (!this.originalCliEnvs.has(config.id)) {
        this.originalCliEnvs.set(config.id, { ...config.cliEnv })
      }
    }

    await this.reload(botConfigs)

    if (!this.watching) {
      this.watching = true
      watchFile(this.filePath, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
        void this.reload(botConfigs)
      })
    }
  }

  async reload(botConfigs: BotConfig[]): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const raw = JSON.parse(content) as unknown

      const parseResult = BotModelOverridesFileSchema.safeParse(raw)
      if (!parseResult.success) {
        const errorDetails = parseResult.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')

        console.warn(
          `[ModelConfigStore] 模型配置文件结构校验失败: ${errorDetails}，保留最后一次有效配置`,
        )
        return
      }

      const migrated: BotModelOverrides = {}

      for (const [botId, val] of Object.entries(parseResult.data)) {
        if (!val || typeof val !== 'object') continue

        // 兼容处理：若旧数据直接在 botId 下包含 baseUrl/apiKey/model/thinkingLevel
        if (
          'baseUrl' in val ||
          'apiKey' in val ||
          'model' in val ||
          'thinkingLevel' in val
        ) {
          const bot = botConfigs.find((b) => b.id === botId)
          const targetCli: CliId = bot?.defaultCliId ?? 'claude'
          const cleanThinking = cleanOptString(val.thinkingLevel)

          if (cleanThinking) {
            const v = validateThinkingLevel(targetCli, cleanThinking)
            if (!v.valid) {
              console.warn(
                `[ModelConfigStore] 角色 ${botId} 的思考等级 "${cleanThinking}" 校验失败: ${v.error}，保留最后一次有效配置`,
              )
              return
            }
          }

          migrated[botId] = {
            [targetCli]: {
              baseUrl: cleanOptString(val.baseUrl),
              apiKey: cleanOptString(val.apiKey),
              model: cleanOptString(val.model),
              thinkingLevel: cleanThinking,
              updatedAt: val.updatedAt ?? new Date().toISOString(),
            },
          }
        } else {
          const botOverride: BotModelOverride = {}

          const modernVal = val as {
            claude?: z.infer<typeof SingleCliOverrideSchema>
            codex?: z.infer<typeof SingleCliOverrideSchema>
          }

          for (const cliId of ['claude', 'codex'] as const) {
            const cliVal = modernVal[cliId]
            if (!cliVal) continue

            const cleanThinking = cleanOptString(cliVal.thinkingLevel)
            if (cleanThinking) {
              const v = validateThinkingLevel(cliId, cleanThinking)
              if (!v.valid) {
                console.warn(
                  `[ModelConfigStore] 角色 ${botId} 的 ${cliId} 思考等级 "${cleanThinking}" 校验失败: ${v.error}，保留最后一次有效配置`,
                )
                return
              }
            }

            botOverride[cliId] = {
              baseUrl: cleanOptString(cliVal.baseUrl),
              apiKey: cleanOptString(cliVal.apiKey),
              model: cleanOptString(cliVal.model),
              thinkingLevel: cleanThinking,
              updatedAt: cliVal.updatedAt ?? new Date().toISOString(),
            }
          }

          migrated[botId] = botOverride
        }
      }

      this.overrides = migrated
      this.applyToBotConfigs(botConfigs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.overrides = {}
        this.applyToBotConfigs(botConfigs)
      } else {
        console.warn(
          `[ModelConfigStore] 读取或解析模型配置文件失败: ${(error as Error).message}，保留最后一次有效配置`,
        )
      }
    }
  }

  get(botId: string, cliId: CliId): CliModelOverride | undefined {
    return this.overrides[botId]?.[cliId]
  }

  getBotOverrides(botId: string): BotModelOverride | undefined {
    return this.overrides[botId]
  }

  getAll(): BotModelOverrides {
    return { ...this.overrides }
  }

  getEffectiveConfig(
    config: BotConfig,
    cliId: CliId = config.defaultCliId,
  ): EffectiveBotModelConfig {
    const botOverride = this.overrides[config.id]
    const cliOverride = botOverride?.[cliId]
    const original = this.originalCliEnvs.get(config.id) ?? config.cliEnv

    if (cliId === 'claude') {
      const customBaseUrl = cliOverride?.baseUrl?.trim()

      const envBaseUrl =
        original.ANTHROPIC_BASE_URL?.trim() ||
        process.env.ANTHROPIC_BASE_URL?.trim()

      const baseUrl = customBaseUrl || envBaseUrl || ''

      const baseUrlSource: ConfigSource = customBaseUrl
        ? 'override'
        : envBaseUrl
          ? 'env'
          : 'default'

      const customApiKey = cliOverride?.apiKey?.trim()

      const envApiKey =
        original.ANTHROPIC_AUTH_TOKEN?.trim() ||
        original.ANTHROPIC_API_KEY?.trim() ||
        process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
        process.env.ANTHROPIC_API_KEY?.trim()

      const apiKey = customApiKey || envApiKey || ''

      const apiKeySource: ApiKeySource = customApiKey
        ? 'override'
        : envApiKey
          ? 'env'
          : 'none'

      const customModel = cliOverride?.model?.trim()

      const envModel =
        original.ANTHROPIC_MODEL?.trim() || process.env.ANTHROPIC_MODEL?.trim()

      const model = customModel || envModel || ''

      const modelSource: ConfigSource = customModel
        ? 'override'
        : envModel
          ? 'env'
          : 'default'

      const customThinking = cliOverride?.thinkingLevel?.trim()

      const envThinking =
        original.MAX_THINKING_TOKENS?.trim() ||
        process.env.MAX_THINKING_TOKENS?.trim()

      const thinkingLevel = customThinking || envThinking || ''

      const thinkingSource: ConfigSource = customThinking
        ? 'override'
        : envThinking
          ? 'env'
          : 'default'

      return {
        baseUrl,
        hasApiKey: Boolean(apiKey),
        maskedApiKey: maskApiKey(apiKey),
        model,
        thinkingLevel,
        customOverride: {
          baseUrl: cliOverride?.baseUrl,
          hasApiKey: Boolean(cliOverride?.apiKey?.trim()),
          maskedApiKey: maskApiKey(cliOverride?.apiKey),
          model: cliOverride?.model,
          thinkingLevel: cliOverride?.thinkingLevel,
        },
        source: {
          baseUrl: baseUrlSource,
          apiKey: apiKeySource,
          model: modelSource,
          thinkingLevel: thinkingSource,
        },
      }
    }

    // codex
    const customBaseUrl = cliOverride?.baseUrl?.trim()

    const envBaseUrl =
      original.OPENAI_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim()

    const baseUrl = customBaseUrl || envBaseUrl || ''

    const baseUrlSource: ConfigSource = customBaseUrl
      ? 'override'
      : envBaseUrl
        ? 'env'
        : 'default'

    const customApiKey = cliOverride?.apiKey?.trim()

    const envApiKey =
      original.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()

    const apiKey = customApiKey || envApiKey || ''

    const apiKeySource: ApiKeySource = customApiKey
      ? 'override'
      : envApiKey
        ? 'env'
        : 'none'

    const customModel = cliOverride?.model?.trim()

    const envModel =
      original.OPENAI_MODEL?.trim() ||
      original.CODEX_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      process.env.CODEX_MODEL?.trim()

    const model = customModel || envModel || ''

    const modelSource: ConfigSource = customModel
      ? 'override'
      : envModel
        ? 'env'
        : 'default'

    const customThinking = cliOverride?.thinkingLevel?.trim()

    const envThinking =
      original.CODEX_REASONING_EFFORT?.trim() ||
      original.OPENAI_REASONING_EFFORT?.trim() ||
      process.env.CODEX_REASONING_EFFORT?.trim() ||
      process.env.OPENAI_REASONING_EFFORT?.trim()

    const thinkingLevel = customThinking || envThinking || ''

    const thinkingSource: ConfigSource = customThinking
      ? 'override'
      : envThinking
        ? 'env'
        : 'default'

    return {
      baseUrl,
      hasApiKey: Boolean(apiKey),
      maskedApiKey: maskApiKey(apiKey),
      model,
      thinkingLevel,
      customOverride: {
        baseUrl: cliOverride?.baseUrl,
        hasApiKey: Boolean(cliOverride?.apiKey?.trim()),
        maskedApiKey: maskApiKey(cliOverride?.apiKey),
        model: cliOverride?.model,
        thinkingLevel: cliOverride?.thinkingLevel,
      },
      source: {
        baseUrl: baseUrlSource,
        apiKey: apiKeySource,
        model: modelSource,
        thinkingLevel: thinkingSource,
      },
    }
  }

  async save(
    botId: string,
    cliId: CliId,
    patch: {
      baseUrl?: string
      apiKey?: string
      model?: string
      thinkingLevel?: string
    },
    botConfigs: BotConfig[],
  ): Promise<CliModelOverride | undefined> {
    const existingBot = this.overrides[botId] ?? {}
    const existingCli = existingBot[cliId]

    // 规范化：空字符串视为取消该项自定义覆盖
    const cleanBaseUrl =
      patch.baseUrl !== undefined
        ? patch.baseUrl.trim() || undefined
        : existingCli?.baseUrl

    // API Key 留空表示沿用已保存密钥
    const cleanApiKey =
      patch.apiKey !== undefined
        ? patch.apiKey.trim() || existingCli?.apiKey
        : existingCli?.apiKey

    const cleanModel =
      patch.model !== undefined
        ? patch.model.trim() || undefined
        : existingCli?.model

    let cleanThinking =
      patch.thinkingLevel !== undefined
        ? patch.thinkingLevel.trim() || undefined
        : existingCli?.thinkingLevel

    if (cleanThinking) {
      const validation = validateThinkingLevel(cliId, cleanThinking)
      if (!validation.valid) {
        throw new Error(validation.error)
      }
      cleanThinking = validation.normalized
    }

    if (!cleanBaseUrl && !cleanApiKey && !cleanModel && !cleanThinking) {
      delete existingBot[cliId]
      if (Object.keys(existingBot).length === 0) {
        delete this.overrides[botId]
      } else {
        this.overrides[botId] = existingBot
      }
      await this.persist()
      this.applyToBotConfigs(botConfigs)
      return undefined
    }

    const updatedCli: CliModelOverride = {
      baseUrl: cleanBaseUrl,
      apiKey: cleanApiKey,
      model: cleanModel,
      thinkingLevel: cleanThinking,
      updatedAt: new Date().toISOString(),
    }

    this.overrides[botId] = {
      ...existingBot,
      [cliId]: updatedCli,
    }

    await this.persist()
    this.applyToBotConfigs(botConfigs)
    return updatedCli
  }

  async reset(
    botId: string,
    cliId: CliId,
    botConfigs: BotConfig[],
  ): Promise<boolean> {
    const existingBot = this.overrides[botId]
    if (!existingBot || !existingBot[cliId]) return false

    delete existingBot[cliId]
    if (Object.keys(existingBot).length === 0) {
      delete this.overrides[botId]
    } else {
      this.overrides[botId] = existingBot
    }

    await this.persist()
    this.applyToBotConfigs(botConfigs)
    return true
  }

  applyToBotConfigs(botConfigs: BotConfig[]): void {
    for (const config of botConfigs) {
      const original = this.originalCliEnvs.get(config.id) ?? {
        ...config.cliEnv,
      }

      const botOverride = this.overrides[config.id]
      if (!botOverride) {
        config.cliEnv = { ...original }
        continue
      }

      const nextEnv = { ...original }

      // Claude Code 覆盖只注入 ANTHROPIC_*，避免污染 OpenAI 端点
      const claude = botOverride.claude
      if (claude) {
        if (claude.baseUrl) {
          nextEnv.ANTHROPIC_BASE_URL = claude.baseUrl
        }
        if (claude.apiKey) {
          nextEnv.ANTHROPIC_AUTH_TOKEN = claude.apiKey
          nextEnv.ANTHROPIC_API_KEY = claude.apiKey
        }
        if (claude.model) {
          nextEnv.ANTHROPIC_MODEL = claude.model
          nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = claude.model
          nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = claude.model
          nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = claude.model
          nextEnv.ANTHROPIC_DEFAULT_FABLE_MODEL = claude.model
          nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = claude.model
          nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = claude.model
          nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = claude.model
          nextEnv.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = claude.model
        }
        if (claude.thinkingLevel) {
          const validation = validateThinkingLevel(
            'claude',
            claude.thinkingLevel,
          )

          if (validation.valid && validation.normalized) {
            const raw = validation.normalized
            let tokenBudget: string | undefined
            if (raw === 'max' || raw === 'ultrathink') tokenBudget = '31999'
            else if (raw === 'high') tokenBudget = '16000'
            else if (raw === 'medium') tokenBudget = '8000'
            else if (raw === 'low') tokenBudget = '4000'
            else if (raw === 'off' || raw === 'none' || raw === '0')
              tokenBudget = '0'
            else if (/^\d+$/.test(raw)) tokenBudget = raw

            if (tokenBudget !== undefined) {
              nextEnv.MAX_THINKING_TOKENS = tokenBudget
            }
          }
        }
      }

      // Codex 覆盖只注入 OPENAI_*，避免污染 Anthropic 端点
      const codex = botOverride.codex
      if (codex) {
        if (codex.baseUrl) {
          nextEnv.OPENAI_BASE_URL = codex.baseUrl
        }
        if (codex.apiKey) {
          nextEnv.OPENAI_API_KEY = codex.apiKey
        }
        if (codex.model) {
          nextEnv.OPENAI_MODEL = codex.model
          nextEnv.CODEX_MODEL = codex.model
        }
        if (codex.thinkingLevel) {
          const validation = validateThinkingLevel('codex', codex.thinkingLevel)
          if (validation.valid && validation.normalized) {
            nextEnv.CODEX_REASONING_EFFORT = validation.normalized
            nextEnv.OPENAI_REASONING_EFFORT = validation.normalized
          }
        }
      }

      config.cliEnv = nextEnv
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.overrides, null, 2)

    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp.${Date.now()}`
      await writeFile(tempPath, `${snapshot}\n`, 'utf8')
      await rename(tempPath, this.filePath)
    }

    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}
