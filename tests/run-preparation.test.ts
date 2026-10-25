import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { join } from 'node:path'
import { workspaceFixture } from './helpers/run-fixture.js'
import { executeQueuedRun } from '../src/kernel/run-execution.js'
import { runSchema } from '../src/kernel/business-contracts.js'

test('已有执行目录的带前缀异常保留状态待确认，不启动CLI或覆盖文件', async () => {
  const temporary = ownedTempDirectory('weftpilot-recovery-boundary-')
  const directory = temporary.directory
  const repositoryPath = join(directory, 'repository')
  mkdirSync(repositoryPath)
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=WeftPilot Test',
      '-c',
      'user.email=test@weftpilot.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'baseline',
    ],
    { cwd: repositoryPath, stdio: 'ignore' },
  )

  const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryPath,
    encoding: 'utf8',
  }).trim()

  const { database, store, run } = workspaceFixture({
    repositoryPath,
    baselineCommit,
    dataDirectory: directory,
  })

  try {
    mkdirSync(run.workDirectory, { recursive: true })
    writeFileSync(join(run.workDirectory, 'preserve.txt'), '保留已有现场')
    await executeQueuedRun(
      {
        store,
        runId: run.id,
        dataDirectory: directory,
        controller: new AbortController(),
      },
      async () => assert.fail('不应执行 CLI'),
    )
    const recovered = store.get('runs', run.id, runSchema)
    assert.equal(recovered.processState, 'uncertain')
    assert.equal(recovered.failureCode, 'STATE_UNCERTAIN')
    assert.equal(recovered.status, 'preparing')
    assert.equal(
      readFileSync(join(run.workDirectory, 'preserve.txt'), 'utf8'),
      '保留已有现场',
    )
  } finally {
    database.close()
    temporary.remove()
  }
})
