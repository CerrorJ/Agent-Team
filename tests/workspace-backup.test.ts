import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import {
  createWorkspaceBackup,
  restoreWorkspaceBackup,
} from '../src/kernel/workspace-backup.js'
import {
  inspectBackup,
  assertBackupQuiescent,
} from '../src/kernel/backup-validation.js'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { createKernel } from '../src/kernel/kernel.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { readSnapshot } from './helpers/local-kernel-fixture.js'
import { setTimeout as delay } from 'node:timers/promises'
import { skillFixtureFetch } from './helpers/skill-fixture.js'

test('工作台一致备份与恢复新目录，不复制凭据/登录/项目文件，不改写原数据', async () => {
  const fixture = await localKernelFixture(async () => ({
    answer: 'not invoked',
  }))

  const database = new DatabaseSync(
    join(fixture.dataDirectory, 'kernel.sqlite'),
  )

  const store = new WorkspaceStore(database)
  try {
    mkdirSync(join(fixture.dataDirectory, 'credentials'))
    writeFileSync(
      join(fixture.dataDirectory, 'credentials/private.txt'),
      'synthetic-credential-must-not-export',
    )
    const target = join(fixture.directory, 'workspace-backup')

    const manifest = createWorkspaceBackup({
      store,
      dataDirectory: fixture.dataDirectory,
      targetDirectory: target,
      sourceCommit: 'a'.repeat(40),
      backupId: randomUUID(),
    })

    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ['kernel.sqlite'],
    )
    assert.equal(
      inspectBackup(target).snapshot.projects[0]?.id,
      fixture.projectId,
    )
    assert.equal(existsSync(join(target, 'credentials')), false)
    assert.equal(existsSync(join(target, 'worktrees')), false)
    const restored = join(fixture.directory, 'restored-data')
    const before = fixture.snapshot()

    const outcome = restoreWorkspaceBackup({
      store,
      dataDirectory: fixture.dataDirectory,
      backupDirectory: target,
      targetDirectory: restored,
    })

    assert.equal(outcome.id, manifest.id)
    assert.equal(outcome.credentialsIncluded, false)
    assert.deepEqual(await fixture.snapshot(), await before)
    assert.equal(
      readFileSync(
        join(fixture.dataDirectory, 'credentials/private.txt'),
        'utf8',
      ),
      'synthetic-credential-must-not-export',
    )

    const second = createKernel({
      dataDirectory: restored,
      sourceCommit: 'a'.repeat(40),
    })

    await second.shutdown()
    assert.equal(
      readdirSync(target).some((path) => path.includes('credentials')),
      false,
    )
  } finally {
    database.close()
    await fixture.cleanup()
  }
})

test('备份损坏、较新schema、目标已存在或在项目内均拒绝，旧数据仍可读取', async () => {
  const fixture = await localKernelFixture(async () => ({
    answer: 'not invoked',
  }))

  const database = new DatabaseSync(
    join(fixture.dataDirectory, 'kernel.sqlite'),
  )

  const store = new WorkspaceStore(database)
  try {
    const target = join(fixture.directory, 'workspace-backup')

    const options = {
      store,
      dataDirectory: fixture.dataDirectory,
      targetDirectory: target,
      sourceCommit: 'a'.repeat(40),
      backupId: randomUUID(),
    }

    createWorkspaceBackup(options)
    assert.equal(createWorkspaceBackup(options).id, options.backupId)
    assert.throws(
      () => createWorkspaceBackup({ ...options, backupId: randomUUID() }),
      /BACKUP_TARGET_INVALID/,
    )
    const projectPath = (await fixture.snapshot()).projects[0]!.repositoryPath
    assert.throws(
      () =>
        createWorkspaceBackup({
          ...options,
          targetDirectory: join(projectPath, 'backup'),
        }),
      /BACKUP_TARGET_INVALID/,
    )
    const manifestPath = join(target, 'backup.json')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dataSchemaVersion: number
    }

    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, dataSchemaVersion: 999 }),
    )
    assert.throws(() => inspectBackup(target), /BACKUP_VERSION_INCOMPATIBLE/)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(target, 'kernel.sqlite'), 'corrupted')
    assert.throws(() => inspectBackup(target), /BACKUP_DIGEST_MISMATCH/)
    assert.equal((await fixture.snapshot()).projects[0]?.id, fixture.projectId)
  } finally {
    database.close()
    await fixture.cleanup()
  }
})

test('待确认进程及等待人工请求不允许生成可恢复备份，不能通过恢复绕过旧执行核对', () => {
  const { store, run, database } = workspaceFixture()
  try {
    const snapshot = store.snapshot()
    assert.throws(
      () =>
        assertBackupQuiescent({
          ...snapshot,
          runs: [{ ...run, status: 'running', processState: 'uncertain' }],
        }),
      /BACKUP_WORKSPACE_BUSY/,
    )
    assert.throws(
      () =>
        assertBackupQuiescent({
          ...snapshot,
          runs: [
            {
              ...run,
              status: 'waiting_approval',
              processState: 'confirmed_ended',
            },
          ],
        }),
      /BACKUP_WORKSPACE_BUSY/,
    )
  } finally {
    database.close()
  }
})

