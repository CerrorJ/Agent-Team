import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectProject } from '../src/kernel/project-inspection.js'
import { projectInspectionSchema } from '../src/kernel/project-inspection-contracts.js'
import { preflightFixture } from './helpers/preflight-fixture.js'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'

test('真实Git只读检查区分默认/当前分支、提交与脏文件，保留索引和用户改动', () => {
  const f = preflightFixture()
  try {
    const file = join(f.directory, 'user.txt')
    writeFileSync(file, 'baseline')
    f.git(['add', '--', 'user.txt'])
    f.commit()
    const baseline = f.git(['rev-parse', 'HEAD'])
    f.git(['checkout', '-b', 'user-work'])
    writeFileSync(file, 'user existing change')
    f.git(['add', '--', 'user.txt'])
    f.commit()
    writeFileSync(file, 'user unstaged change')
    writeFileSync(join(f.directory, 'untracked.txt'), 'retain me')
    const index = readFileSync(join(f.directory, '.git/index'))
    const before = f.store.snapshot()
    const result = inspectProject(f.store, f.task.projectId)
    assert.equal(result.git.state, 'verified')
    if (result.git.state !== 'verified') throw new Error('expected verified')
    assert.equal(result.git.currentBranch, 'user-work')
    assert.equal(result.git.defaultCommit, baseline)
    assert.equal(result.git.currentCommit, f.git(['rev-parse', 'HEAD']))
    assert.equal(result.git.dirty, true)
    assert.deepEqual(readFileSync(join(f.directory, '.git/index')), index)
    assert.equal(readFileSync(file, 'utf8'), 'user unstaged change')
    assert.equal(
      readFileSync(join(f.directory, 'untracked.txt'), 'utf8'),
      'retain me',
    )
    assert.deepEqual(f.store.snapshot(), before)
  } finally {
    f.cleanup()
  }
})

test('真实Git清洁/分离HEAD与凭据脱敏，检查不更新已保存项目元数据', () => {
  const f = preflightFixture()
  try {
    f.git([
      'remote',
      'add',
      'origin',
      'https://synthetic-user:private-test-password@example.invalid/repo.git?token=private-query#secret',
    ])
    const before = f.store.snapshot()
    f.git(['checkout', '--detach'])
    const result = inspectProject(f.store, f.task.projectId)
    assert.equal(result.gitUrl, 'https://example.invalid/repo.git')
    assert.equal(result.git.state, 'verified')
    if (result.git.state !== 'verified') throw new Error('expected verified')
    assert.equal(result.git.currentBranch, null)
    assert.equal(result.git.dirty, false)
    assert.deepEqual(f.store.snapshot(), before)
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-test-password|private-query|synthetic-user|#secret/,
    )
  } finally {
    f.cleanup()
  }
})

test('仓库失效返回明确不可检查，不能把缺少Git当作干净或改写项目', () => {
  const f = preflightFixture()
  const source = join(f.directory, '.git')
  const saved = join(f.directory, '.git-owned-fixture-saved')
  try {
    const before = f.store.snapshot()
    renameSync(source, saved)
    const result = inspectProject(f.store, f.task.projectId)
    assert.deepEqual(result.git, {
      state: 'unavailable',
      code: 'GIT_ROOT_REQUIRED',
    })
    assert.deepEqual(f.store.snapshot(), before)
  } finally {
    renameSync(saved, source)
    f.cleanup()
  }
})

test('版本化命名查询严格拒绝任意路径/未知项目，重复检查不创建任务、事件或CLI', async () => {
  let calls = 0

  const f = await localKernelFixture(async () => {
    calls++
    throw new Error('must not execute')
  })

  const input = {
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'workspace.project.inspect',
    input: { projectId: f.projectId },
  }

  try {
    const before = await f.snapshot()
    for (let index = 0; index < 2; index++) {
      const response = await f.kernel.dispatch({
        ...input,
        requestId: randomUUID(),
      })

      assert.equal(response.status, 'completed')
      assert.equal(
        projectInspectionSchema.parse(response.result).projectId,
        f.projectId,
      )
    }

    const invalid = await f.kernel.dispatch({
      ...input,
      input: { ...input.input, repositoryPath: '/arbitrary' },
    })

    assert.equal(invalid.status, 'rejected')
    if (invalid.status === 'rejected')
      assert.equal(invalid.error.code, 'VALIDATION_FAILED')

    const missing = await f.kernel.dispatch({
      ...input,
      input: { projectId: randomUUID() },
    })

    assert.equal(missing.status, 'rejected')
    if (missing.status === 'rejected')
      assert.equal(missing.error.code, 'NOT_FOUND')
    assert.equal(calls, 0)
    assert.deepEqual(await f.snapshot(), before)
  } finally {
    await f.cleanup()
  }
})
