import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { queueBlocker } from '../src/kernel/queue-rules.js'
import {
  runSchema,
  type RoleVersion,
  type Run,
} from '../src/kernel/business-contracts.js'

// 受控SQLite排队夹具，仅验证资源规则，不作为CLI执行或进程结束证据。
const role = (limit?: number): RoleVersion => ({
  id: randomUUID(),
  version: 1,
  name: '并发角色',
  responsibility: '测试资源边界',
  cli: 'codex',
  model: '',
  permission: 'read-only',
  skills: [],
  ...(limit ? { maxConcurrency: limit } : {}),
  createdAt: new Date().toISOString(),
})

const runData = (input: {
  role: RoleVersion
  projectId: string
  taskId: string
  status: Run['status']
}): Run =>
  runSchema.parse({
    id: randomUUID(),
    version: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    attempt: 1,
    retryOfRunId: null,
    status: input.status,
    roleSnapshot: input.role,
    baselineCommit: 'a'.repeat(40),
    acceptanceSnapshot: '核对排队规则',
    goalSnapshot: '受控资源测试',
    executionBranch: 'fixture',
    workDirectory: 'fixture-worktree',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    failureCode: null,
    processState: input.status === 'queued' ? 'not_started' : 'active',
  })

const fixture = (initialRole: RoleVersion) => {
  const database = new DatabaseSync(':memory:')
  const store = new WorkspaceStore(database)
  const projects = new Set<string>()
  store.transaction(() => store.addRole(initialRole))

  const addRun = (input: {
    role?: RoleVersion
    projectId?: string
    status: Run['status']
  }): Run => {
    const projectId = input.projectId ?? randomUUID()
    const selectedRole = input.role ?? initialRole
    const taskId = randomUUID()

    const run = runData({
      role: selectedRole,
      projectId,
      taskId,
      status: input.status,
    })

    store.transaction(() => {
      if (!projects.has(projectId)) {
        store.addProject({
          id: projectId,
          version: 1,
          name: '排队项目',
          repositoryPath: `fixture-${projectId}`,
          gitUrl: '',
          defaultBranch: 'main',
          createdAt: new Date().toISOString(),
        })
        projects.add(projectId)
      }
      store.addTask({
        id: taskId,
        version: 1,
        roleId: selectedRole.id,
        projectId,
        title: '排队测试',
        goal: '受控输入',
        acceptanceCriteria: '状态正确',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
      })
      store.addRun(run)
    })
    return run
  }

  return { database, store, addRun }
}

test('角色可用两槽仍受同项目单写者与本机两槽约束', () => {
  const original = role(2)
  const f = fixture(original)
  try {
    const first = f.addRun({ status: 'running' })

    const sameProject = f.addRun({
      projectId: first.projectId,
      status: 'queued',
    })

    assert.equal(
      queueBlocker({ store: f.store, run: sameProject }),
      'project_busy',
    )
    const second = f.addRun({ status: 'queued' })
    assert.equal(queueBlocker({ store: f.store, run: second }), undefined)
    f.store.transaction(() =>
      f.store.updateRun({
        ...second,
        version: 2,
        status: 'running',
        processState: 'active',
      }),
    )
    const third = f.addRun({ status: 'queued' })
    assert.equal(queueBlocker({ store: f.store, run: third }), 'role_busy')
    const another = role(1)
    f.store.transaction(() => f.store.addRole(another))
    const otherRoleRun = f.addRun({ role: another, status: 'queued' })
    assert.equal(
      queueBlocker({ store: f.store, run: otherRoleRun }),
      'capacity',
    )
  } finally {
    f.database.close()
  }
})

test('旧Run缺省并发为一，新版本调高并发不能扩大旧执行快照边界', () => {
  const original = role()
  const f = fixture(original)
  try {
    const first = f.addRun({ status: 'running' })
    const next = { ...original, version: 2, maxConcurrency: 2 }
    f.store.transaction(() => f.store.addRole(next))
    const candidate = f.addRun({ role: next, status: 'queued' })
    assert.equal(queueBlocker({ store: f.store, run: candidate }), 'role_busy')
    assert.equal(first.roleSnapshot.maxConcurrency, undefined)
    assert.equal(candidate.roleSnapshot.maxConcurrency, 2)
    f.store.transaction(() =>
      f.store.updateRun({
        ...first,
        version: 2,
        status: 'stopped',
        processState: 'confirmed_ended',
        endedAt: new Date().toISOString(),
      }),
    )
    assert.equal(queueBlocker({ store: f.store, run: candidate }), undefined)
  } finally {
    f.database.close()
  }
})
