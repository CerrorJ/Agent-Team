import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProductStore } from '../src/kernel/product-store.js'
import { RoleReadinessStore } from '../src/kernel/role-readiness-store.js'
import { prepareTeamCommand } from '../src/kernel/team-commands.js'
import { CommandLedger } from '../src/kernel/command-ledger.js'
import { preflightFixture } from './helpers/preflight-fixture.js'
import { executionPlan } from '../src/kernel/execution-plan.js'
import { inspectTaskPreflight } from '../src/kernel/task-preflight.js'
import {
  businessCommandSchema,
  runSchema,
  taskSchema,
} from '../src/kernel/business-contracts.js'
import { teamFixture, teamPlan } from './helpers/team-fixture.js'
import {
  taskPreflightSchema,
  type PreflightInput,
} from '../src/kernel/preflight-contracts.js'

test('固定模型与需求引用不追随新版本；预检展示及新Run都保留同一旧快照', () => {
  const f = preflightFixture()
  try {
    const products = new ProductStore(f.store)

    const requirement = {
      id: randomUUID(),
      version: 1,
      projectId: f.task.projectId,
      title: '固定需求',
      body: '版本一',
      acceptanceCriteria: '只按版本一验收',
      createdAt: new Date().toISOString(),
    }

    const model = {
      id: randomUUID(),
      version: 1,
      name: '固定模型',
      cli: 'codex' as const,
      provider: 'cli-managed' as const,
      model: 'model-v1',
      baseUrl: '',
      credentialRef: null,
      reasoningEffort: '' as const,
      createdAt: new Date().toISOString(),
    }

    const role = {
      ...f.run.roleSnapshot,
      version: 2,
      modelProfileSnapshot: model,
      model: model.model,
    }

    const task = {
      ...f.task,
      version: 3,
      requirementRef: { id: requirement.id, version: 1 },
    }

    f.store.transaction(() => {
      products.append('requirement_versions', requirement, 'requirement.saved')
      products.append('model_profiles', model, 'model.saved')
      f.store.addRole(role)
      f.store.updateTask(task)
      new RoleReadinessStore(f.store).save({
        roleId: role.id,
        roleVersion: 2,
        version: 2,
        state: 'ready',
        enabled: true,
        latestTrialRunId: null,
        failureCode: null,
        updatedAt: role.createdAt,
      })
    })

    const start = {
      type: 'run.start' as const,
      taskId: task.id,
      expectedVersion: task.version,
    }

    const fingerprint = executionPlan(f.store, start).configurationFingerprint
    const nextRequirement = { ...requirement, version: 2, body: '版本二' }
    const nextModel = { ...model, version: 2, model: 'model-v2' }
    f.store.transaction(() => {
      products.append(
        'requirement_versions',
        nextRequirement,
        'requirement.saved',
      )
      products.append('model_profiles', nextModel, 'model.saved')
    })
    const plan = executionPlan(f.store, start)
    assert.equal(plan.configurationFingerprint, fingerprint)
    assert.equal(plan.configurations[0]?.requirementSnapshot?.body, '版本一')

    const outcome = f.command({
      ...start,
      expectedConfigurationFingerprint: fingerprint,
    })

    const run = f.store.get('runs', outcome.id, runSchema)
    assert.equal(run.roleSnapshot.modelProfileSnapshot?.version, 1)
    assert.equal(run.requirementSnapshot?.version, 1)
    assert.equal(run.requirementSnapshot?.body, '版本一')
  } finally {
    f.cleanup()
  }
})

