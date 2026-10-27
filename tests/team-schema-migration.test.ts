import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { workspaceFixture } from './helpers/run-fixture.js'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { readSnapshot } from './helpers/local-kernel-fixture.js'
import { ProductStore } from '../src/kernel/product-store.js'
import { createKernel } from '../src/kernel/kernel.js'
import { inspectBackup } from '../src/kernel/backup-validation.js'
import { restoreWorkspaceBackup } from '../src/kernel/workspace-backup.js'
import { DATA_SCHEMA_VERSION } from '../src/kernel/protocol.js'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { journalEventsSchema } from '../src/kernel/journal-schema.js'

const legacyTeams = (directory: string) => {
  mkdirSync(directory)
  const { database, store, run } = workspaceFixture({ persistRun: false })
  database.exec(journalEventsSchema)

  const team = {
    id: randomUUID(),
    version: 1,
    name: '历史重名',
    roleIds: [run.roleSnapshot.id],
    coordinatorRoleId: run.roleSnapshot.id,
    createdAt: new Date().toISOString(),
  }

  const second = { ...team, id: randomUUID() }
  store.transaction(() => {
    new ProductStore(store).append('team_versions', team, 'team.saved')
    new ProductStore(store).append('team_versions', second, 'team.saved')
  })

  const original = database
    .prepare('SELECT data FROM team_versions ORDER BY rowid')
    .all()

  database.exec('DROP TABLE role_feishu_messages; PRAGMA user_version=10')
  database.prepare('VACUUM INTO ?').run(join(directory, 'kernel.sqlite'))
  database.close()
  return { team, second, original }
}

test('schema10升级当前契约前一致性备份，重名团队/旧缺省说明JSON不改，重启不补造配置', async () => {
  const temporary = ownedTempDirectory('weftpilot-team-schema-')
  const directory = join(temporary.directory, 'legacy')
  const { team, second, original } = legacyTeams(directory)
  let kernel = createKernel({
    dataDirectory: directory,
    sourceCommit: 'a'.repeat(40),
  })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
    assert.ok(kernel.handshake.capabilities.includes('team-configuration'))
    assert.deepEqual((await readSnapshot(kernel)).teams, [team, second])
    await kernel.shutdown()
    for (const file of ['kernel.sqlite', 'kernel.schema-10.backup.sqlite']) {
      const database = new DatabaseSync(join(directory, file), {
        readOnly: true,
      })

      try {
        assert.equal(
          database.prepare('PRAGMA user_version').get()?.user_version,
          file === 'kernel.sqlite' ? DATA_SCHEMA_VERSION : 10,
        )
        assert.deepEqual(
          database
            .prepare('SELECT data FROM team_versions ORDER BY rowid')
            .all(),
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
    assert.deepEqual((await readSnapshot(kernel)).teams, [team, second])
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})

test('schema10备份只读预览与恢复不改源字节，恢复副本才升级当前契约并保留历史重名', async () => {
  const temporary = ownedTempDirectory('weftpilot-team-backup-')
  const backup = join(temporary.directory, 'backup')
  const { team, second, original } = legacyTeams(backup)
  const file = join(backup, 'kernel.sqlite')
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')

  const manifest = {
    format: 'weftpilot-workspace-backup',
    formatVersion: 1,
    id: randomUUID(),
    kernelVersion: '0.11.0',
    protocolVersion: 1,
    dataSchemaVersion: 10,
    sourceCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    scope: 'business-data-and-skills',
    files: [{ path: 'kernel.sqlite', size: bytes.length, sha256: digest }],
  }

  writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest))
  const database = new DatabaseSync(':memory:')
  try {
    assert.deepEqual(inspectBackup(backup).snapshot.teams, [team, second])
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
      assert.deepEqual((await readSnapshot(kernel)).teams, [team, second])
    } finally {
      await kernel.shutdown()
    }

    const restored = new DatabaseSync(join(target, 'kernel.sqlite'), {
      readOnly: true,
    })

    try {
      assert.deepEqual(
        restored.prepare('SELECT data FROM team_versions ORDER BY rowid').all(),
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
