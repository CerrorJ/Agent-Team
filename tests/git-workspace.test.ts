import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  projectBaseline,
  inspectProjectRepository,
  prepareRunWorktree,
  runWorkDirectory,
  collectRunDelivery,
} from '../src/kernel/git-workspace.js'
import type { Project, Run } from '../src/kernel/business-contracts.js'

test('中文空格路径的真实 worktree 保留主仓库文件，脏目录阻止启动', () => {
  const directory = mkdtempSync(join(tmpdir(), '纬舟 Git # '))
  const repositoryPath = join(directory, '项目仓库')
  mkdirSync(repositoryPath)

  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()

  try {
    assert.throws(
      () => inspectProjectRepository({ repositoryPath, defaultBranch: 'main' }),
      /GIT_ROOT_REQUIRED/,
    )
    git(['init', '-b', 'main'])
    writeFileSync(join(repositoryPath, 'baseline.txt'), 'baseline')
    git(['add', '.'])
    git([
      '-c',
      'user.name=WeftPilot Test',
      '-c',
      'user.email=test@weftpilot.invalid',
      'commit',
      '-m',
      'baseline',
    ])

    const hookDirectory = join(directory, 'hooks')
    mkdirSync(hookDirectory)

    const hookSentinel = join(directory, 'hook-executed.txt').replace(
      /\\/g,
      '/',
    )

    writeFileSync(
      join(hookDirectory, 'post-checkout'),
      `#!/bin/sh\nprintf unexpected > '${hookSentinel}'\n`,
      { mode: 0o755 },
    )
    git(['config', 'core.hooksPath', hookDirectory])
    git([
      'remote',
      'add',
      'origin',
      'https://synthetic-user:synthetic-secret@example.invalid/repository.git?token=synthetic',
    ])
    assert.throws(
      () =>
        inspectProjectRepository({ repositoryPath, defaultBranch: 'missing' }),
      /GIT_BRANCH_INVALID/,
    )

    const inspected = inspectProjectRepository({
      repositoryPath,
      defaultBranch: 'main',
    })

    assert.equal(inspected.gitUrl, 'https://example.invalid/repository.git')

    const project: Project = {
      ...inspected,
      id: randomUUID(),
      version: 1,
      name: '测试项目',
      defaultBranch: 'main',
      createdAt: new Date().toISOString(),
    }

    writeFileSync(join(repositoryPath, 'existing.txt'), '用户已有改动')
    assert.throws(() => projectBaseline(project), /GIT_DIRTY/)
    assert.equal(
      readFileSync(join(repositoryPath, 'existing.txt'), 'utf8'),
      '用户已有改动',
    )
    rmSync(join(repositoryPath, 'existing.txt'))
    const id = randomUUID()

    const workDirectory = runWorkDirectory({
      dataDirectory: directory,
      runId: id,
    })

    const run = {
      id,
      workDirectory,
      baselineCommit: projectBaseline(project),
      executionBranch: `weftpilot/run-${id}`,
    } as Run

    prepareRunWorktree({ project, run, dataDirectory: directory })
    assert.equal(existsSync(hookSentinel), false)
    writeFileSync(join(workDirectory, 'new.txt'), '交付文件')
    assert.ok(collectRunDelivery(run).diff.includes('交付文件'))
    assert.equal(git(['status', '--porcelain']), '')
    assert.throws(
      () => prepareRunWorktree({ project, run, dataDirectory: directory }),
      /STATE_UNCERTAIN/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
