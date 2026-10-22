import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  localKernelFixture,
  waitForRun,
} from './helpers/local-kernel-fixture.js'
import { fulfillTrial } from './helpers/role-trial-fixture.js'

const roleInput = {
  type: 'role.save' as const,
  expectedVersion: 0,
  name: '生命周期角色',
  responsibility: '仅测试隔离文件',
  cli: 'codex' as const,
  model: '',
  permission: 'workspace-write' as const,
}

test('未通过真实文件挑战不可启用，失败不伪装就绪；禁用及配置版本改变阻止新执行', async () => {
  let valid = false

  const fixture = await localKernelFixture(async (options) =>
    valid
      ? (fulfillTrial(options) ?? { answer: '普通任务输出' })
      : { answer: '口头声称完成' },
  )

  const { kernel, projectId, command, snapshot } = fixture
  try {
    const roleId = await command(roleInput)

    const task = {
      type: 'task.create' as const,
      projectId,
      roleId,
      title: '普通任务',
      goal: '执行',
      acceptanceCriteria: '验收',
    }

    const taskId = await command(task)
    await assert.rejects(
      () => command({ type: 'run.start', taskId, expectedVersion: 1 }),
      /ROLE_NOT_READY/,
    )
    await assert.rejects(
      () =>
        command({
          type: 'role.setEnabled',
          roleId,
          expectedRoleVersion: 1,
          expectedReadinessVersion: 1,
          enabled: true,
        }),
      /ROLE_NOT_READY/,
    )

    const failed = await command({
      type: 'role.trial',
      roleId,
      projectId,
      expectedRoleVersion: 1,
    })

    const failedRun = await waitForRun(kernel, failed)
    assert.equal(failedRun.status, 'failed')
    assert.equal(failedRun.failureCode, 'ROLE_TRIAL_OUTPUT_INVALID')
    await assert.rejects(
      () =>
        command({
          type: 'run.retry',
          runId: failed,
          expectedVersion: failedRun.version,
        }),
      /TASK_NOT_EXECUTABLE/,
    )
    assert.equal((await snapshot()).roleReadiness[0]?.enabled, false)
    valid = true

    const passed = await command({
      type: 'role.trial',
      roleId,
      projectId,
      expectedRoleVersion: 1,
    })

    assert.equal((await waitForRun(kernel, passed)).status, 'succeeded')
    let state = (await snapshot()).roleReadiness[0]
    assert.ok(state)
    assert.equal(state.state, 'ready')
    assert.equal(state.enabled, false)
    await assert.rejects(
      () =>
        command({
          type: 'role.setEnabled',
          roleId,
          expectedRoleVersion: 1,
          expectedReadinessVersion: 1,
          enabled: true,
        }),
      /VERSION_CONFLICT/,
    )
    await command({
      type: 'role.setEnabled',
      roleId,
      expectedRoleVersion: 1,
      expectedReadinessVersion: state.version,
      enabled: true,
    })

    const runId = await command({
      type: 'run.start',
      taskId,
      expectedVersion: 1,
    })

    assert.equal((await waitForRun(kernel, runId)).status, 'succeeded')
    state = (await snapshot()).roleReadiness[0]
    assert.ok(state)
    await command({
      type: 'role.setEnabled',
      roleId,
      expectedRoleVersion: 1,
      expectedReadinessVersion: state.version,
      enabled: false,
    })
    const secondTask = await command(task)
    await assert.rejects(
      () =>
        command({ type: 'run.start', taskId: secondTask, expectedVersion: 1 }),
      /ROLE_NOT_READY/,
    )
    await command({
      ...roleInput,
      id: roleId,
      expectedVersion: 1,
      responsibility: '修改后的职责',
    })
    state = (await snapshot()).roleReadiness[0]
    assert.ok(state)
    assert.equal(state.roleVersion, 2)
    assert.equal(state.state, 'draft')
    assert.equal(
      (await snapshot()).runs.find((run) => run.id === runId)?.roleSnapshot
        .version,
      1,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('旧配置的在途试运行成功也不能启用新版本，历史证明保持原配置', async () => {
  let release: (() => void) | undefined

  const fixture = await localKernelFixture(async (options) => {
    await new Promise<void>((resolve, reject) => {
      release = resolve
      options.signal?.addEventListener(
        'abort',
        () => reject(new Error('测试已取消')),
        { once: true },
      )
    })
    return fulfillTrial(options) ?? { answer: '' }
  })

  try {
    const roleId = await fixture.command(roleInput)

    const trialId = await fixture.command({
      type: 'role.trial',
      roleId,
      projectId: fixture.projectId,
      expectedRoleVersion: 1,
    })

    await fixture.command({
      ...roleInput,
      id: roleId,
      expectedVersion: 1,
      responsibility: '新版本职责',
    })
    assert.ok(release)
    release()
    const run = await waitForRun(fixture.kernel, trialId)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.roleSnapshot.version, 1)
    const state = (await fixture.snapshot()).roleReadiness[0]
    assert.ok(state)
    assert.equal(state.roleVersion, 2)
    assert.equal(state.state, 'draft')
    assert.equal(state.latestTrialRunId, null)
    await assert.rejects(
      () =>
        fixture.command({
          type: 'role.setEnabled',
          roleId,
          expectedRoleVersion: 2,
          expectedReadinessVersion: state.version,
          enabled: true,
        }),
      /ROLE_NOT_READY/,
    )
  } finally {
    release?.()
    await fixture.cleanup()
  }
})
