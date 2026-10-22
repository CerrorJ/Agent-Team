import { humanRequestSchema, type HumanRequest } from './human-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 使用与 Run 相同的连接和事务；本类不自行提交，保证决定/续接意图/回执同时提交。 */
export class HumanStore {
  constructor(private readonly store: WorkspaceStore) {}

  get(id: string): HumanRequest {
    const row = this.store.database
      .prepare('SELECT data FROM human_requests WHERE id=?')
      .get(id)

    if (typeof row?.data !== 'string') throw new Error('NOT_FOUND')
    return humanRequestSchema.parse(JSON.parse(row.data))
  }

  list(): HumanRequest[] {
    return this.store.database
      .prepare('SELECT data FROM human_requests ORDER BY rowid')
      .all()
      .map((row) => humanRequestSchema.parse(JSON.parse(String(row.data))))
  }

  add(request: HumanRequest): void {
    this.store.database
      .prepare(
        'INSERT INTO human_requests(id,run_id,version,status,data) VALUES(?,?,?,?,?)',
      )
      .run(
        request.id,
        request.runId,
        request.version,
        request.status,
        JSON.stringify(request),
      )
    this.store.event('human.requested', request)
  }

  update(request: HumanRequest): void {
    const changed = this.store.database
      .prepare(
        'UPDATE human_requests SET version=?,status=?,data=? WHERE id=? AND version=?',
      )
      .run(
        request.version,
        request.status,
        JSON.stringify(request),
        request.id,
        request.version - 1,
      )

    if (changed.changes !== 1) throw new Error('VERSION_CONFLICT')
    this.store.event('human.decided', request)
  }
}
