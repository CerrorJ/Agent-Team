import { execFileSync } from 'node:child_process'

/** 仅供内核构造参数；禁用可选索引写锁与外部fsmonitor，不经过shell。 */
export const runGitCommand = (
  cwd: string,
  args: string[],
  options: { raw?: boolean; input?: string; timeoutMs?: number } = {},
): string => {
  const output = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 1_000_000,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.input === undefined ? {} : { input: options.input }),
    },
  )

  return options.raw ? output : output.trim()
}
