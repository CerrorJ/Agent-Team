import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLARIFICATION_TOOL_NAME = 'request_clarification'
export const PRODUCT_SPEC_TOOL_NAME = 'request_spec_approval'
export const DISPATCH_TASK_TOOL_NAME = 'dispatch_task'
export const REQUEST_APPROVAL_TOOL_NAME = 'request_approval'
export const SCHEDULE_MANAGE_TOOL_NAME = 'schedule_manage'
// Claude Code 会给 MCP 工具名加 mcp__<server>__ 前缀，事件里要用这个名字匹配
export const CLAUDE_CLARIFICATION_TOOL_NAME = `mcp__agent_team__${CLARIFICATION_TOOL_NAME}`
export const CLAUDE_PRODUCT_SPEC_TOOL_NAME = `mcp__agent_team__${PRODUCT_SPEC_TOOL_NAME}`
export const CLAUDE_DISPATCH_TASK_TOOL_NAME = `mcp__agent_team__${DISPATCH_TASK_TOOL_NAME}`
export const CLAUDE_REQUEST_APPROVAL_TOOL_NAME = `mcp__agent_team__${REQUEST_APPROVAL_TOOL_NAME}`
export const CLAUDE_SCHEDULE_MANAGE_TOOL_NAME = `mcp__agent_team__${SCHEDULE_MANAGE_TOOL_NAME}`

// 启动应用层 MCP 服务的命令行：开发态直接跑 .ts（借根目录的 tsx），编译产物用 node 跑 .js
const serverInvocation = (): { command: string; args: string[] } => {
  const runningFromTypeScript = import.meta.url.endsWith('.ts')

  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? '../mcp/app-tools-server.ts'
        : '../mcp/app-tools-server.js',
      import.meta.url,
    ),
  )

  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server] }
  }

  const tsxCli = fileURLToPath(
    new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  )

  return { command: process.execPath, args: [tsxCli, server] }
}

// Windows 的 cmd 会剥掉内联 JSON 的引号，使 Claude 把它误判为相对配置文件路径。
// Claude Code 同时支持 JSON 文件，因此统一落盘后传路径，避免转义差异。
const writeClaudeMcpConfig = (invocation: {
  command: string
  args: string[]
}): string => {
  const directory = join(process.cwd(), 'data')
  const filePath = join(directory, 'agent-team-mcp.json')

  const content = JSON.stringify(
    {
      mcpServers: {
        agent_team: {
          type: 'stdio',
          command: invocation.command,
          args: invocation.args,
        },
      },
    },
    null,
    2,
  )

  mkdirSync(directory, { recursive: true })
  writeFileSync(filePath, `${content}\n`, 'utf8')

  return filePath
}

// 两个 CLI 注册 stdio MCP 服务的方式不同：Claude Code 吃 --mcp-config 文件，
// Codex 只能用 -c 配置覆盖逐项展开。
export const claudeAppToolArgs = (): string[] => {
  const invocation = serverInvocation()
  return ['--mcp-config', writeClaudeMcpConfig(invocation)]
}

export const codexAppToolArgs = (): string[] => {
  const invocation = serverInvocation()
  return [
    '-c',
    `mcp_servers.agent_team.command=${JSON.stringify(invocation.command)}`,
    '-c',
    `mcp_servers.agent_team.args=${JSON.stringify(invocation.args)}`,
  ]
}
