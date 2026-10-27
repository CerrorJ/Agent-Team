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

const makeLegacy = (data: string) => {
  mkdirSync(data)
  const fixture = workspaceFixture({ persistRun: false })
  fixture.database.exec(journalEventsSchema)

  const requirement = {
    id: randomUUID(),
    version: 1,
    projectId: fixture.run.projectId,
    title: 'schema8需求',
    body: '历史原文',
    acceptanceCriteria: '旧标准',
    createdAt: new Date().toISOString(),
  }

  fixture.store.transaction(() =>
    new ProductStore(fixture.store).append(
      'requirement_versions',
      requirement,
      'requirement.saved',
    ),
  )
  fixture.database.exec('PRAGMA user_version=8')
  fixture.database.prepare('VACUUM INTO ?').run(join(data, 'kernel.sqlite'))
  fixture.database.close()
  return requirement
}

test('schema8升级当前版本先备份、不重写旧需求JSON或补造元数据，重启仍可读', async () => {
  const temporary = ownedTempDirectory('weftpilot-requirement-schema-')
  const data = join(temporary.directory, 'legacy')
  const original = makeLegacy(data)
  let kernel = createKernel({
    dataDirectory: data,
    sourceCommit: 'a'.repeat(40),
  })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
    assert.ok(kernel.handshake.capabilities.includes('requirement-metadata'))
    assert.deepEqual((await readSnapshot(kernel)).requirements[0], original)
    await kernel.shutdown()
    for (const file of ['kernel.sqlite', 'kernel.schema-8.backup.sqlite']) {
      const database = new DatabaseSync(join(data, file), { readOnly: true })
      try {
        assert.equal(
          database.prepare('PRAGMA user_version').get()?.user_version,
          file === 'kernel.sqlite' ? DATA_SCHEMA_VERSION : 8,
        )
        assert.equal(
          database.prepare('SELECT data FROM requirement_versions').get()?.data,
          JSON.stringify(original),
        )
      } finally {
        database.close()
      }
    }
    kernel = createKernel({ dataDirectory: data, sourceCommit: 'a'.repeat(40) })
    assert.deepEqual((await readSnapshot(kernel)).requirements[0], original)
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})

test('schema8备份只读预览与恢复保留字节，恢复副本启动后才升级当前版本', async () => {
  const temporary = ownedTempDirectory('weftpilot-requirement-backup-')
  const backup = join(temporary.directory, 'backup')
  const requirement = makeLegacy(backup)
  const file = join(backup, 'kernel.sqlite')
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')

  const manifest = {
    format: 'weftpilot-workspace-backup',
    formatVersion: 1,
    id: randomUUID(),
    kernelVersion: '0.9.4',
    protocolVersion: 1,
    dataSchemaVersion: 8,
    sourceCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    scope: 'business-data-and-skills',
    files: [{ path: 'kernel.sqlite', size: bytes.length, sha256: digest }],
  }

  writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest))
  const database = new DatabaseSync(':memory:')
  try {
    assert.deepEqual(
      inspectBackup(backup).snapshot.requirements[0],
      requirement,
    )
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
      assert.deepEqual(
        (await readSnapshot(kernel)).requirements[0],
        requirement,
      )
    } finally {
      await kernel.shutdown()
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
