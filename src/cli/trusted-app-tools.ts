/** 由内核生成的受信 stdio 服务；不接收页面提供的命令、脚本或环境变量。 */
export interface TrustedAppTools {
  command: string
  args: string[]
  env: Record<string, string>
}

export const codexTrustedToolArgs = (tools: TrustedAppTools): string[] => {
  const environment = Object.entries(tools.env)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(',')

  return [
    '-c',
    `mcp_servers.agent_team={command=${JSON.stringify(tools.command)},args=${JSON.stringify(tools.args)},env={${environment}},required=true,startup_timeout_sec=15}`,
  ]
}
