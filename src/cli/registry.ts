import { ClaudeAdapter } from './claude-adapter.js'
import { CodexAdapter } from './codex-adapter.js'
import type { CliAdapter, CliId } from './types.js'
// 按 ID 取适配器、列出当前支持的引擎、校验环境变量
const adapters: Record<CliId, CliAdapter> = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
}

export const getCliAdapter = (id: CliId): CliAdapter => adapters[id]

export const listCliAdapters = (): CliAdapter[] => Object.values(adapters)

export const parseCliId = (value: string | undefined): CliId => {
    if (!value) return 'claude'
    if (value === 'claude' || value === 'codex') return value
    throw new Error(`不支持的 DEFAULT_CLI: ${value}，请填写 claude 或 codex`)
}