test('团队确认摘要覆盖全部子任务，失效不部分创建；有效启动一次性创建全部Run与回执', () => {
  const f = preflightFixture()
  try {
    const parent = {
      ...f.task,
      id: randomUUID(),
      version: 1,
      purpose: 'team_parent' as const,
    }

    const first = {
      ...f.task,
      version: 3,
      parentTaskId: parent.id,
      dependencyTaskIds: [],
    }

    const second = {
      ...first,
      id: randomUUID(),
      version: 1,
      dependencyTaskIds: [first.id],
    }

    f.store.transaction(() => {
      f.store.addTask(parent)
      f.store.updateTask(first)
      f.store.addTask(second)
    })

    const start = {
      type: 'team.start' as const,
      taskId: parent.id,
      expectedVersion: parent.version,
    }

    const fingerprint = executionPlan(f.store, start).configurationFingerprint
    f.store.transaction(() =>
      f.store.updateTask({ ...second, version: 2, goal: '外部渠道改动' }),
    )

    const execute = (hash: string, key = randomUUID()) => {
      const command = { ...start, expectedConfigurationFingerprint: hash }
      const input = { key, command }
      const ledger = new CommandLedger(f.store)
      return (
        ledger.find(input) ??
        ledger.execute(
          input,
          prepareTeamCommand({
            store: f.store,
            command,
            dataDirectory: f.directory,
          }),
        )
      )
    }

    const before = f.counts()
    assert.throws(() => execute(fingerprint), /PREFLIGHT_CHANGED/)
    assert.deepEqual(f.counts(), before)
    const current = executionPlan(f.store, start).configurationFingerprint
    const key = randomUUID()
    const outcome = execute(current, key)
    assert.deepEqual(execute(current, key), outcome)
    assert.equal(f.store.list('runs', runSchema).length, 2)
    assert.equal(
      f.store.get('tasks', parent.id, taskSchema).status,
      'in_progress',
    )
  } finally {
    f.cleanup()
  }
})

test('只读预检固定配置，不创建Run/事件/回执或Git改动，不伪造登录与模型成功', () => {
  const f = preflightFixture()
  try {
    const before = f.counts()

    const command = {
      type: 'run.start' as const,
      taskId: f.task.id,
      expectedVersion: f.task.version,
    }

    const plan = executionPlan(f.store, command)

    const result = inspectTaskPreflight(f.store, {
      operation: 'start',
      id: f.task.id,
      expectedVersion: f.task.version,
    })

    assert.equal(result.tasks[0]?.role.version, 1)
    assert.equal(result.project?.baselineCommit, plan.baselineCommit)
    assert.equal(result.project?.currentBranch, 'main')
    assert.equal(
      result.checks.filter((item) => item.state === 'unverified').length,
      3,
    )
    assert.deepEqual(f.counts(), before)
    assert.equal(f.git(['status', '--porcelain=v1']), '')
    assert.equal(
      executionPlan(f.store, command).configurationFingerprint,
      plan.configurationFingerprint,
    )
    const key = randomUUID()

    const guarded = {
      ...command,
      expectedConfigurationFingerprint: plan.configurationFingerprint,
    }

    const outcome = f.command(guarded, key)
    const run = f.store.get('runs', outcome.id, runSchema)
    assert.equal(run.roleSnapshot.version, 1)
    assert.equal(run.baselineCommit, plan.baselineCommit)
    assert.equal(run.status, 'queued')
    assert.equal(f.store.list('runs', runSchema).length, 1)
  } finally {
    f.cleanup()
  }
})

test('角色或Git基准变化使旧预览失效，失败事务不留下Run、事件、通知和回执', () => {
  const f = preflightFixture()
  try {
    const start = {
      type: 'run.start' as const,
      taskId: f.task.id,
      expectedVersion: f.task.version,
    }

    const initial = executionPlan(f.store, start).configurationFingerprint
    f.commit()
    let before = f.counts()
    assert.throws(
      () => f.command({ ...start, expectedConfigurationFingerprint: initial }),
      /PREFLIGHT_CHANGED/,
    )
    assert.deepEqual(f.counts(), before)
    const current = executionPlan(f.store, start).configurationFingerprint
    f.store.transaction(() =>
      f.store.addRole({
        ...f.run.roleSnapshot,
        version: 2,
        permission: 'workspace-write',
      }),
    )
    before = f.counts()
    assert.throws(
      () => f.command({ ...start, expectedConfigurationFingerprint: current }),
      /PREFLIGHT_CHANGED/,
    )
    assert.deepEqual(f.counts(), before)

    const next = inspectTaskPreflight(f.store, {
      operation: 'start',
      id: f.task.id,
      expectedVersion: f.task.version,
    })

    assert.equal(next.canStart, false)
    assert.equal(next.configurationFingerprint, null)
    assert.equal(next.checks[0]?.code, 'ROLE_NOT_READY')
  } finally {
    f.cleanup()
  }
})

