import {
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from './workspace-contracts.js'
import { RoleReadinessStore } from './role-readiness-store.js'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import {
  acceptanceSchema,
  deliverySchema,
  projectSchema,
  roleVersionSchema,
  runSchema,
  taskSchema,
  type Acceptance,
  type Delivery,
  type Project,
  type RoleVersion,
  type Run,
  type Task,
} from './business-contracts.js'
import { initializeWorkspaceSchema } from './workspace-schema.js'
import { ProductStore } from './product-store.js'
import { projectQueue } from './queue-rules.js'
import { HumanStore } from './human-store.js'
import { FeishuStore } from './feishu-store.js'

export type ObjectTable =
  'projects' | 'role_versions' | 'tasks' | 'runs' | 'deliveries' | 'acceptances'

/** 单连接事务中提交状态、事件、outbox 和命令回执；事务内不做 Git/CLI/网络操作。 */
export class WorkspaceStore {
  constructor(readonly database: DatabaseSync) {
    initializeWorkspaceSchema(database)
  }

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  get<T>(table: ObjectTable, id: string, schema: z.ZodType<T>): T {
    const row = this.database
      .prepare(
        `SELECT data FROM ${table} WHERE id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(id)

    if (typeof row?.data !== 'string') throw new Error('NOT_FOUND: 对象不存在')
    return schema.parse(JSON.parse(row.data))
  }

  list<T>(table: ObjectTable, schema: z.ZodType<T>): T[] {
    return this.database
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => schema.parse(JSON.parse(String(row.data))))
  }

  addProject(project: Project): void {
    this.database
      .prepare('INSERT INTO projects(id,repository_path,data) VALUES(?,?,?)')
      .run(project.id, project.repositoryPath, JSON.stringify(project))
    this.event('project.created', project)
  }

  addRole(role: RoleVersion): void {
    const latest = this.database
      .prepare('SELECT MAX(version) AS version FROM role_versions WHERE id=?')
      .get(role.id)

    if (Number(latest?.version ?? 0) !== role.version - 1)
      throw new Error('VERSION_CONFLICT: 角色已被修改')
    this.database
      .prepare('INSERT INTO role_versions(id,version,data) VALUES(?,?,?)')
      .run(role.id, role.version, JSON.stringify(role))
    this.event('role.version_created', role)
  }

  addTask(task: Task): void {
    this.database
      .prepare(
        'INSERT INTO tasks(id,project_id,role_id,version,data) VALUES(?,?,?,?,?)',
      )
      .run(
        task.id,
        task.projectId,
        task.roleId,
        task.version,
        JSON.stringify(task),
      )
    this.event('task.created', task)
  }

  updateTask(task: Task): void {
    const result = this.database
      .prepare('UPDATE tasks SET version=?,data=? WHERE id=? AND version=?')
      .run(task.version, JSON.stringify(task), task.id, task.version - 1)

    if (result.changes !== 1) throw new Error('VERSION_CONFLICT: 任务已被修改')
    this.event('task.changed', task)
  }

  addRun(run: Run): void {
    runSchema.parse(run)
    this.database
      .prepare(
        `INSERT INTO runs(id,task_id,project_id,attempt,role_id,role_version,state,version,data)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.projectId,
        run.attempt,
        run.roleSnapshot.id,
        run.roleSnapshot.version,
        run.status,
        run.version,
        JSON.stringify(run),
      )
    this.event('run.created', run)
  }

  updateRun(run: Run): void {
    runSchema.parse(run)

    const result = this.database
      .prepare(
        'UPDATE runs SET state=?,version=?,data=? WHERE id=? AND version=?',
      )
      .run(
        run.status,
        run.version,
        JSON.stringify(run),
        run.id,
        run.version - 1,
      )

    if (result.changes !== 1) throw new Error('VERSION_CONFLICT: 执行已被修改')
    this.event('run.changed', run)
  }

  addDelivery(delivery: Delivery): void {
    this.database
      .prepare('INSERT INTO deliveries(id,run_id,task_id,data) VALUES(?,?,?,?)')
      .run(
        delivery.id,
        delivery.runId,
        delivery.taskId,
        JSON.stringify(delivery),
      )
    this.event('delivery.created', delivery)
  }

  addAcceptance(acceptance: Acceptance): void {
    this.database
      .prepare(
        'INSERT INTO acceptances(id,delivery_id,task_id,data) VALUES(?,?,?,?)',
      )
      .run(
        acceptance.id,
        acceptance.deliveryId,
        acceptance.taskId,
        JSON.stringify(acceptance),
      )
    this.event('delivery.reviewed', { ...acceptance, version: 1 })
  }

  event<T extends { id: string; version: number }>(
    type: string,
    object: T,
  ): void {
    const eventId = randomUUID()
    this.database
      .prepare(
        `INSERT INTO workspace_events(id,aggregate_id,aggregate_version,type,occurred_at,data)
      VALUES(?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        object.id,
        object.version,
        type,
        new Date().toISOString(),
        JSON.stringify(object),
      )
    if (type !== 'run.activity')
      this.database
        .prepare('INSERT INTO notification_outbox(event_id) VALUES(?)')
        .run(eventId)
  }

  snapshot(): WorkspaceSnapshot {
    return this.transaction(() =>
      workspaceSnapshotSchema.parse({
        cursor: Number(
          this.database
            .prepare(
              'SELECT COALESCE(MAX(sequence),0) AS cursor FROM workspace_events',
            )
            .get()?.cursor,
        ),
        projects: this.list('projects', projectSchema),
        roles: this.list('role_versions', roleVersionSchema),
        roleReadiness: new RoleReadinessStore(this).snapshot(
          this.list('role_versions', roleVersionSchema),
        ),
        tasks: this.list('tasks', taskSchema),
        runs: projectQueue(this),
        deliveries: this.list('deliveries', deliverySchema),
        acceptances: this.list('acceptances', acceptanceSchema),
        ...new ProductStore(this).snapshot(),
        logs: this.activity(),
        humanRequests: new HumanStore(this).list(),
        feishuBinding: new FeishuStore(this).binding(),
      }),
    )
  }

  activity(runId?: string): {
    runId: string
    label: string
    occurredAt: string
    sequence: number
  }[] {
    const where = runId
      ? "aggregate_id=? AND type='run.activity'"
      : "type='run.activity'"

    return this.database
      .prepare(
        `SELECT aggregate_id AS runId, data, occurred_at AS occurredAt, sequence
      FROM workspace_events WHERE ${where} ORDER BY sequence DESC LIMIT 100`,
      )
      .all(...(runId ? [runId] : []))
      .reverse()
      .map((row) => {
        const data = JSON.parse(String(row.data)) as { label: string }
        return {
          runId: String(row.runId),
          label: data.label,
          occurredAt: String(row.occurredAt),
          sequence: Number(row.sequence),
        }
      })
  }
}
