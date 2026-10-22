import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { teamFixture, enableTestRole } from './helpers/team-fixture.js'
import { waitForRun } from './helpers/local-kernel-fixture.js'
import type { CliRunResult } from '../src/cli/types.js'

test('不同项目真实工作树可两槽并行，第三槽/同项目/同角色分别等待，停止后释放槽位', async () => {
  const held = new Map<string, (value: CliRunResult) => void>()
  let maximum = 0

  const fixture = await teamFixture(
    (options) =>
      new Promise((resolve, reject) => {
        held.set(options.cwd, resolve)
        maximum = Math.max(maximum, held.size)
        options.signal?.addEventListener(
          'abort',
          () => {
            held.delete(options.cwd)
            reject(new Error('fixture cancellation'))
          },
          { once: true },
        )
      }),
  )

  try {
    const secondRole = await enableTestRole(fixture, '开发者二')
    const thirdRole = await enableTestRole(fixture, '开发者三')
    const source = (await fixture.snapshot()).projects[0]!.repositoryPath
    const projects = [fixture.projectId]
    for (const suffix of ['two', 'three']) {
      const repositoryPath = join(dirname(source), suffix)
      execFileSync('git', ['clone', '--no-local', source, repositoryPath], {
        stdio: 'ignore',
      })
      projects.push(
        await fixture.command({
          type: 'project.create',
          name: suffix,
          repositoryPath,
          defaultBranch: 'main',
        }),
      )
    }
    const runs: string[] = []

    const plans = [
      [projects[0]!, fixture.roleId],
      [projects[1]!, secondRole],
      [projects[2]!, thirdRole],
      [projects[1]!, thirdRole],
      [projects[2]!, secondRole],
    ]

    for (const [projectId, roleId] of plans) {
      const taskId = await fixture.command({
        type: 'task.create',
        projectId: projectId!,
        roleId: roleId!,
        title: '并发任务',
        goal: '等待受控释放',
        acceptanceCriteria: '状态正确',
      })

      runs.push(
        await fixture.command({
          type: 'run.start',
          taskId,
          expectedVersion: 1,
        }),
      )
    }
    let state = await fixture.snapshot()
    assert.equal(
      state.runs.find((run) => run.id === runs[2])?.waitingReason,
      'capacity',
    )
    assert.equal(
      state.runs.find((run) => run.id === runs[3])?.waitingReason,
      'project_busy',
    )
    assert.equal(
      state.runs.find((run) => run.id === runs[4])?.waitingReason,
      'role_busy',
    )
    const first = state.runs.find((run) => run.id === runs[0])!
    await fixture.command({
      type: 'run.stop',
      runId: first.id,
      expectedVersion: first.version,
    })
    assert.equal((await waitForRun(fixture.kernel, first.id)).status, 'stopped')
    for (let attempt = 0; attempt < 100 && held.size !== 2; attempt++)
      await delay(10)
    state = await fixture.snapshot()
    assert.equal(
      state.runs.find((run) => run.id === runs[2])?.status,
      'running',
    )
    assert.equal(maximum, 2)
  } finally {
    await fixture.cleanup()
  }
})
