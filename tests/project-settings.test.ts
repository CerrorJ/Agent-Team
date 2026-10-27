import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import {
  businessCommandSchema,
  type BusinessCommand,
} from '../src/kernel/business-contracts.js'
import { captureTaskConfiguration } from '../src/kernel/run-snapshots.js'
import { executionPrompt } from '../src/kernel/role-trial-files.js'
import { ProductStore } from '../src/kernel/product-store.js'

test('项目 CAS、明确清空与重放，旧 Run 和任务不被配置更新改写', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: value })

  const project = store.snapshot().projects[0]!
  const task = store.snapshot().tasks[0]!

  const input = {
    type: 'project.configure' as const,
    projectId: project.id,
    expectedVersion: 1,
    name: '新项目',
    goal: '目标 A',
    description: '描述 A',
    defaultTeamId: null,
  }

  try {
    assert.equal(Object.hasOwn(project, 'goal'), false)
    const key = randomUUID()
    command(input, key)
    command(input, key)
    const captured = captureTaskConfiguration(store, task, run.id)

    // 仅构造受控终态历史记录，不以它声称 CLI 实际执行成功。
    const history = {
      ...run,
      ...captured,
      status: 'stopped' as const,
      processState: 'confirmed_ended' as const,
    }

    store.transaction(() => store.addRun(history))
    const raw = database.prepare('SELECT data FROM runs').get()?.data
    const prompt = executionPrompt(history)
    assert.match(prompt, /项目目标：目标 A/)
    assert.match(prompt, /项目描述：描述 A/)
    assert.equal(prompt.includes(project.repositoryPath), false)
    command({ ...input, expectedVersion: 2, goal: '目标 B', description: '' })
    assert.equal(database.prepare('SELECT data FROM runs').get()?.data, raw)
    assert.equal(executionPrompt(store.snapshot().runs[0]!), prompt)
    assert.equal(
      captureTaskConfiguration(store, task, randomUUID()).projectContextSnapshot
        .goal,
      '目标 B',
    )
    assert.deepEqual(store.snapshot().tasks, [task])
    assert.equal(
      store.snapshot().projects[0]?.repositoryPath,
      project.repositoryPath,
    )
    assert.equal(
      store.snapshot().projects[0]?.defaultBranch,
      project.defaultBranch,
    )
    assert.throws(() => command(input), /VERSION_CONFLICT/)
    assert.equal(command(input, key).id, project.id)
    command({ ...input, expectedVersion: 3, goal: '', description: '' })
    assert.equal(store.snapshot().projects[0]?.goal, '')
    assert.equal(
      executionPrompt(run),
      executionPrompt({ ...run, projectContextSnapshot: undefined }),
    )
    assert.equal(
      executionPrompt({
        ...history,
        trial: { challenge: 'check', inputFile: 'trial.txt', outputFile: null },
      }).includes('目标 A'),
      false,
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('严格输入、缺失团队与事件失败均不留下项目、通知或幂等回执', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const input = {
    type: 'project.configure' as const,
    projectId: run.projectId,
    expectedVersion: 1,
    name: '项目',
    goal: '目标',
    description: '描述',
    defaultTeamId: null,
  }

  const command = (value: BusinessCommand, key = randomUUID()) =>
    service.command({ key, command: value })

  const before = () =>
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        database.prepare(`SELECT * FROM ${String(name)}`).all(),
      ])

  try {
    for (const fields of [
      { defaultTeamId: '' },
      { defaultTeamId: '   ' },
      { defaultTeamId: ` ${randomUUID()} ` },
      { goal: 'x'.repeat(20_001) },
      { repositoryPath: 'other' },
      { defaultBranch: 'other' },
      { expectedVersion: 0 },
      { goal: null },
    ])
      assert.equal(
        businessCommandSchema.safeParse({ ...input, ...fields }).success,
        false,
      )
    const original = before()
    assert.throws(
      () => command({ ...input, defaultTeamId: randomUUID() }),
      /NOT_FOUND/,
    )
    assert.deepEqual(before(), original)
    database.exec(
      "CREATE TEMP TRIGGER reject_project_event BEFORE INSERT ON workspace_events WHEN NEW.type='project.configured' BEGIN SELECT RAISE(ABORT,'PROJECT_EVENT_FAILURE'); END",
    )
    const key = randomUUID()
    assert.throws(() => command(input, key), /PROJECT_EVENT_FAILURE/)
    assert.deepEqual(before(), original)
    database.exec('DROP TRIGGER reject_project_event')
    command(input, key)
    command(input, key)
    assert.equal(store.snapshot().projects[0]?.version, 2)
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()
        ?.count,
      1,
    )
    assert.throws(
      () => command({ ...input, name: 'other' }, key),
      /IDEMPOTENCY_CONFLICT/,
    )
  } finally {
    await service.shutdown()
    database.close()
  }
})

test('默认团队绑定稳定 ID，计划固定当前版本并拒绝过期项目或团队', async () => {
  const { database, store, run } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const command = (value: BusinessCommand) =>
    service.command({ key: randomUUID(), command: value })

  const team = {
    id: randomUUID(),
    version: 1,
    name: '默认团队',
    coordinatorRoleId: run.roleSnapshot.id,
    roleIds: [run.roleSnapshot.id],
    createdAt: new Date().toISOString(),
  }

  try {
    store.transaction(() =>
      new ProductStore(store).append('team_versions', team, 'team.saved'),
    )
    command({
      type: 'project.configure',
      projectId: run.projectId,
      expectedVersion: 1,
      name: '项目',
      goal: '',
      description: '',
      defaultTeamId: team.id,
    })

    const plan = {
      type: 'team.createTask' as const,
      teamId: team.id,
      expectedTeamVersion: 1,
      expectedProjectVersion: 2,
      projectId: run.projectId,
      title: '团队计划',
      goal: '目标',
      acceptanceCriteria: '人工验收',
      steps: [
        {
          key: 'one',
          roleId: run.roleSnapshot.id,
          title: '步骤',
          goal: '实现',
          acceptanceCriteria: '核验',
          dependsOn: [],
        },
      ],
    }

    const id = command(plan).id
    const parent = store.snapshot().tasks.find((item) => item.id === id)!
    assert.deepEqual(parent.teamSnapshot, team)
    const revisedTeam = { ...team, version: 2, name: '新团队' }
    store.transaction(() =>
      new ProductStore(store).append(
        'team_versions',
        revisedTeam,
        'team.saved',
      ),
    )
    assert.equal(store.snapshot().projects[0]?.defaultTeamId, team.id)
    const snapshot = store.snapshot()
    assert.throws(() => command(plan), /VERSION_CONFLICT/)
    assert.throws(
      () =>
        command({ ...plan, expectedTeamVersion: 2, expectedProjectVersion: 1 }),
      /VERSION_CONFLICT/,
    )
    assert.deepEqual(store.snapshot(), snapshot)
    assert.deepEqual(
      store.snapshot().tasks.find((item) => item.id === id)?.teamSnapshot,
      team,
    )
    command({ ...plan, expectedTeamVersion: 2 })
  } finally {
    await service.shutdown()
    database.close()
  }
})
