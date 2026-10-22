import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Run } from './business-contracts.js'
import type { TrustedAppTools } from '../cli/trusted-app-tools.js'

export const runToolPolicy = (run: Run) => {
  const appTools = humanMcpRuntime(run)
  return {
    permission: run.roleSnapshot.permission,
    humanRequests:
      run.roleSnapshot.cli === 'claude' && run.purpose !== 'role_trial',
    ...(appTools ? { appTools } : {}),
  }
}

/** 打包态使用宿主内嵌 Node；开发态显式加载 tsx，均不依赖 PATH 中的另一份 Node。 */
export const humanMcpRuntime = (run: Run): TrustedAppTools | undefined => {
  if (run.purpose === 'role_trial' || run.roleSnapshot.cli !== 'codex')
    return undefined
  const development = import.meta.url.endsWith('.ts')

  const script = fileURLToPath(
    new URL(
      development ? './human-mcp-entry.ts' : './human-mcp-entry.js',
      import.meta.url,
    ),
  )

  if (!existsSync(script)) throw new Error('CAPABILITY_UNSUPPORTED')

  const args = development
    ? [
        fileURLToPath(
          new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
        ),
        script,
      ]
    : [script]

  return {
    command: process.execPath,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '',
      WEFTPILOT_MODEL_SECRET: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
    },
  }
}
