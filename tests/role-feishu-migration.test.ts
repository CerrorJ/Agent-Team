import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceFixture } from './helpers/run-fixture.js'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { readSnapshot } from './helpers/local-kernel-fixture.js'
import { journalEventsSchema } from '../src/kernel/journal-schema.js'
import { createKernel } from '../src/kernel/kernel.js'
import { DATA_SCHEMA_VERSION } from '../src/kernel/protocol.js'
import { inspectBackup } from '../src/kernel/backup-validation.js'
import { verifyBackupSchema } from '../src/kernel/backup-schema.js'

const legacyFixture = (directory: string) => {
  mkdirSync(directory)
  const fixture = workspaceFixture({ persistRun: false })
  fixture.store.transaction(() =>
    fixture.store.addRun({
      ...fixture.run,
      status: 'stopped',
      processState: 'confirmed_ended',
    }),
  )
  fixture.database.exec(journalEventsSchema)
  fixture.database.exec(
    'DROP TABLE role_feishu_messages; PRAGMA user_version=11',
  )
  fixture.database
    .prepare('VACUUM INTO ?')
    .run(join(directory, 'kernel.sqlite'))

  const original = ['role_versions', 'tasks', 'runs', 'workspace_events'].map(
    (name) => [
      name,
      fixture.database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    ],
  )

  fixture.database.close()
  return original
}

test('schema11先备份再升12，不补写旧角色/Run路由及历史JSON，重启不重复迁移', async () => {
  const temporary = ownedTempDirectory('weftpilot-role-feishu-schema-')
  const directory = join(temporary.directory, 'old')
  const original = legacyFixture(directory)
  let kernel = createKernel({
    dataDirectory: directory,
    sourceCommit: 'a'.repeat(40),
  })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
    assert.ok(kernel.handshake.capabilities.includes('role-feishu-routing'))
    assert.equal(
      Object.hasOwn((await readSnapshot(kernel)).roles[0]!, 'feishuBinding'),
      false,
    )
    await kernel.shutdown()
    for (const file of ['kernel.sqlite', 'kernel.schema-11.backup.sqlite']) {
      const database = new DatabaseSync(join(directory, file), {
        readOnly: true,
      })

      try {
        assert.equal(
          database.prepare('PRAGMA user_version').get()?.user_version,
          file === 'kernel.sqlite' ? DATA_SCHEMA_VERSION : 11,
        )
        assert.deepEqual(
          ['role_versions', 'tasks', 'runs', 'workspace_events'].map((name) => [
            name,
            database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
          ]),
          original,
        )
        assert.equal(
          Boolean(
            database
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name='role_feishu_messages'",
              )
              .get(),
          ),
          file === 'kernel.sqlite',
        )
        assert.equal(
          database.prepare('PRAGMA quick_check').get()?.quick_check,
          'ok',
        )
        verifyBackupSchema(database)
      } finally {
        database.close()
      }
    }
    kernel = createKernel({
      dataDirectory: directory,
      sourceCommit: 'a'.repeat(40),
    })
    assert.equal((await readSnapshot(kernel)).roles.length, 1)
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})

test('旧11备份按旧schema只读核验，新12拒绝多余或被修改投影；不修改源归档', () => {
  const temporary = ownedTempDirectory('weftpilot-role-feishu-backup-')
  const directory = join(temporary.directory, 'old')
  legacyFixture(directory)
  const file = join(directory, 'kernel.sqlite')
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(
    join(directory, 'backup.json'),
    JSON.stringify({
      format: 'weftpilot-workspace-backup',
      formatVersion: 1,
      id: randomUUID(),
      kernelVersion: '0.12.0',
      protocolVersion: 1,
      dataSchemaVersion: 11,
      sourceCommit: 'a'.repeat(40),
      createdAt: new Date().toISOString(),
      scope: 'business-data-and-skills',
      files: [{ path: 'kernel.sqlite', size: bytes.length, sha256: digest }],
    }),
  )
  const fixture = workspaceFixture({ persistRun: false })
  fixture.database.exec(journalEventsSchema)
  try {
    assert.equal(inspectBackup(directory).snapshot.runs.length, 1)
    assert.equal(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
      digest,
    )
    verifyBackupSchema(fixture.database)
    fixture.database.exec(
      'ALTER TABLE role_feishu_messages ADD COLUMN unauthorized TEXT',
    )
    assert.throws(() => verifyBackupSchema(fixture.database), /BACKUP_INVALID/)
  } finally {
    fixture.database.close()
    temporary.remove()
  }
})
