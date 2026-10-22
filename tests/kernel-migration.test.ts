import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createKernel } from '../src/kernel/kernel.js'

test('M0 到 M1 在一致备份后迁移，旧内核不能无声打开新 schema', async () => {
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
    assert.equal(kernel.handshake.dataSchemaVersion, 2)

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
