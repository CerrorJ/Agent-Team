import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { prepareRunCommand } from '../src/kernel/run-commands.js'
import { LocalScheduler } from '../src/kernel/local-scheduler.js'
import {
  runSchema,
  type Run,
  type RoleVersion,
} from '../src/kernel/business-contracts.js'

const fixture = () => {
  const database = new DatabaseSync(':memory:')
  const store = new WorkspaceStore(database)
  const projectId = randomUUID()
  const taskId = randomUUID()
  const createdAt = new Date().toISOString()

  const role: RoleVersion = {
    id: randomUUID(),
    version: 1,
    name: '测试角色',
    responsibility: '只用于测试',
    cli: 'codex',
    model: '',
    permission: 'read-only',
    skills: [],
    createdAt,
  }

  const run: Run = {
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
    acceptanceSnapshot: '测试条件',
    executionBranch: 'test',
    workDirectory: 'unused',
    createdAt,
    startedAt: null,
    endedAt: null,
    failureCode: null,
    processState: 'not_started',
  }

  store.transaction(() => {
    store.addProject({
      id: projectId,
      version: 1,
      name: '测试项目',
      repositoryPath: 'unused',
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
    store.addRun(run)
  })
  return { database, store, run }
}

test('排队取消记录未启动进程已经结束，允许后续新 Run；待确认进程拒绝停止决定', () => {
  const { database, store, run } = fixture()
  try {
    store.transaction(
      prepareRunCommand({
        store,
        dataDirectory: 'unused',
        command: { type: 'run.stop', runId: run.id, expectedVersion: 1 },
      }),
    )
    const cancelled = store.get('runs', run.id, runSchema)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.processState, 'confirmed_ended')
    assert.ok(cancelled.endedAt)
    store.transaction(() =>
      store.updateRun({
        ...cancelled,
        version: 3,
        status: 'running',
        processState: 'uncertain',
      }),
    )
    assert.throws(
      () =>
        store.transaction(
          prepareRunCommand({
            store,
            dataDirectory: 'unused',
            command: { type: 'run.stop', runId: run.id, expectedVersion: 3 },
          }),
        ),
      /STATE_UNCERTAIN/,
    )
    assert.equal(store.get('runs', run.id, runSchema).version, 3)
  } finally {
    database.close()
  }
})

test('完全退出也将尚未启动的排队任务取消为确认结束', async () => {
  const { database, store, run } = fixture()
  try {
    await new LocalScheduler({ store, dataDirectory: 'unused' }).shutdown()
    assert.equal(
      store.get('runs', run.id, runSchema).processState,
      'confirmed_ended',
    )
  } finally {
    database.close()
  }
})
