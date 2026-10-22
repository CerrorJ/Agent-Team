import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { windowsCommand } from '../cli/windows-command.js'

/** 只定位固定工具，不启动进程、不加载登录文件；发现文件不表示认证或执行已通过。 */
export const discoverTool = (
  command: 'git' | 'codex' | 'claude',
  environment: NodeJS.ProcessEnv = process.env,
): boolean => {
  try {
    if (process.platform === 'win32') {
      return statSync(
        windowsCommand(command, { env: environment }).command,
      ).isFile()
    }
    return (environment.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .some((directory) => {
        try {
          const path = join(directory, command)
          accessSync(path, constants.X_OK)
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}
