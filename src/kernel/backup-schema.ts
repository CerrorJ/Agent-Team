import { DatabaseSync } from 'node:sqlite'
import { journalEventsSchema } from './journal-schema.js'
import { initializeWorkspaceSchema } from './workspace-schema.js'

const expectedSchemas = new Map<boolean, string>()

/** SQLite备份是可执行schema的载体。数据摘要合法仍不能授权触发器、视图或改写的约束。 */
export const verifyBackupSchema = (database: DatabaseSync): void => {
  const roleRoutes =
    Number(database.prepare('PRAGMA user_version').get()?.user_version) >= 12

  if (!expectedSchemas.has(roleRoutes)) {
    const reference = new DatabaseSync(':memory:', { allowExtension: false })
    try {
      reference.exec(journalEventsSchema)
      initializeWorkspaceSchema(reference)
      // 7—11的物理schema相同；只在新建内存参考中去掉v12投影，绝不迁移源备份。
      if (!roleRoutes) reference.exec('DROP TABLE role_feishu_messages')
      expectedSchemas.set(roleRoutes, schemaFingerprint(reference))
    } finally {
      reference.close()
    }
  }
  if (schemaFingerprint(database) !== expectedSchemas.get(roleRoutes))
    throw new Error('BACKUP_INVALID')
}

const schemaFingerprint = (database: DatabaseSync): string =>
  JSON.stringify(
    database
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name',
      )
      .all()
      .map((row) => ({
        type: row.type,
        name: row.name,
        table: row.tbl_name,
        // 仅规范化引号外空白，不改变字符串常量或带引号标识符的内容。
        sql:
          typeof row.sql === 'string'
            ? row.sql
                .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/g, (part) =>
                  /^\s+$/.test(part) ? ' ' : part,
                )
                .trim()
            : null,
      })),
  )
