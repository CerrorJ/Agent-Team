import { projectSchema, type Project } from './business-contracts.js'
import { performance } from 'node:perf_hooks'
import type { WorkspaceStore } from './workspace-store.js'
import { inspectProjectRepository } from './git-workspace.js'
import { runGitCommand } from './git-command.js'
import { publicError } from './public-errors.js'
import { projectInspectionSchema } from './project-inspection-contracts.js'

/** Git在事务外查询，脏文件仅报告；子命令共享时限，不能改动用户工作区。 */
export const inspectProject = (store: WorkspaceStore, projectId: string) => {
  const project = store.get('projects', projectId, projectSchema)
  return projectInspectionSchema.parse({
    formatVersion: 1,
    projectId,
    projectVersion: project.version,
    repositoryPath: project.repositoryPath,
    defaultBranch: project.defaultBranch,
    ...inspectGit(project),
    checkedAt: new Date().toISOString(),
  })
}

type Query = (cwd: string, args: string[]) => string

const inspectGit = (project: Project) => {
  // 用单调时钟约束所有Git子命令，系统校时不能延长预算；文件系统本身不提供取消事务。
  const deadline = performance.now() + 8_000

  const query = (cwd: string, args: string[]) => {
    if (performance.now() >= deadline) throw new Error('GIT_INSPECTION_FAILED')
    return runGitCommand(cwd, args, {
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    })
  }

  try {
    return readGitFacts(project, query)
  } catch (error) {
    const code = publicError(error).code
    return {
      gitUrl: project.gitUrl,
      git: {
        state: 'unavailable',
        code:
          code === 'INTERNAL_ERROR' || performance.now() >= deadline
            ? 'GIT_INSPECTION_FAILED'
            : code,
      },
    }
  }
}

const readGitFacts = (project: Project, query: Query) => {
  const inspected = inspectProjectRepository(project, query)
  const currentBranch = readBranch(project.repositoryPath, query)

  const commit = () =>
    query(project.repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])

  const currentCommit = commit()

  const dirty = Boolean(
    query(project.repositoryPath, [
      'status',
      '--porcelain=v1',
      '--ignore-submodules=none',
    ]),
  )

  // Git不提供跨命令事务；检测到检查期间HEAD变化则不拼接成一个“已检查”结果。
  if (
    currentCommit !== commit() ||
    currentBranch !== readBranch(project.repositoryPath, query)
  )
    throw new Error('GIT_INSPECTION_FAILED')
  if (
    inspected.baselineCommit !==
    query(project.repositoryPath, [
      'rev-parse',
      '--verify',
      `${project.defaultBranch}^{commit}`,
    ])
  )
    throw new Error('GIT_INSPECTION_FAILED')
  return {
    gitUrl: inspected.gitUrl,
    git: {
      state: 'verified',
      dirty,
      currentBranch,
      currentCommit,
      defaultCommit: inspected.baselineCommit,
    },
  }
}

const readBranch = (cwd: string, query: Query): string | null => {
  try {
    return query(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1)
      return null
    throw error
  }
}
