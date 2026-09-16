// agent-team 部署 CLI：pm2 常驻封装（doctor / start / stop / restart / status / logs）。
// 用法见 SETUP.md；生产部署执行 pnpm agent-team <命令>。
import { cac } from 'cac'
import { existsSync } from 'node:fs'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'

const cli = cac('agent-team')

const runCommandSync = (
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) => {
  if (process.platform === 'win32') {
    return spawnSync(command, args, { ...options, shell: true })
  }
  return spawnSync(command, args, options)
}

const run = (parts: string[]): void => {
  const result = runCommandSync(parts[0], parts.slice(1), { stdio: 'inherit' })
  if (result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`
    console.error(`[agent-team] 命令执行失败: ${parts[0]} ${reason}`)
    process.exit(result.status ?? 1)
  }
}

// CC Switch 的 Claude 配置保存在用户级配置文件中。若 PM2 从切换前的终端
// 继承了 ANTHROPIC_*，这些环境变量会覆盖 CC Switch 的当前选择并永久留在守护进程里。
// CEO 的专属模型变量会在实际执行 CLI 时由 bot 配置单独注入，因此不依赖这里的继承值。
const runtimeEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_')) delete env[name]
  }
  return env
}

const output = (parts: string[]): string => {
  const result = runCommandSync(parts[0], parts.slice(1), { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout ?? '').trim() : ''
}

const ensureBuild = (): void => {
  if (existsSync('dist/index.js')) return
  console.log('[agent-team] 未找到 dist/index.js，先执行 pnpm build')
  run(['pnpm', 'build'])
}

const requirePm2 = (): void => {
  if (!output(['pm2', '-v'])) {
    console.error('[agent-team] pm2 未安装，请先执行 npm install -g pm2')
    process.exit(1)
  }
}

const requireConfig = (): void => {
  const missing: string[] = []
  if (!existsSync('.env')) missing.push('.env')
  if (!existsSync('config/bots.json')) missing.push('config/bots.json')
  if (missing.length) {
    console.error(`[agent-team] 缺少运行配置: ${missing.join(', ')}`)
    console.error(
      '[agent-team] 请先从开发环境复制 .env 和 config/bots.json 到当前目录',
    )
    process.exit(1)
  }
}

const localDoctor = (): void => {
  const checks: Array<[string, string[]]> = [
    ['node', ['-v']],
    ['pnpm', ['-v']],
    ['pm2', ['-v']],
    ['claude', ['--version']],
    ['codex', ['--version']],
  ]

  for (const [name, checkArgs] of checks) {
    const value = output([name, ...checkArgs])
    console.log(`${name}: ${value || '未安装'}`)
  }
  console.log(`.env: ${existsSync('.env') ? '存在' : '缺失'}`)
  console.log(
    `config/bots.json: ${existsSync('config/bots.json') ? '存在' : '缺失'}`,
  )
}

const localStart = (): void => {
  requirePm2()
  requireConfig()
  ensureBuild()

  // 每次都重建 PM2 条目，防止 --update-env 保留已经从 CC Switch 移除的旧变量。
  // 会话与定时任务都在本地持久化文件中，重建进程不会丢失它们。
  const running =
    runCommandSync('pm2', ['describe', 'agent-team'], { stdio: 'ignore' })
      .status === 0

  if (running) {
    run(['pm2', 'delete', 'agent-team'])
  }

  const result = runCommandSync(
    'pm2',
    ['start', 'dist/index.js', '--name', 'agent-team'],
    { stdio: 'inherit', env: runtimeEnvironment() },
  )

  if (result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`
    console.error(`[agent-team] 命令执行失败: pm2 start ${reason}`)
    process.exit(result.status ?? 1)
  }
  run(['pm2', 'save'])
}

cli.command('doctor', '检查本地环境与 CLI 凭证').action(localDoctor)
cli.command('start', '本地生产启动').action(localStart)
cli.command('stop', '停止本地进程').action(() => {
  requirePm2()
  run(['pm2', 'stop', 'agent-team'])
})
cli.command('restart', '重启本地进程').action(localStart)
cli.command('status', '查看本地进程状态').action(() => {
  requirePm2()
  run(['pm2', 'status'])
})
cli.command('logs', '查看本地进程日志').action(() => {
  requirePm2()
  run(['pm2', 'logs', 'agent-team'])
})

cli.help()
cli.parse()
