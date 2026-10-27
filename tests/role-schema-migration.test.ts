import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  readdirSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { ownedTempDirectory } from './helpers/owned-temp-directory.js'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { WorkspaceStore } from '../src/kernel/workspace-store.js'
import { journalEventsSchema } from '../src/kernel/journal-schema.js'
import { roleVersionSchema } from '../src/kernel/business-contracts.js'
import { createKernel } from '../src/kernel/kernel.js'
import { readSnapshot } from './helpers/local-kernel-fixture.js'
import { backupManifestSchema } from '../src/kernel/backup-contracts.js'
import { inspectBackup } from '../src/kernel/backup-validation.js'
import { restoreWorkspaceBackup } from '../src/kernel/workspace-backup.js'
import { DATA_SCHEMA_VERSION } from '../src/kernel/protocol.js'

const digest = (value: Buffer): string =>
  createHash('sha256').update(value).digest('hex')

/** v7与v8表结构一致，仅角色JSON契约扩展；准备缺少新字段的合法旧数据夹具。 */
const legacyDatabase = (
  directory: string,
  options: { archive?: boolean } = {},
) => {
  mkdirSync(directory)
  const database = new DatabaseSync(join(directory, 'kernel.sqlite'))
  try {
    database.exec(journalEventsSchema)
    const store = new WorkspaceStore(database)

    const role = roleVersionSchema.parse({
      id: randomUUID(),
      version: 1,
      name: '旧版配置',
      responsibility: '保留历史',
      cli: 'codex',
      model: '',
      permission: 'read-only',
      skills: [],
      createdAt: new Date().toISOString(),
    })

    store.transaction(() => store.addRole(role))
    database.exec('DROP TABLE role_feishu_messages; PRAGMA user_version=7')
    // 实际VACUUM INTO备份采用独立日志格式；直接拷贝WAL主库不是合法便携备份。
    if (options.archive) database.exec('PRAGMA journal_mode=DELETE')
    return role
  } finally {
    database.close()
  }
}

const writeLegacyManifest = (directory: string) => {
  const data = readFileSync(join(directory, 'kernel.sqlite'))

  const manifest = backupManifestSchema.parse({
    format: 'weftpilot-workspace-backup',
    formatVersion: 1,
    id: randomUUID(),
    kernelVersion: '0.5.9',
    protocolVersion: 1,
    dataSchemaVersion: 7,
    sourceCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    scope: 'business-data-and-skills',
    files: [{ path: 'kernel.sqlite', size: data.length, sha256: digest(data) }],
  })

  writeFileSync(join(directory, 'backup.json'), JSON.stringify(manifest))
  return manifest
}

test('schema7迁移先保存一致备份，升到当前版本但不重写旧角色JSON；重启仍可读取', async () => {
  const temporary = ownedTempDirectory('weftpilot-role-schema-')
  const directory = temporary.directory
  const data = join(directory, 'legacy-data')
  const role = legacyDatabase(data)
  let kernel = createKernel({
    dataDirectory: data,
    sourceCommit: 'a'.repeat(40),
  })
  try {
    assert.deepEqual((await readSnapshot(kernel)).roles[0], role)
    const file = join(data, 'kernel.schema-7.backup.sqlite')
    assert.equal(existsSync(file), true)
    const original = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(
        original.prepare('PRAGMA user_version').get()?.user_version,
        7,
      )
      assert.equal(
        original.prepare('SELECT data FROM role_versions').get()?.data,
        JSON.stringify(role),
      )
    } finally {
      original.close()
    }
    await kernel.shutdown()

    const upgraded = new DatabaseSync(join(data, 'kernel.sqlite'), {
      readOnly: true,
    })

    try {
      assert.equal(
        upgraded.prepare('PRAGMA user_version').get()?.user_version,
        DATA_SCHEMA_VERSION,
      )
      assert.equal(
        upgraded.prepare('SELECT data FROM role_versions').get()?.data,
        JSON.stringify(role),
      )
    } finally {
      upgraded.close()
    }
    kernel = createKernel({ dataDirectory: data, sourceCommit: 'a'.repeat(40) })
    assert.deepEqual((await readSnapshot(kernel)).roles[0], role)
  } finally {
    await kernel.shutdown()
    temporary.remove()
  }
})

test('schema7备份只读预览与恢复到新目录，原备份字节不变，恢复后才迁移到当前版本', async () => {
  const temporary = ownedTempDirectory('weftpilot-role-schema-')
  const directory = temporary.directory
  const backup = join(directory, 'v7-backup')
  const role = legacyDatabase(backup, { archive: true })
  const data = readFileSync(join(backup, 'kernel.sqlite'))

  const manifest = writeLegacyManifest(backup)
  const database = new DatabaseSync(':memory:')
  try {
    const store = new WorkspaceStore(database)
    assert.deepEqual(inspectBackup(backup).snapshot.roles[0], role)
    assert.equal(
      digest(readFileSync(join(backup, 'kernel.sqlite'))),
      digest(data),
    )
    assert.deepEqual(readdirSync(backup).sort(), [
      'backup.json',
      'kernel.sqlite',
    ])
    const target = join(directory, 'restored')
    restoreWorkspaceBackup({
      store,
      dataDirectory: join(directory, 'active-data'),
      backupDirectory: backup,
      targetDirectory: target,
    })

    const kernel = createKernel({
      dataDirectory: target,
      sourceCommit: 'b'.repeat(40),
    })

    try {
      assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
      assert.deepEqual((await readSnapshot(kernel)).roles[0], role)
    } finally {
      await kernel.shutdown()
    }
    assert.equal(
      digest(readFileSync(join(backup, 'kernel.sqlite'))),
      digest(data),
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

test('拒绝WAL主库伪装的便携备份，预览不会在源目录创建wal/shm文件', () => {
  const temporary = ownedTempDirectory('weftpilot-role-schema-')
  const directory = temporary.directory
  try {
    const backup = join(directory, 'wal-archive')
    legacyDatabase(backup)
    writeLegacyManifest(backup)
    const data = readFileSync(join(backup, 'kernel.sqlite'))
    assert.equal(data[18], 2)
    assert.equal(data[19], 2)
    const files = readdirSync(backup).sort()
    assert.deepEqual(files, ['backup.json', 'kernel.sqlite'])
    assert.throws(() => inspectBackup(backup), /BACKUP_INVALID/)
    assert.deepEqual(readdirSync(backup).sort(), files)
    assert.equal(
      digest(readFileSync(join(backup, 'kernel.sqlite'))),
      digest(data),
    )
  } finally {
    temporary.remove()
  }
})
