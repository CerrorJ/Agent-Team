import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const groupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 只终止本次创建的子进程树/进程组，不对恢复时来源不明的 PID 执行终止。 */
export const terminateCli = async (child: ChildProcess): Promise<boolean> => {
  if (!child.pid) return false
  if (process.platform === 'win32') return terminateWindowsTree(child.pid)
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

const terminateWindowsTree = (pid: number): Promise<boolean> =>
  new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    })

    const timer = setTimeout(() => {
      killer.kill()
      resolve(false)
    }, 7_000)

    killer.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    killer.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
