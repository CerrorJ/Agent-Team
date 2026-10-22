import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

export interface ProcessStopReport {
  method: 'windows-taskkill'
  outcome: 'confirmed' | 'failed' | 'timeout'
  exitCode: number | null
  errorCode: string | null
  durationMs: number
}

const groupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 只终止本次创建的子进程树/进程组，不对恢复时来源不明的 PID 执行终止。 */
export const terminateCli = async (
  child: ChildProcess,
  report?: (result: ProcessStopReport) => void,
): Promise<boolean> => {
  if (!child.pid) return false
  if (process.platform === 'win32')
    return terminateWindowsTree(child.pid, report)
  const pid = child.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!groupExists(pid)) return true
    await delay(100)
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return !groupExists(pid)
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!groupExists(pid)) return true
    await delay(100)
  }
  return false
}

const terminateWindowsTree = (
  pid: number,
  report?: (result: ProcessStopReport) => void,
): Promise<boolean> =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    let completed = false

    const finish = (
      result: Omit<ProcessStopReport, 'method' | 'durationMs'>,
    ) => {
      if (completed) return
      completed = true
      report?.({
        ...result,
        method: 'windows-taskkill',
        durationMs: Date.now() - startedAt,
      })
      resolve(result.outcome === 'confirmed')
    }

    // 不从任务工作目录或 CLI 的 PATH 查找系统终止工具。
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    )

    const killer = spawn(executable, ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    })

    const timer = setTimeout(() => {
      killer.kill()
      finish({ outcome: 'timeout', exitCode: null, errorCode: null })
    }, 7_000)

    killer.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish({
        outcome: 'failed',
        exitCode: null,
        errorCode: error.code ?? 'UNKNOWN',
      })
    })
    killer.once('close', (code) => {
      clearTimeout(timer)
      finish({
        outcome: code === 0 ? 'confirmed' : 'failed',
        exitCode: code,
        errorCode: null,
      })
    })
  })
