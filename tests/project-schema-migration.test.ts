import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { readSnapshot } from './helpers/local-kernel-fixture.js'
import { createKernel } from '../src/kernel/kernel.js'
import { inspectBackup } from '../src/kernel/backup-validation.js'
import { restoreWorkspaceBackup } from '../src/kernel/workspace-backup.js'
import { DATA_SCHEMA_VERSION } from '../src/kernel/protocol.js'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { journalEventsSchema } from '../src/kernel/journal-schema.js'

const legacyWorkspace = (directory: string) => {
  mkdirSync(directory)
  const fixture = workspaceFixture()
  fixture.database.exec(journalEventsSchema)
  // 缺省新字段的受控终态历史，迁移不启动CLI，也不冒称真实交付成功。
  fixture.database.prepare('UPDATE runs SET state=?,data=?').run(
    'stopped',
    JSON.stringify({
      ...fixture.run,
      status: 'stopped',
      processState: 'confirmed_ended',
    }),
  )

  const rows = () =>
    ['projects', 'tasks', 'runs', 'workspace_events'].map((table) =>
      fixture.database
        .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
        .all(),
    )

  const original = rows()
  fixture.database.exec(
    'DROP TABLE role_feishu_messages; PRAGMA user_version=9',
  )
  fixture.database
    .prepare('VACUUM INTO ?')
    .run(join(directory, 'kernel.sqlite'))
  fixture.database.close()
  return original
}

test('schema9升级当前契约前一致性备份，旧项目/Run/任务/事件原始JSON不变，重启不补造配置', async () => {
  const temporary = ownedTempDirectory('weftpilot-project-schema-')
  const directory = join(temporary.directory, 'legacy')
  const original = legacyWorkspace(directory)
  let kernel = createKernel({
    dataDirectory: directory,
    sourceCommit: 'a'.repeat(40),
  })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
    assert.ok(kernel.handshake.capabilities.includes('project-settings'))
    const snapshot = await readSnapshot(kernel)
    assert.equal(Object.hasOwn(snapshot.projects[0]!, 'goal'), false)
    assert.equal(
      Object.hasOwn(snapshot.runs[0]!, 'projectContextSnapshot'),
      false,
    )
    await kernel.shutdown()
    for (const file of ['kernel.sqlite', 'kernel.schema-9.backup.sqlite']) {
      const database = new DatabaseSync(join(directory, file), {
        readOnly: true,
      })

      try {
        assert.equal(
          database.prepare('PRAGMA user_version').get()?.user_version,
          file === 'kernel.sqlite' ? DATA_SCHEMA_VERSION : 9,
        )
        assert.deepEqual(
          ['projects', 'tasks', 'runs', 'workspace_events'].map((table) =>
            database.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all(),
          ),
          original,
        )
      } finally {
        database.close()
      }
    }
    kernel = createKernel({
      dataDirectory: directory,
      sourceCommit: 'a'.repeat(40),
    })
    assert.deepEqual((await readSnapshot(kernel)).projects, snapshot.projects)
    assert.deepEqual((await readSnapshot(kernel)).runs, snapshot.runs)
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})

test('schema9备份只读预览与恢复不改源字节，恢复副本启动升级当前契约', async () => {
  const temporary = ownedTempDirectory('weftpilot-project-backup-')
  const backup = join(temporary.directory, 'backup')
  const original = legacyWorkspace(backup)
  const file = join(backup, 'kernel.sqlite')
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')

  const manifest = {
    format: 'weftpilot-workspace-backup',
    formatVersion: 1,
    id: randomUUID(),
    kernelVersion: '0.10.0',
    protocolVersion: 1,
    dataSchemaVersion: 9,
    sourceCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    scope: 'business-data-and-skills',
    files: [{ path: 'kernel.sqlite', size: bytes.length, sha256: digest }],
  }

  writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest))
  const database = new DatabaseSync(':memory:')
  try {
    assert.equal(inspectBackup(backup).snapshot.projects[0]?.version, 1)
    const target = join(temporary.directory, 'restored')
    restoreWorkspaceBackup({
      store: new WorkspaceStore(database),
      dataDirectory: join(temporary.directory, 'active'),
      backupDirectory: backup,
      targetDirectory: target,
    })

    const kernel = createKernel({
      dataDirectory: target,
      sourceCommit: 'b'.repeat(40),
    })

    try {
      assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
      assert.equal(
        Object.hasOwn((await readSnapshot(kernel)).projects[0]!, 'goal'),
        false,
      )
    } finally {
      await kernel.shutdown()
    }

    const restored = new DatabaseSync(join(target, 'kernel.sqlite'), {
      readOnly: true,
    })

    try {
      assert.deepEqual(
        ['projects', 'tasks', 'runs', 'workspace_events'].map((table) =>
          restored.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all(),
        ),
        original,
      )
    } finally {
      restored.close()
    }
    assert.equal(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
      digest,
    )
    assert.deepEqual(
      JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8')),
      manifest,
    )
  } finally {
    database.close()
    temporary.remove()
  }
})
