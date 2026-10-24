import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createKernel } from '../src/kernel/kernel.js'
import { journalEventsSchema } from '../src/kernel/journal-schema.js'
import { verifyBackupSchema } from '../src/kernel/backup-schema.js'
import { DATA_SCHEMA_VERSION } from '../src/kernel/protocol.js'

test('schema5升级保留人工请求表，并在新增飞书投影前保存一致备份', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-v6-migration-'))
  const first = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  await first.shutdown()
  const previous = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  previous.exec(
    'DROP TABLE skill_sources; DROP TABLE skill_imports; DROP TABLE skill_packages; DROP TABLE feishu_messages; DROP TABLE feishu_binding; PRAGMA user_version=5',
  )
  previous.close()
  const current = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    assert.equal(current.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)

    const backup = new DatabaseSync(
      join(dataDirectory, 'kernel.schema-5.backup.sqlite'),
      { readOnly: true },
    )

    try {
      assert.equal(
        backup.prepare('PRAGMA quick_check').get()?.quick_check,
        'ok',
      )
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 5)
      assert.equal(
        backup
          .prepare("SELECT name FROM sqlite_master WHERE name='feishu_binding'")
          .get(),
        undefined,
      )
      assert.equal(
        backup.prepare('SELECT COUNT(*) AS n FROM human_requests').get()?.n,
        0,
      )
    } finally {
      backup.close()
    }
  } finally {
    await current.shutdown()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('schema 4 升级前一致备份不含新表，升级后等待态纳入每任务唯一活动执行约束', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-v5-migration-'))
  const first = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  await first.shutdown()
  const previous = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  previous.exec(`DROP TABLE skill_sources; DROP TABLE skill_imports; DROP TABLE skill_packages; DROP TABLE feishu_messages; DROP TABLE feishu_binding; DROP TABLE human_requests;
    DROP INDEX one_active_run_per_task;
    CREATE UNIQUE INDEX one_active_run_per_task ON runs(task_id)
      WHERE state IN ('queued','preparing','running','stopping');
    PRAGMA user_version=4;`)
  previous.close()
  const migrated = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    assert.equal(migrated.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)

    const backup = new DatabaseSync(
      join(dataDirectory, 'kernel.schema-4.backup.sqlite'),
      { readOnly: true },
    )

    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 4)
    assert.equal(
      backup
        .prepare("SELECT name FROM sqlite_master WHERE name='human_requests'")
        .get(),
      undefined,
    )
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    backup.close()

    const current = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'), {
      readOnly: true,
    })

    assert.match(
      String(
        current
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name='one_active_run_per_task'",
          )
          .get()?.sql,
      ),
      /waiting_approval/,
    )
    assert.equal(
      current.prepare('SELECT COUNT(*) AS n FROM human_requests').get()?.n,
      0,
    )
    current.close()
  } finally {
    await migrated.shutdown()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('schema 3 的产品对象在迁移前取得一致备份', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-v4-migration-'))
  const first = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  await first.shutdown()
  const database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  database.exec(
    'DROP TABLE skill_sources; DROP TABLE skill_imports; DROP TABLE skill_packages; DROP TABLE feishu_messages; DROP TABLE feishu_binding; DROP TABLE human_requests; PRAGMA user_version=3',
  )
  database.close()
  const migrated = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    assert.equal(migrated.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)

    const backup = new DatabaseSync(
      join(dataDirectory, 'kernel.schema-3.backup.sqlite'),
      { readOnly: true },
    )

    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 3)
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    assert.equal(
      backup.prepare('SELECT COUNT(*) AS n FROM team_versions').get()?.n,
      0,
    )
    backup.close()
  } finally {
    await migrated.shutdown()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('M0 在一致备份后迁移到当前 schema，备份保留原生命周期事件', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'weftpilot-migration-'))
  const database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
  database.exec(`${journalEventsSchema} PRAGMA user_version=1;`)
  database
    .prepare('INSERT INTO events VALUES(?,?,?,?)')
    .run(1, randomUUID(), new Date().toISOString(), 'kernel.started')
  database.close()
  const kernel = createKernel({ dataDirectory, sourceCommit: 'a'.repeat(40) })
  try {
    assert.equal(kernel.handshake.dataSchemaVersion, DATA_SCHEMA_VERSION)
    // 此表定义与已交付M0提交8a1491a一致；迁移后仍可通过恢复白名单。
    verifyCurrentBackupSchema(dataDirectory)

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
    'DROP TABLE skill_sources; DROP TABLE skill_imports; DROP TABLE skill_packages; DROP TABLE feishu_messages; DROP TABLE feishu_binding; DROP TABLE human_requests; DROP TABLE model_profiles; DROP TABLE requirement_versions; DROP TABLE team_versions; DROP TABLE role_readiness; PRAGMA user_version=2;',
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
  assert.equal(
    reopened.prepare('PRAGMA user_version').get()?.user_version,
    DATA_SCHEMA_VERSION,
  )
  verifyBackupSchema(reopened)
  reopened.close()
  rmSync(dataDirectory, { recursive: true, force: true })
})

const verifyCurrentBackupSchema = (dataDirectory: string): void => {
  const database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'), {
    readOnly: true,
  })

  try {
    verifyBackupSchema(database)
  } finally {
    database.close()
  }
}
