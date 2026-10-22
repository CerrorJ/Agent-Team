import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

interface CommandPlan {
  command: string
  prefix: string[]
}

/** 只识别受支持 CLI 的已知 npm 布局；拒绝将任意 .cmd 交给 shell 解释。 */
export const windowsCommand = (
  command: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): CommandPlan => {
  if (/\.(exe|com)$/i.test(command)) return { command, prefix: [] }

  const environment = options.env ?? process.env

  const directories = isAbsolute(command)
    ? [dirname(command)]
    : windowsSearchPath(environment)

  for (const directory of directories) {
    const absoluteDirectory = resolve(
      options.cwd ?? process.cwd(),
      directory.replace(/^"|"$/g, ''),
    )

    const executable = join(absoluteDirectory, `${command}.exe`)
    if (existsSync(executable)) return { command: executable, prefix: [] }
    const known = knownNpmCommand(absoluteDirectory, command)
    if (known) return known
  }
  throw new Error(
    `CLI_UNAVAILABLE: ${command} 没有可安全启动的原生程序或受支持的 npm 安装`,
  )
}

const windowsSearchPath = (environment: NodeJS.ProcessEnv): string[] => {
  // 与 Node 的 Windows 环境处理一致，大小写重复键按字典序取第一项。
  const pathKey = Object.keys(environment)
    .sort()
    .find((key) => key.toUpperCase() === 'PATH')

  return (environment[pathKey ?? 'PATH'] ?? '').split(delimiter)
}

const knownNpmCommand = (
  directory: string,
  command: string,
): CommandPlan | undefined => {
  if (command === 'claude') {
    const executable = join(
      directory,
      'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    )

    if (existsSync(executable)) return { command: executable, prefix: [] }
  }
  if (command === 'codex') {
    const script = join(directory, 'node_modules/@openai/codex/bin/codex.js')
    if (existsSync(script)) return { command: 'node.exe', prefix: [script] }
  }
  return undefined
}
