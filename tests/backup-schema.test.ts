import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, parse } from 'node:path'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import {
  createWorkspaceBackup,
  restoreWorkspaceBackup,
} from '../src/kernel/workspace-backup.js'
import {
  inspectBackup,
  validateBackupTarget,
} from '../src/kernel/backup-validation.js'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'

const mutations = [
  [
    'trigger',
    `CREATE TRIGGER malicious AFTER INSERT ON events BEGIN UPDATE projects SET data=json_set(data,'$.name','MALICIOUS'); END;`,
  ],
  ['view', 'CREATE VIEW malicious AS SELECT * FROM projects'],
  ['virtual-table', 'CREATE VIRTUAL TABLE malicious USING fts5(body)'],
  [
    'index',
    `DROP INDEX one_active_run_per_task; CREATE UNIQUE INDEX one_active_run_per_task ON runs(task_id) WHERE state IN ('running');`,
  ],
] as const

for (const [name, sql] of mutations)
  test(`合法文件摘要不能授权外来或改写的SQLite schema：${name}`, async () => {
    const fixture = await localKernelFixture(async () => {
      throw new Error('CLI must not run')
    })

    const database = new DatabaseSync(
      join(fixture.dataDirectory, 'kernel.sqlite'),
    )

    const store = new WorkspaceStore(database)
    try {
      const directory = join(fixture.directory, 'backup')

      const manifest = createWorkspaceBackup({
        store,
        dataDirectory: fixture.dataDirectory,
        targetDirectory: directory,
        sourceCommit: 'a'.repeat(40),
        backupId: randomUUID(),
      })

      const altered = new DatabaseSync(join(directory, 'kernel.sqlite'))
      altered.exec(sql)
      assert.equal(
        altered.prepare('PRAGMA quick_check').get()?.quick_check,
        'ok',
      )
      altered.close()
      const bytes = readFileSync(join(directory, 'kernel.sqlite'))
      manifest.files = manifest.files.map((file) =>
        file.path === 'kernel.sqlite'
          ? {
              ...file,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }
          : file,
      )
      writeFileSync(join(directory, 'backup.json'), JSON.stringify(manifest))
      assert.throws(() => inspectBackup(directory), /BACKUP_INVALID/)
      const target = join(fixture.directory, 'restored')
      assert.throws(
        () =>
          restoreWorkspaceBackup({
            store,
            dataDirectory: fixture.dataDirectory,
            backupDirectory: directory,
            targetDirectory: target,
          }),
        /BACKUP_INVALID/,
      )
      assert.equal(existsSync(target), false)
      assert.notEqual((await fixture.snapshot()).projects[0]?.name, 'MALICIOUS')
    } finally {
      database.close()
      await fixture.cleanup()
    }
  })

test('盘根或POSIX根目录作为备份父目录不截断目标名称；测试不写入根目录', async () => {
  const fixture = await localKernelFixture(async () => {
    throw new Error('CLI must not run')
  })

  try {
    const target = join(
      parse(fixture.directory).root,
      `weftpilot-synthetic-${randomUUID()}`,
    )

    assert.equal(
      validateBackupTarget({
        target,
        dataDirectory: fixture.dataDirectory,
        snapshot: await fixture.snapshot(),
      }),
      target,
    )
    assert.equal(existsSync(target), false)
  } finally {
    await fixture.cleanup()
  }
})