test('备份协议边界与准备恢复共享内核，恢复准备后所有渠道写用例冻结', async () => {
  const fixture = await localKernelFixture(async () => ({
    answer: 'not invoked',
  }))

  let restored: ReturnType<typeof createKernel> | undefined

  const request = (input: Record<string, unknown>) =>
    fixture.kernel.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      ...input,
    })

  try {
    const backupDirectory = join(fixture.directory, 'api-backup')
    assert.equal(
      (await request({ method: 'workspace.backup' })).status,
      'rejected',
    )

    const backup = await request({
      method: 'workspace.backup',
      targetDirectory: backupDirectory,
      backupId: randomUUID(),
    })

    assert.equal(backup.status, 'completed')

    const preview = await request({
      method: 'workspace.backup.inspect',
      backupDirectory,
    })

    assert.equal(preview.status, 'completed')
    await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '备份后新增',
      repository: 'https://github.com/example/skills',
      commit: 'c'.repeat(40),
    })
    const targetDirectory = join(fixture.directory, 'api-restored')
    assert.equal(
      (
        await request({
          method: 'workspace.restore',
          backupDirectory,
          targetDirectory,
        })
      ).status,
      'completed',
    )
    await assert.rejects(
      fixture.command({
        type: 'skill.source.save',
        expectedVersion: 0,
        name: '冻结后拒绝',
        repository: 'https://github.com/example/skills',
        commit: 'd'.repeat(40),
      }),
      /BACKUP_RESTART_REQUIRED/,
    )
    assert.equal((await fixture.snapshot()).skillSources.length, 1)
    await fixture.kernel.shutdown()
    restored = createKernel({
      dataDirectory: targetDirectory,
      sourceCommit: 'a'.repeat(40),
    })
    assert.equal((await readSnapshot(restored)).skillSources.length, 0)
    assert.equal(
      (await readSnapshot(restored)).projects[0]?.id,
      fixture.projectId,
    )
  } finally {
    await restored?.shutdown()
    await fixture.cleanup()
  }
})

test('已安装技能与待安装预览均进入备份并逐文件核对，恢复不自动激活预览', async () => {
  const fixture = await localKernelFixture(
    async () => ({ answer: 'not invoked' }),
    { skillFetch: skillFixtureFetch() },
  )

  const wait = async (id: string, state: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const item = (await fixture.snapshot()).skillImports.find(
        (item) => item.id === id,
      )

      if (item?.state === state) return item
      if (item?.state === 'failed')
        throw new Error(item.failureCode ?? 'failed')
      await delay(20)
    }
    throw new Error('Import timeout')
  }

  let restored: ReturnType<typeof createKernel> | undefined
  try {
    const sourceId = await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '备份技能',
      repository: 'https://github.com/example/skills',
      commit: 'a'.repeat(40),
    })

    const command = {
      type: 'skill.import' as const,
      sourceId,
      sourceVersion: 1,
      directory: 'skills/test-skill',
      licensePath: 'LICENSE',
    }

    const id = await fixture.command(command)
    const preview = await wait(id, 'preview_ready')
    await fixture.command({
      type: 'skill.activate',
      id,
      expectedVersion: preview.version,
      digest: preview.package!.digest,
    })
    await wait(id, 'installed')
    const pendingId = await fixture.command(command)
    await wait(pendingId, 'preview_ready')
    const backupDirectory = join(fixture.directory, 'skill-backup')

    const database = new DatabaseSync(
      join(fixture.dataDirectory, 'kernel.sqlite'),
    )

    try {
      const manifest = createWorkspaceBackup({
        store: new WorkspaceStore(database),
        dataDirectory: fixture.dataDirectory,
        targetDirectory: backupDirectory,
        sourceCommit: 'a'.repeat(40),
        backupId: randomUUID(),
      })

      assert.ok(
        manifest.files.some(
          (file) =>
            file.path === `skills/versions/${id}/skills/test-skill/SKILL.md`,
        ),
      )
      assert.ok(
        manifest.files.some(
          (file) =>
            file.path ===
            `skills/staging/${pendingId}/skills/test-skill/SKILL.md`,
        ),
      )
      restoreWorkspaceBackup({
        store: new WorkspaceStore(database),
        dataDirectory: fixture.dataDirectory,
        backupDirectory,
        targetDirectory: join(fixture.directory, 'skill-restored'),
      })
    } finally {
      database.close()
    }
    restored = createKernel({
      dataDirectory: join(fixture.directory, 'skill-restored'),
      sourceCommit: 'a'.repeat(40),
      skillFetch: skillFixtureFetch(),
    })
    const state = await readSnapshot(restored)
    assert.equal(state.skills.length, 1)
    assert.equal(state.skills[0]?.digest, preview.package!.digest)
    assert.equal(
      state.skillImports.find((item) => item.id === pendingId)?.state,
      'preview_ready',
    )
  } finally {
    await restored?.shutdown()
    await fixture.cleanup()
  }
})
