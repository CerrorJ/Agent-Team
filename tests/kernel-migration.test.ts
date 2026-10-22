import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createKernel } from '../src/kernel/kernel.js'

test('M0 在一致备份后迁移到当前 schema，备份保留原生命周期事件', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-migration-'))
  const database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  database.exec(
    `CREATE TABLE events(sequence INTEGER PRIMARY KEY,event_id TEXT,occurred_at TEXT,type TEXT); PRAGMA user_version=1;`,
  )
  database
    .prepare('INSERT INTO events VALUES(?,?,?,?)')
    .run(1, randomUUID(), new Date().toISOString(), 'kernel.started')
  database.close()
  const kernel = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, 3)

    const backup = new DatabaseSync(
      join(dataDirectory, 'kernel.schema-1.backup.sqlite'),
      { readOnly: true },
    )

    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1)
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    assert.equal(
      backup.prepare('SELECT COUNT(*) AS total FROM events').get()?.total,
      1,
    )
    backup.close()
  } finally {
    await kernel.shutdown()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('M1 schema 2 升级保留项目并生成独立一致备份，重新打开仍启用外键', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-schema2-'))
  let kernel = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  await kernel.shutdown()
  const database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))

  const project = {
    id: randomUUID(),
    version: 1,
    name: 'M1 项目',
    repositoryPath: 'unused',
    gitUrl: '',
    defaultBranch: 'main',
    createdAt: new Date().toISOString(),
  }

  database.exec(
    'DROP TABLE model_profiles; DROP TABLE requirement_versions; DROP TABLE team_versions; DROP TABLE role_readiness; PRAGMA user_version=2;',
  )
  database
    .prepare('INSERT INTO projects(id,repository_path,data) VALUES(?,?,?)')
    .run(project.id, project.repositoryPath, JSON.stringify(project))
  database.close()
  kernel = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    const result = await kernel.dispatch({
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'workspace.snapshot',
    })

    assert.notEqual(result.status, 'rejected')
    assert.ok('result' in result)
    assert.equal(
      (result.result as { projects: { name: string }[] }).projects[0]?.name,
      'M1 项目',
    )

    const backup = new DatabaseSync(
      join(dataDirectory, 'kernel.schema-2.backup.sqlite'),
      { readOnly: true },
    )

    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2)
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    backup.close()
  } finally {
    await kernel.shutdown()
  }
  const reopened = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  const { WorkspaceStore } = await import('../src/kernel/workspace-store.js')
  new WorkspaceStore(reopened)
  assert.equal(reopened.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 3)
  reopened.close()
  rmSync(dataDirectory, { recursive: true, force: true })
})
