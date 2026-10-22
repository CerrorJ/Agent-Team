import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative, resolve, isAbsolute, join } from 'node:path'
import type { Project, Run } from './business-contracts.js'

const git = (cwd: string, args: string[]): string =>
  execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()

export const inspectProjectRepository = (input: {
  repositoryPath: string
  defaultBranch: string
}) => {
  const { repositoryPath, root } = repositoryRoot(input.repositoryPath)

  if (relative(repositoryPath, root))
    throw new Error('GIT_ROOT_REQUIRED: 请选择仓库根目录')
  const baselineCommit = branchCommit(root, input.defaultBranch)

  let gitUrl = ''
  try {
    gitUrl = redactGitUrl(git(root, ['config', '--get', 'remote.origin.url']))
  } catch {
    /* 本地仓库可以没有 origin，不制造地址。 */
  }
  return { repositoryPath: root, gitUrl, baselineCommit }
}

/** 启动时再次预检，既有脏文件只报错，不 reset/clean 或隐式提交。 */
export const projectBaseline = (project: Project): string => {
  const inspected = inspectProjectRepository(project)
  if (git(inspected.repositoryPath, ['status', '--porcelain=v1'])) {
    throw new Error('GIT_DIRTY: 项目存在未提交改动，请先自行处理并保留文件')
  }
  return inspected.baselineCommit
}

export const runWorkDirectory = (input: {
  dataDirectory: string
  runId: string
}): string => {
  const base = resolve(input.dataDirectory, 'worktrees')
  const directory = resolve(base, input.runId)
  const path = relative(base, directory)
  if (!path || path.startsWith('..') || isAbsolute(path))
    throw new Error('INVALID_WORKSPACE: 执行目录越界')
  return directory
}

export const prepareRunWorktree = (input: {
  project: Project
  run: Run
  dataDirectory: string
}): void => {
  const { project, run } = input
  if (
    run.workDirectory !==
    runWorkDirectory({ dataDirectory: input.dataDirectory, runId: run.id })
  ) {
    throw new Error('INVALID_WORKSPACE: 执行目录与内核记录不一致')
  }
  if (projectBaseline(project) !== run.baselineCommit)
    throw new Error('GIT_BASELINE_CHANGED: 排队期间基准已改变，请创建新执行')
  if (existsSync(run.workDirectory))
    throw new Error('STATE_UNCERTAIN: 执行目录已存在，禁止覆盖或重放')
  // checkout 会触发 post-checkout；只对本次调用禁用，不能改写用户仓库配置。
  const hooks = mkdtempSync(join(tmpdir(), 'weftpilot-empty-hooks-'))
  try {
    git(project.repositoryPath, [
      '-c',
      `core.hooksPath=${hooks}`,
      'worktree',
      'add',
      '-b',
      run.executionBranch,
      run.workDirectory,
      run.baselineCommit,
    ])
  } finally {
    rmdirSync(hooks)
  }
}

/** 只在内核拥有的 worktree 捕获新文件差异，不暂存/改动用户主工作区。 */
export const collectRunDelivery = (
  run: Run,
): { diff: string; headCommit: string } => {
  git(run.workDirectory, ['add', '--intent-to-add', '--', '.'])

  const diff = git(run.workDirectory, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    'HEAD',
    '--',
    '.',
  ])

  if (diff.length > 500_000)
    throw new Error(
      'DELIVERY_TOO_LARGE: 代码差异超出当前交付上限，请查看执行目录',
    )
  return { diff, headCommit: git(run.workDirectory, ['rev-parse', 'HEAD']) }
}

const repositoryRoot = (path: string) => {
  try {
    const repositoryPath = realpathSync(path)

    const root = realpathSync(
      git(repositoryPath, ['rev-parse', '--show-toplevel']),
    )

    return { repositoryPath, root }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      existsSync(path)
    )
      throw new Error('GIT_UNAVAILABLE')
    throw new Error('GIT_ROOT_REQUIRED')
  }
}

const branchCommit = (root: string, branch: string) => {
  try {
    git(root, ['check-ref-format', '--branch', branch])
    return git(root, ['rev-parse', '--verify', `${branch}^{commit}`])
  } catch {
    throw new Error('GIT_BRANCH_INVALID')
  }
}

const redactGitUrl = (value: string): string => {
  try {
    const url = new URL(value)
    url.password = ''
    if (url.protocol === 'https:' || url.protocol === 'http:') url.username = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? '[invalid remote URL]'
      : value
  }
}
