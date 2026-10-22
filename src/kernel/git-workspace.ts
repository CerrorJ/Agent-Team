import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { relative, resolve, isAbsolute, join } from 'node:path'
import type { Project, Run } from './business-contracts.js'

const git = (
  cwd: string,
  args: string[],
  raw = false,
  input?: string,
): string => {
  const output = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_000_000,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    },
  )

  return raw ? output : output.trim()
}

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
): {
  diff: string
  headCommit: string
  contributionDiff: string
  inputDeliveryIds: string[]
} => {
  git(run.workDirectory, ['add', '--intent-to-add', '--', '.'])

  const diff = git(
    run.workDirectory,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      run.baselineCommit,
      '--',
      '.',
    ],
    true,
  )

  if (diff.length > 500_000)
    throw new Error(
      'DELIVERY_TOO_LARGE: 代码差异超出当前交付上限，请查看执行目录',
    )

  const contributionDiff = run.inputTree
    ? git(
        run.workDirectory,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--binary',
          run.inputTree,
          '--',
          '.',
        ],
        true,
      )
    : diff

  if (contributionDiff.length > 500_000) throw new Error('DELIVERY_TOO_LARGE')
  return {
    diff,
    contributionDiff,
    inputDeliveryIds: run.inputDeliveryIds ?? [],
    headCommit: git(run.workDirectory, ['rev-parse', 'HEAD']),
  }
}

/** 续接复用本 Run 的目录，拒绝符号链接重定向、换仓库或切分支；不重置已有贡献。 */
export const validateRunContinuation = (input: {
  project: Project
  run: Run
  dataDirectory: string
}): void => {
  const { project, run, dataDirectory } = input
  const base = realpathSync(join(dataDirectory, 'worktrees'))
  const actual = realpathSync(run.workDirectory)
  if (relative(join(base, run.id), actual)) throw new Error('INVALID_WORKSPACE')

  const common = (cwd: string) =>
    realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])))

  if (
    common(actual) !== common(project.repositoryPath) ||
    git(actual, ['symbolic-ref', '--short', 'HEAD']) !== run.executionBranch
  )
    throw new Error('INVALID_WORKSPACE')
}

/** 仅应用已验收贡献，每份应用一次；冲突保留隔离目录并失败，禁止重置主仓库。 */
export const applyRunInputPatches = (run: Run, patches: string[]): string => {
  try {
    for (const patch of patches.filter((value) => value.length))
      git(
        run.workDirectory,
        ['apply', '--index', '--whitespace=nowarn', '-'],
        false,
        patch,
      )
  } catch {
    throw new Error('DEPENDENCY_PATCH_CONFLICT')
  }
  // 不调用自定义 merge driver 或 Hook，也不为输入检查点生成用户代码提交。
  return git(run.workDirectory, ['write-tree'])
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