test('脏仓库保留文件，未知进程阻塞；项目占用只进入等待，不改变配置摘要', () => {
  const f = preflightFixture()
  try {
    const intent = {
      operation: 'start' as const,
      id: f.task.id,
      expectedVersion: f.task.version,
    }

    const start = {
      type: 'run.start' as const,
      taskId: f.task.id,
      expectedVersion: f.task.version,
    }

    const fingerprint = executionPlan(f.store, start).configurationFingerprint
    const file = join(f.directory, 'user-change.txt')
    writeFileSync(file, 'protect me')
    const before = f.counts()
    assert.equal(
      inspectTaskPreflight(f.store, intent).checks[0]?.code,
      'GIT_DIRTY',
    )
    assert.equal(readFileSync(file, 'utf8'), 'protect me')
    assert.deepEqual(f.counts(), before)
    unlinkSync(file)
    f.store.transaction(() =>
      f.store.addRun({ ...f.run, status: 'running', processState: 'active' }),
    )
    const waiting = inspectTaskPreflight(f.store, intent)
    assert.ok(
      waiting.checks.some(
        (check) => check.state === 'waiting' && check.code === 'PROJECT_BUSY',
      ),
    )
    assert.equal(
      executionPlan(f.store, start).configurationFingerprint,
      fingerprint,
    )
    f.store.transaction(() =>
      f.store.updateRun({
        ...f.run,
        version: 2,
        processState: 'uncertain',
        status: 'stopping',
      }),
    )
    assert.equal(
      inspectTaskPreflight(f.store, intent).checks[0]?.code,
      'STATE_UNCERTAIN',
    )
  } finally {
    f.cleanup()
  }
})

test('重试只允许最新已结束Run，生成新Run并保留固定反馈和历史', () => {
  const f = preflightFixture()
  try {
    const old = {
      ...f.run,
      status: 'failed' as const,
      processState: 'confirmed_ended' as const,
      feedbackSnapshot: '保留退回原因',
    }

    f.store.transaction(() => f.store.addRun(old))

    const retry = {
      type: 'run.retry' as const,
      runId: old.id,
      expectedVersion: old.version,
    }

    const fingerprint = executionPlan(f.store, retry).configurationFingerprint

    const next = f.command({
      ...retry,
      expectedConfigurationFingerprint: fingerprint,
    })

    assert.notEqual(next.id, old.id)
    const run = f.store.get('runs', next.id, runSchema)
    assert.equal(run.retryOfRunId, old.id)
    assert.equal(run.attempt, 2)
    assert.equal(run.feedbackSnapshot, old.feedbackSnapshot)
    assert.deepEqual(f.store.get('runs', old.id, runSchema), old)
    assert.equal(
      inspectTaskPreflight(f.store, {
        operation: 'retry',
        id: old.id,
        expectedVersion: old.version,
      }).checks[0]?.code,
      'STALE_RUN',
    )
  } finally {
    f.cleanup()
  }
})

test('嵌入协议校验输入，团队预检读取真实DAG且不启动团队或CLI', async () => {
  const f = await teamFixture(async () => {
    throw new Error('UNEXPECTED_EXECUTION')
  })

  try {
    const id = await f.command(teamPlan(f, [[], ['A']]))
    const before = await f.snapshot()
    const input: PreflightInput = { operation: 'team', id, expectedVersion: 1 }

    const response = await f.kernel.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'workspace.preflight',
      input,
    })

    assert.notEqual(response.status, 'rejected')
    if (response.status === 'rejected') throw new Error(response.error.code)
    const result = taskPreflightSchema.parse(response.result)
    assert.equal(result.tasks.length, 2)
    assert.equal(result.tasks[0]?.parentTaskId, id)
    assert.deepEqual(result.tasks[0]?.dependencyTaskIds, [])
    assert.deepEqual(result.tasks[1]?.dependencyTaskIds, [result.tasks[0]?.id])
    assert.ok(
      result.checks.some(
        (check) =>
          check.code === 'DEPENDENCY_NOT_ACCEPTED' && check.state === 'waiting',
      ),
    )
    assert.deepEqual(await f.snapshot(), before)
    assert.ok(f.kernel.handshake.capabilities.includes('task-preflight'))

    const malformed = await f.kernel.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'workspace.preflight',
      input: { ...input, command: 'shell' },
    })

    assert.equal(malformed.status, 'rejected')
    assert.equal(
      businessCommandSchema.safeParse({
        type: 'team.start',
        taskId: id,
        expectedVersion: 1,
        expectedConfigurationFingerprint: 'not-a-hash',
      }).success,
      false,
    )
  } finally {
    await f.cleanup()
  }
})
