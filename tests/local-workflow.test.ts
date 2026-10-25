import { workspaceSnapshotSchema } from '../src/kernel/workspace-contracts.js'
import { fulfillTrial } from './helpers/role-trial-fixture.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createKernel, type EmbeddedKernel } from '../src/kernel/kernel.js'
import { type BusinessCommand } from '../src/kernel/business-contracts.js'

const command = async (
  kernel: EmbeddedKernel,
  payload: BusinessCommand,
  key = randomUUID(),
) => {
  const response = await kernel.dispatch({
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'workspace.command',
    key,
    command: payload,
  })

  if (response.status === 'rejected') throw new Error(response.error.code)
  return (response.result as { id: string }).id
}

const snapshot = async (kernel: EmbeddedKernel) => {
  const response = await kernel.dispatch({
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'workspace.snapshot',
  })

  if (response.status === 'rejected') throw new Error(response.error.code)
  const state = workspaceSnapshotSchema.parse(response.result)
  const runs = state.runs.filter((run) => run.purpose !== 'role_trial')
  const runIds = new Set(runs.map((run) => run.id))
  return {
    ...state,
    runs,
    tasks: state.tasks.filter((task) => task.purpose !== 'role_trial'),
    deliveries: state.deliveries.filter((delivery) =>
      runIds.has(delivery.runId),
    ),
  }
}

const enableRoleVersion = async (
  kernel: EmbeddedKernel,
  ref: { roleId: string; version: number; projectId: string },
) => {
  await command(kernel, {
    type: 'role.trial',
    roleId: ref.roleId,
    expectedRoleVersion: ref.version,
    projectId: ref.projectId,
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await snapshot(kernel)).roleReadiness.find(
      (item) => item.roleId === ref.roleId,
    )

    if (state?.state === 'ready') {
      await command(kernel, {
        type: 'role.setEnabled',
        roleId: ref.roleId,
        expectedRoleVersion: ref.version,
        expectedReadinessVersion: state.version,
        enabled: true,
      })
      return
    }
    await delay(20)
  }
  assert.fail('角色试运行未通过')
}

test('真实 Git + 端口集成：交付独立验收、幂等、退回重试、新版本快照与重启恢复', async () => {
  const temporary = ownedTempDirectory('weftpilot-workflow-')
  const directory = temporary.directory
  const repositoryPath = join(directory, 'repository')
  mkdirSync(repositoryPath)

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repositoryPath, stdio: 'ignore' })

  git(['init', '-b', 'main'])
  git([
    '-c',
    'user.name=WeftPilot Test',
    '-c',
    'user.email=test@weftpilot.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'baseline',
  ])

  const options = {
    dataDirectory: join(directory, 'data'),
    sourceCommit: 'a'.repeat(40),
    execute: async ({ cwd, prompt }: { cwd: string; prompt: string }) => {
      const trial = fulfillTrial({ cwd, prompt })
      if (trial) return trial
      writeFileSync(join(cwd, 'hello.txt'), '交付内容')
      return { answer: '已写入文件；未自动验收' }
    },
  }

  let kernel = createKernel(options)
  try {
    const projectId = await command(kernel, {
      type: 'project.create',
      name: '测试项目',
      repositoryPath,
      defaultBranch: 'main',
    })

    const roleInput = {
      type: 'role.save' as const,
      expectedVersion: 0,
      name: '开发者',
      responsibility: '原职责',
      cli: 'codex' as const,
      model: '',
      permission: 'workspace-write' as const,
    }

    const roleId = await command(kernel, roleInput)
    await enableRoleVersion(kernel, { roleId, version: 1, projectId })

    const taskId = await command(kernel, {
      type: 'task.create',
      projectId,
      roleId,
      title: '测试任务',
      goal: '创建文件',
      acceptanceCriteria: '文件存在',
    })

    const key = randomUUID()
    const start = { type: 'run.start' as const, taskId, expectedVersion: 1 }
    const runId = await command(kernel, start, key)
    assert.equal(await command(kernel, start, key), runId)
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await snapshot(kernel)).runs[0]?.status === 'succeeded') break
      await delay(20)
    }
    let state = await snapshot(kernel)
    assert.equal(state.tasks[0]?.status, 'in_review')
    assert.equal(state.runs.length, 1)
    const delivery = state.deliveries[0]
    assert.ok(delivery)
    assert.ok(delivery.diff.includes('交付内容'))
    await command(kernel, {
      ...roleInput,
      id: roleId,
      expectedVersion: 1,
      responsibility: '新职责',
    })
    await enableRoleVersion(kernel, { roleId, version: 2, projectId })
    await command(kernel, {
      type: 'delivery.accept',
      deliveryId: delivery.id,
      expectedTaskVersion: state.tasks[0]?.version ?? 0,
      decision: 'returned',
      reason: '需要改进',
    })
    await command(kernel, {
      type: 'run.retry',
      runId,
      expectedVersion: state.runs[0]?.version ?? 0,
    })
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await snapshot(kernel)).runs[1]?.status === 'succeeded') break
      await delay(20)
    }
    state = await snapshot(kernel)
    assert.equal(state.runs[0]?.roleSnapshot.responsibility, '原职责')
    assert.equal(state.runs[1]?.roleSnapshot.responsibility, '新职责')
    assert.equal(state.runs[0]?.feedbackSnapshot, '')
    assert.equal(state.runs[1]?.feedbackSnapshot, '需要改进')
    assert.notEqual(state.runs[0]?.id, state.runs[1]?.id)
    assert.equal(state.acceptances[0]?.reason, '需要改进')
    await assert.rejects(
      () =>
        command(kernel, {
          type: 'delivery.accept',
          deliveryId: delivery.id,
          expectedTaskVersion: state.tasks[0]?.version ?? 0,
          decision: 'accepted',
          reason: '',
        }),
      /STALE_DELIVERY/,
    )
    const latestDelivery = state.deliveries[1]
    assert.ok(latestDelivery)
    await command(kernel, {
      type: 'delivery.accept',
      deliveryId: latestDelivery.id,
      expectedTaskVersion: state.tasks[0]?.version ?? 0,
      decision: 'accepted',
      reason: '',
    })
    await kernel.shutdown()
    kernel = createKernel(options)
    assert.equal((await snapshot(kernel)).tasks[0]?.status, 'done')
    assert.equal((await snapshot(kernel)).runs.length, 2)
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})
