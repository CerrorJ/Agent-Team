import type { CliId } from '../cli/types.js'

export interface FetchModelsOptions {
  cliId: CliId
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}

export interface FetchModelsResult {
  success: boolean
  models: string[]
  error?: string
}

const DEFAULT_TIMEOUT_MS = 8_000

const extractModelIds = (json: unknown): string[] => {
  if (!json || typeof json !== 'object') return []
  const raw = json as Record<string, unknown>
  let list: unknown[] = []

  if (Array.isArray(raw.data)) {
    list = raw.data
  } else if (Array.isArray(raw.models)) {
    list = raw.models
  } else if (Array.isArray(json)) {
    list = json
  }

  const result: string[] = []

  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      result.push(item.trim())
    } else if (item && typeof item === 'object') {
      const id = (item as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim()) {
        result.push(id.trim())
      }
    }
  }

  return Array.from(new Set(result))
}

const sortModelsForCli = (models: string[], cliId: CliId): string[] => {
  const isPriority = (m: string): number => {
    const lower = m.toLowerCase()
    if (cliId === 'claude') {
      if (lower.includes('claude-3-7') || lower.includes('glm-5')) return 1
      if (lower.includes('claude-3-5') || lower.includes('glm-4')) return 2
      if (lower.includes('claude') || lower.includes('glm')) return 3
      return 10
    }
    // codex
    if (lower.includes('gpt-5') || lower.includes('o3') || lower.includes('o1'))
      return 1
    if (lower.includes('gpt-4o') || lower.includes('codex')) return 2
    if (lower.includes('gpt') || lower.includes('deepseek')) return 3
    return 10
  }

  return [...models].sort((a, b) => {
    const pA = isPriority(a)
    const pB = isPriority(b)
    if (pA !== pB) return pA - pB
    return a.localeCompare(b)
  })
}

export const fetchAvailableModels = async (
  options: FetchModelsOptions,
): Promise<FetchModelsResult> => {
  const { cliId, baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const cleanBase = baseUrl.trim().replace(/\/+$/, '')

  if (!cleanBase) {
    return {
      success: false,
      models: [],
      error: 'Base URL 为空，无法探测模型。',
    }
  }

  const candidateUrls: string[] = []

  if (cliId === 'claude') {
    if (cleanBase.endsWith('/v1')) {
      candidateUrls.push(`${cleanBase}/models`)
    } else {
      candidateUrls.push(`${cleanBase}/v1/models`, `${cleanBase}/models`)
    }
  } else {
    // codex / openai
    if (cleanBase.endsWith('/v1')) {
      candidateUrls.push(`${cleanBase}/models`)
    } else {
      candidateUrls.push(`${cleanBase}/models`, `${cleanBase}/v1/models`)
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }

  if (apiKey?.trim()) {
    const key = apiKey.trim()
    headers.Authorization = `Bearer ${key}`
    if (cliId === 'claude') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    }
  }

  let lastError = '未知错误'

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        lastError = `HTTP ${response.status} (${response.statusText})`
        continue
      }

      const data = (await response.json()) as unknown
      const models = extractModelIds(data)

      if (models.length > 0) {
        return {
          success: true,
          models: sortModelsForCli(models, cliId),
        }
      }

      lastError = '端点返回了空模型列表。'
    } catch (err) {
      lastError = (err as Error).message
    }
  }

  return {
    success: false,
    models: [],
    error: `无法从端点获取模型列表: ${lastError}`,
  }
}
