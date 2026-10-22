import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/kernel/workspace-store.js'
import { runWorkDirectory } from '../../src/kernel/git-workspace.js'
import type { Run, RoleVersion } from '../../src/kernel/business-contracts.js'
interface RunContext {
  taskId: string
  projectId: string
  role: RoleVersion
  createdAt: string
}
interface FixtureInput {
  persistRun?: boolean
  repositoryPath?: string
  baselineCommit?: string
  dataDirectory?: string
}

const roleFixture = (createdAt: string): RoleVersion => ({
  id: randomUUID(),
  version: 1,
  name: '测试角色',
  responsibility: '只用于测试',
  cli: 'codex',
  model: '',
  permission: 'read-only',
  skills: [],
  createdAt,
})

const runFixture = ({
  taskId,
  projectId,
  role,
  createdAt,
}: RunContext): Run => ({
  id: randomUUID(),
  version: 1,
  taskId,
  projectId,
  attempt: 1,
  retryOfRunId: null,
  status: 'queued',
  roleSnapshot: role,
  baselineCommit: 'a'.repeat(40),
  goalSnapshot: '测试目标',
  feedbackSnapshot: '',
  acceptanceSnapshot: '测试条件',
  executionBranch: 'test',
  workDirectory: 'unused',
  createdAt,
  startedAt: null,
  endedAt: null,
  failureCode: null,
  processState: 'not_started',
})

export const workspaceFixture = (input: FixtureInput = {}) => {
  const database = new DatabaseSync(':memory:')
  const store = new WorkspaceStore(database)
  const projectId = randomUUID()
  const taskId = randomUUID()
  const createdAt = new Date().toISOString()

  const role = roleFixture(createdAt)
  const run = runFixture({ taskId, projectId, role, createdAt })
  if (input.baselineCommit) run.baselineCommit = input.baselineCommit
  if (input.dataDirectory)
    run.workDirectory = runWorkDirectory({
      dataDirectory: input.dataDirectory,
      runId: run.id,
    })
  store.transaction(() => {
    store.addProject({
      id: projectId,
      version: 1,
      name: '测试项目',
      repositoryPath: input.repositoryPath ?? 'unused',
      gitUrl: '',
      defaultBranch: 'main',
      createdAt,
    })
    store.addRole(role)
    store.addTask({
      id: taskId,
      version: 1,
      projectId,
      roleId: role.id,
      title: '测试',
      goal: '测试目标',
      acceptanceCriteria: '测试条件',
      status: 'in_progress',
      createdAt,
    })
    if (input.persistRun !== false) store.addRun(run)
  })
  return { database, store, run }
}
