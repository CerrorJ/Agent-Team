import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { windowsCommand } from './windows-command.js'

// 在 Windows 上把子进程连同进程树一起杀掉，避免 cmd 被杀后 claude.exe/codex.exe 变孤儿继续跑。
export const killCli = (
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void => {
  if (!child.pid) {
    child.kill(signal)
    return
  }
  if (process.platform !== 'win32') {
    child.kill(signal)
    return
  }

  try {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })

    killer.on('error', () => {
      child.kill(signal)
    })
    killer.on('close', (code) => {
      if (code !== 0) {
        child.kill(signal)
      }
    })
  } catch {
    child.kill(signal)
  }
}

interface SpawnCli {
  (
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: ['ignore', 'pipe', 'pipe'] },
  ): ChildProcessByStdio<null, Readable, Readable>
  (
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
  ): ChildProcessByStdio<Writable, Readable, Readable>
}

export const spawnCli = ((
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions['stdio'] },
): ChildProcess => {
  if (process.platform !== 'win32') {
    return spawn(command, args, { ...options, shell: false })
  }
  // 解析原生程序或已知 npm 入口，参数始终作为数组传递，避免空格路径与命令注入。
  // 注意：Windows 下不可将 signal 直接传给 Node.js 的 spawn。
  // 否则 Node 会在 abort 时直接 TerminateProcess 杀掉最外层的 cmd.exe 外壳，
  // 导致其子进程（claude/codex/bash/python）瞬间脱壳变成孤儿进程继续在后台运行；
  // 随后 killCli 调用 taskkill /pid 时也会因 cmd.exe 已经死亡而无法顺着树杀死子孙进程。
  // 因此 Windows 下剔除 options.signal，完全交由上层 abort 事件监听器调用 killCli 进行整树杀死。
  const { signal: _signal, ...restOptions } = options
  const plan = windowsCommand(command)
  return spawn(plan.command, [...plan.prefix, ...args], {
    ...restOptions,
    shell: false,
    windowsHide: true,
  })
}) as SpawnCli
