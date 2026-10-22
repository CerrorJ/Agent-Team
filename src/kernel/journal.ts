import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { eventSchema, type KernelEvent } from './protocol.js'

/** 独立锁库持有写事务，进程死亡由 OS 释放，不根据心跳猜测锁失效。 */
export class KernelJournal {
  private readonly lock: DatabaseSync
  readonly database: DatabaseSync

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true })
    this.lock = new DatabaseSync(join(dataDirectory, 'instance.sqlite'))
    try {
      this.lock.exec('BEGIN EXCLUSIVE')
      this.database = new DatabaseSync(join(dataDirectory, 'kernel.sqlite'))
      this.initialize(dataDirectory)
    } catch (error) {
      this.lock.close()
      throw error
    }
  }

  private initialize(dataDirectory: string): void {
    const version = this.database
      .prepare('PRAGMA user_version')
      .get()?.user_version

    if (![0, 1, 2, 3, 4].includes(Number(version))) {
      this.database.close()
      throw new Error('数据版本不兼容，请使用匹配的内核或备份')
    }
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL
      );
    `)
    if (version === 0) this.database.exec('PRAGMA user_version=1')

    const backup = join(
      dataDirectory,
      `kernel.schema-${String(version)}.backup.sqlite`,
    )

    if ([1, 2, 3].includes(Number(version)) && !existsSync(backup))
      this.database.prepare('VACUUM INTO ?').run(backup)
  }

  append(type: KernelEvent['type']): KernelEvent {
    const eventId = randomUUID()
    const occurredAt = new Date().toISOString()

    const result = this.database
      .prepare(
        'INSERT INTO events(event_id, occurred_at, type) VALUES (?, ?, ?)',
      )
      .run(eventId, occurredAt, type)

    return eventSchema.parse({
      protocolVersion: 1,
      eventId,
      sequence: Number(result.lastInsertRowid),
      occurredAt,
      type,
    })
  }

  read(after: number): KernelEvent[] {
    const rows = this.database
      .prepare(
        `
      SELECT sequence, event_id AS eventId, occurred_at AS occurredAt, type
      FROM events WHERE sequence > ? ORDER BY sequence LIMIT 100
    `,
      )
      .all(after)

    return rows.map((row) => eventSchema.parse({ protocolVersion: 1, ...row }))
  }

  close(): void {
    this.database.close()
    this.lock.close()
  }
}
