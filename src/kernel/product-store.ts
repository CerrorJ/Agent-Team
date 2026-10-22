import type { z } from 'zod'
import type { WorkspaceStore } from './workspace-store.js'
import {
  modelProfileSchema,
  requirementVersionSchema,
  teamVersionSchema,
} from './product-contracts.js'

export type ProductTable =
  'model_profiles' | 'requirement_versions' | 'team_versions'

/** 复用唯一内核连接与外层命令事务；不创建第二份持久化或嵌套事务。 */
export class ProductStore {
  constructor(private readonly store: WorkspaceStore) {}

  get<T>(
    table: ProductTable,
    ref: { id: string; version?: number },
    schema: z.ZodType<T>,
  ): T {
    const statement =
      ref.version === undefined
        ? this.store.database.prepare(
            `SELECT data FROM ${table} WHERE id=? ORDER BY version DESC LIMIT 1`,
          )
        : this.store.database.prepare(
            `SELECT data FROM ${table} WHERE id=? AND version=?`,
          )

    const row =
      ref.version === undefined
        ? statement.get(ref.id)
        : statement.get(ref.id, ref.version)

    if (!row) throw new Error('NOT_FOUND')
    return schema.parse(JSON.parse(String(row.data)))
  }

  list<T>(table: ProductTable, schema: z.ZodType<T>): T[] {
    return this.store.database
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => schema.parse(JSON.parse(String(row.data))))
  }

  append(
    table: ProductTable,
    value: { id: string; version: number; projectId?: string },
    type: string,
  ): void {
    const latest = Number(
      this.store.database
        .prepare(
          `SELECT COALESCE(MAX(version),0) AS version FROM ${table} WHERE id=?`,
        )
        .get(value.id)?.version,
    )

    if (latest !== value.version - 1) throw new Error('VERSION_CONFLICT')
    if (table === 'requirement_versions')
      this.store.database
        .prepare(
          'INSERT INTO requirement_versions(id,version,project_id,data) VALUES(?,?,?,?)',
        )
        .run(
          value.id,
          value.version,
          value.projectId ?? '',
          JSON.stringify(value),
        )
    else
      this.store.database
        .prepare(`INSERT INTO ${table}(id,version,data) VALUES(?,?,?)`)
        .run(value.id, value.version, JSON.stringify(value))
    this.store.event(type, value)
  }

  snapshot() {
    return {
      models: this.list('model_profiles', modelProfileSchema),
      requirements: this.list('requirement_versions', requirementVersionSchema),
      teams: this.list('team_versions', teamVersionSchema),
    }
  }
}
