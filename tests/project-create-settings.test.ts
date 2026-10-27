import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { WorkspaceService } from '../src/kernel/workspace-service.js'
import { businessCommandSchema } from '../src/kernel/business-contracts.js'

test('真实 Git 创建项目：仅保存允许字段，旧省略命令重放兼容，新配置原子写入', async () => {
  const temporary = ownedTempDirectory('weftpilot-project-create-')
  const repositoryPath = join(temporary.directory, 'repository')
  mkdirSync(repositoryPath)
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@weftpilot.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'baseline',
    ],
    { cwd: repositoryPath, stdio: 'ignore' },
  )
  const { database, store } = workspaceFixture({ persistRun: false })
  const service = new WorkspaceService({ store, dataDirectory: 'unused' })

  const base = {
    type: 'project.create' as const,
    name: '真实仓库',
    defaultBranch: 'main',
    repositoryPath,
  }

  const key = randomUUID()

  try {
    const before = store.snapshot()
    assert.throws(
      () =>
        service.command({
          key,
          command: {
            ...base,
            goal: '项目目标',
            description: '描述',
            defaultTeamId: randomUUID(),
          },
        }),
      /NOT_FOUND/,
    )
    assert.deepEqual(store.snapshot(), before)
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()
        ?.count,
      0,
    )
    const id = service.command({ key, command: base }).id
    const project = store.snapshot().projects.find((item) => item.id === id)!
    assert.equal(project.repositoryPath, repositoryPath)
    assert.equal(Object.hasOwn(project, 'baselineCommit'), false)
    assert.equal(Object.hasOwn(project, 'goal'), false)
    assert.equal(
      Object.hasOwn(businessCommandSchema.parse(base), 'goal'),
      false,
    )
    assert.equal(
      service.command({ key, command: JSON.parse(JSON.stringify(base)) }).id,
      id,
    )
    assert.equal(store.snapshot().projects.length, before.projects.length + 1)
    // 删除本测试创建的业务行后，用独立幂等键验证新创建的全部字段同事务保存。
    database.prepare('DELETE FROM projects WHERE id=?').run(id)

    const created = service.command({
      key: randomUUID(),
      command: {
        ...base,
        goal: '目标',
        description: '上下文',
        defaultTeamId: null,
      },
    }).id

    assert.deepEqual(
      store.snapshot().projects.find((item) => item.id === created),
      {
        ...project,
        id: created,
        goal: '目标',
        description: '上下文',
        defaultTeamId: null,
        createdAt: store
          .snapshot()
          .projects.find((item) => item.id === created)!.createdAt,
      },
    )
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repositoryPath,
        encoding: 'utf8',
      }),
      '',
    )
  } finally {
    await service.shutdown()
    database.close()
    temporary.remove()
  }
})
