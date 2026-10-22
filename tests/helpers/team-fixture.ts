import assert from 'node:assert/strict'
import { localKernelFixture, waitForRun } from './local-kernel-fixture.js'
import { fulfillTrial } from './role-trial-fixture.js'
import type { CliExecutionPort } from '../../src/kernel/run-execution.js'
import type { BusinessCommand } from '../../src/kernel/business-contracts.js'

export const teamFixture = async (execute: CliExecutionPort) => {
  const fixture = await localKernelFixture(
    async (options) => fulfillTrial(options) ?? execute(options),
  )

  const roleId = await enableTestRole(fixture, '开发者')

  const teamId = await fixture.command({
    type: 'team.save',
    expectedVersion: 0,
    name: '测试团队',
    roleIds: [roleId],
    coordinatorRoleId: roleId,
  })

  return { ...fixture, roleId, teamId }
}

export const enableTestRole = async (
  fixture: Awaited<ReturnType<typeof localKernelFixture>>,
  name: string,
) => {
  const roleId = await fixture.command({
    type: 'role.save',
    expectedVersion: 0,
    name,
    responsibility: '执行当前子任务',
    cli: 'codex',
    model: '',
    permission: 'workspace-write',
  })

  const trial = await fixture.command({
    type: 'role.trial',
    projectId: fixture.projectId,
    roleId,
    expectedRoleVersion: 1,
  })

  assert.equal((await waitForRun(fixture.kernel, trial)).status, 'succeeded')

  const readiness = (await fixture.snapshot()).roleReadiness.find(
    (item) => item.roleId === roleId,
  )!

  await fixture.command({
    type: 'role.setEnabled',
    roleId,
    expectedRoleVersion: 1,
    expectedReadinessVersion: readiness.version,
    enabled: true,
  })

  return roleId
}

type Fixture = Awaited<ReturnType<typeof teamFixture>>
export const teamPlan = (
  fixture: Fixture,
  edges: string[][],
): Extract<BusinessCommand, { type: 'team.createTask' }> => ({
  type: 'team.createTask',
  projectId: fixture.projectId,
  teamId: fixture.teamId,
  expectedTeamVersion: 1,
  title: '真实 Git 团队任务',
  goal: '组合已验收代码',
  acceptanceCriteria: '所有子任务交付已人工验收',
  steps: edges.map((dependsOn, index) => ({
    key: String.fromCharCode(65 + index),
    roleId: fixture.roleId,
    title: `STEP_${String.fromCharCode(65 + index)}`,
    goal: `STEP_${String.fromCharCode(65 + index)}`,
    acceptanceCriteria: '产物内容正确',
    dependsOn,
  })),
})

export const acceptTask = async (fixture: Fixture, taskId: string) => {
  const state = await fixture.snapshot()
  const task = state.tasks.find((item) => item.id === taskId)!

  const delivery = state.deliveries
    .filter((item) => item.taskId === taskId)
    .at(-1)!

  assert.ok(delivery)
  await fixture.command({
    type: 'delivery.accept',
    deliveryId: delivery.id,
    expectedTaskVersion: task.version,
    decision: 'accepted',
    reason: '',
  })
  return delivery
}
