import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { teamFixture, teamPlan, acceptTask } from './helpers/team-fixture.js'
import { waitForRun } from './helpers/local-kernel-fixture.js'

const readText = (cwd: string, file: string) =>
  readFileSync(join(cwd, file), 'utf8').replaceAll('\r\n', '\n')

test('团队 DAG 原子创建，环/重复键拒绝；未启动的团队不能单独执行子任务', async () => {
  const fixture = await teamFixture(async () => ({ answer: 'unused' }))
  try {
    const before = (await fixture.snapshot()).tasks.length
    await assert.rejects(
      fixture.command(teamPlan(fixture, [['B'], ['A']])),
      /TEAM_DEPENDENCY_CYCLE/,
    )
    assert.equal((await fixture.snapshot()).tasks.length, before)
    const command = teamPlan(fixture, [[], ['A']])
    command.steps[1]!.key = 'A'
    await assert.rejects(fixture.command(command), /TEAM_PLAN_INVALID/)
    const parent = await fixture.command(teamPlan(fixture, [[], ['A']]))

    const child = (await fixture.snapshot()).tasks.find(
      (task) => task.parentTaskId === parent,
    )!

    await assert.rejects(
      fixture.command({
        type: 'run.start',
        taskId: child.id,
        expectedVersion: child.version,
      }),
      /TEAM_NOT_STARTED/,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('真实 Git 菱形依赖只合成一次共同上游，执行成功仍等待人工验收', async () => {
  const fixture = await teamFixture(async (options) => {
    const step = options.prompt.match(/任务：STEP_([A-D])/)?.[1]!
    if (step !== 'A') assert.equal(readText(options.cwd, 'a.txt'), 'A\n')
    if (step === 'D') {
      assert.equal(readText(options.cwd, 'b.txt'), 'B\n')
      assert.equal(readText(options.cwd, 'c.txt'), 'C\n')
      assert.match(options.prompt, /已验收上游交付/)
    }
    writeFileSync(join(options.cwd, `${step.toLowerCase()}.txt`), `${step}\n`)
    return { answer: `交付 ${step}` }
  })

  try {
    const parent = await fixture.command(
      teamPlan(fixture, [[], ['A'], ['A'], ['B', 'C']]),
    )

    await fixture.command({
      type: 'team.start',
      taskId: parent,
      expectedVersion: 1,
    })

    const children = (await fixture.snapshot()).tasks.filter(
      (task) => task.parentTaskId === parent,
    )

    const first = (await fixture.snapshot()).runs.find(
      (run) => run.taskId === children[0]!.id,
    )!

    await waitForRun(fixture.kernel, first.id)

    const waiting = (await fixture.snapshot()).runs.filter(
      (run) => run.status === 'queued',
    )

    assert.equal(waiting.length, 3)
    assert.ok(
      waiting.every((run) => run.waitingReason === 'dependency_acceptance'),
    )
    for (const child of children) {
      const run = (await fixture.snapshot()).runs.find(
        (item) => item.taskId === child.id,
      )!

      assert.equal(
        (await waitForRun(fixture.kernel, run.id)).status,
        'succeeded',
      )
      await acceptTask(fixture, child.id)
    }
    const state = await fixture.snapshot()
    assert.equal(state.tasks.find((task) => task.id === parent)?.status, 'done')
    const final = state.runs.find((run) => run.taskId === children[3]!.id)!
    assert.equal(final.inputDeliveryIds?.length, 3)
    const delivery = state.deliveries.find((item) => item.runId === final.id)!
    assert.match(delivery.diff, /a.txt/)
    assert.doesNotMatch(delivery.contributionDiff!, /a.txt|b.txt|c.txt/)
    assert.match(delivery.contributionDiff!, /d.txt/)
  } finally {
    await fixture.cleanup()
  }
})

test('分支贡献冲突时不启动下游 CLI，保留失败执行和已验收输入', async () => {
  let downstreamStarted = false

  const fixture = await teamFixture(async (options) => {
    const step = options.prompt.match(/任务：STEP_([A-D])/)?.[1]!
    if (step === 'D') downstreamStarted = true
    writeFileSync(join(options.cwd, 'same.txt'), `${step}\n`)
    return { answer: step }
  })

  try {
    const parent = await fixture.command(
      teamPlan(fixture, [[], ['A'], ['A'], ['B', 'C']]),
    )

    await fixture.command({
      type: 'team.start',
      taskId: parent,
      expectedVersion: 1,
    })

    const children = (await fixture.snapshot()).tasks.filter(
      (task) => task.parentTaskId === parent,
    )

    for (const child of children.slice(0, 3)) {
      const run = (await fixture.snapshot()).runs.find(
        (item) => item.taskId === child.id,
      )!

      await waitForRun(fixture.kernel, run.id)
      await acceptTask(fixture, child.id)
    }

    const run = (await fixture.snapshot()).runs.find(
      (item) => item.taskId === children[3]!.id,
    )!

    const result = await waitForRun(fixture.kernel, run.id)
    assert.equal(result.status, 'failed')
    assert.equal(result.failureCode, 'DEPENDENCY_PATCH_CONFLICT')
    assert.equal(result.inputDeliveryIds?.length, 3)
    assert.equal(downstreamStarted, false)
    assert.equal(readText(result.workDirectory, 'same.txt'), 'B\n')
    await delay(30)
    assert.equal(
      (await fixture.snapshot()).tasks.find((task) => task.id === parent)
        ?.status,
      'in_progress',
    )
  } finally {
    await fixture.cleanup()
  }
})
