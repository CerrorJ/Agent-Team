import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BotConfig } from './bot-registry.js'
import type { CliId } from '../cli/types.js'

export interface CliModelOverride {
  baseUrl?: string
  apiKey?: string
  model?: string
  updatedAt: string
}

export type BotModelOverride = Partial<Record<CliId, CliModelOverride>>
export type BotModelOverrides = Record<string, BotModelOverride>

export interface EffectiveBotModelConfig {
  baseUrl: string
  hasApiKey: boolean
  maskedApiKey: string
  model: string
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

  constructor(private readonly filePath: string) {}

  async load(botConfigs: BotConfig[]): Promise<void> {
    for (const config of botConfigs) {
      if (!this.originalCliEnvs.has(config.id)) {
        this.originalCliEnvs.set(config.id, { ...config.cliEnv })
      }
    }

    try {
      const content = await readFile(this.filePath, 'utf8')
      const raw = JSON.parse(content) as Record<string, any>
      const migrated: BotModelOverrides = {}

      for (const [botId, val] of Object.entries(raw)) {
        if (!val || typeof val !== 'object') continue
        // 兼容处理：若旧数据直接在 botId 下包含 baseUrl/apiKey/model，迁移到 defaultCliId
        if ('baseUrl' in val || 'apiKey' in val || 'model' in val) {
          const bot = botConfigs.find((b) => b.id === botId)
          const targetCli = bot?.defaultCliId ?? 'claude'
          migrated[botId] = {
            [targetCli]: {
              baseUrl: val.baseUrl,
              apiKey: val.apiKey,
              model: val.model,
              updatedAt: val.updatedAt ?? new Date().toISOString(),
            },
          }
        } else {
          migrated[botId] = val as BotModelOverride
        }
      }
      this.overrides = migrated
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.overrides = {}
      } else {
        console.warn(
          `[ModelConfigStore] 读取模型配置文件失败: ${(error as Error).message}，使用默认配置`,
        )
        this.overrides = {}
      }
    }

    this.applyToBotConfigs(botConfigs)
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
      const baseUrl =
        cliOverride?.baseUrl || (original.ANTHROPIC_BASE_URL ?? '')

      const apiKey =
        cliOverride?.apiKey ||
        original.ANTHROPIC_AUTH_TOKEN ||
        original.ANTHROPIC_API_KEY ||
        ''

      const model = cliOverride?.model || (original.ANTHROPIC_MODEL ?? '')
      return {
        baseUrl,
        hasApiKey: Boolean(apiKey.trim()),
        maskedApiKey: maskApiKey(apiKey),
        model,
      }
    }

    // codex
    const baseUrl = cliOverride?.baseUrl || (original.OPENAI_BASE_URL ?? '')
    const apiKey = cliOverride?.apiKey || (original.OPENAI_API_KEY ?? '')

    const model =
      cliOverride?.model || original.OPENAI_MODEL || original.CODEX_MODEL || ''

    return {
      baseUrl,
      hasApiKey: Boolean(apiKey.trim()),
      maskedApiKey: maskApiKey(apiKey),
      model,
    }
  }

  async save(
    botId: string,
    cliId: CliId,
    patch: { baseUrl?: string; apiKey?: string; model?: string },
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

    if (!cleanBaseUrl && !cleanApiKey && !cleanModel) {
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
