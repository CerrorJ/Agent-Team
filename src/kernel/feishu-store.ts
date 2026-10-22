import { randomUUID } from 'node:crypto'
import type { WorkspaceStore } from './workspace-store.js'
import {
  feishuBindingSchema,
  type FeishuBinding,
  type FeishuCommand,
} from './feishu-contracts.js'

/** 与命令回执共用事务；通知游标只表示渠道投递，不构成另一套任务状态。 */
export class FeishuStore {
  constructor(private readonly store: WorkspaceStore) {}

  binding(): FeishuBinding | null {
    const row = this.store.database
      .prepare('SELECT data FROM feishu_binding WHERE singleton=1')
      .get()

    return row ? feishuBindingSchema.parse(JSON.parse(String(row.data))) : null
  }

  save(command: FeishuCommand): { id: string } {
    const previous = this.binding()
    if ((previous?.version ?? 0) !== command.expectedVersion)
      throw new Error('VERSION_CONFLICT')
    const { type: _type, expectedVersion: _version, ...fields } = command

    const binding = feishuBindingSchema.parse({
      ...fields,
      id: previous?.id ?? randomUUID(),
      version: command.expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    })

    this.store.database
      .prepare(
        `INSERT INTO feishu_binding(singleton,data) VALUES(1,?)
      ON CONFLICT(singleton) DO UPDATE SET data=excluded.data`,
      )
      .run(JSON.stringify(binding))
    this.store.event('feishu.binding_changed', binding)
    return { id: binding.id }
  }

  pending(
    binding: FeishuBinding,
    deliverableOnly = false,
  ): { taskId: string; sequence: number; messageId: string | null }[] {
    return this.store.database
      .prepare(
        `SELECT t.id AS taskId, MAX(e.sequence) AS sequence,
      m.message_id AS messageId FROM tasks t
      JOIN workspace_events e ON e.aggregate_id=t.id OR
        e.aggregate_id IN (SELECT id FROM runs WHERE task_id=t.id) OR
        e.aggregate_id IN (SELECT h.id FROM human_requests h JOIN runs r ON r.id=h.run_id WHERE r.task_id=t.id)
      LEFT JOIN feishu_messages m ON m.task_id=t.id AND m.binding_version=?
      WHERE json_extract(t.data,'$.purpose') IS NOT 'role_trial' AND e.type!='run.activity'
        AND (?=0 OR m.message_id IS NOT NULL OR m.create_started_at IS NULL OR m.create_started_at>=?)
      GROUP BY t.id HAVING MAX(e.sequence)>COALESCE(m.sequence,0)
      ORDER BY sequence`,
      )
      .all(
        binding.version,
        Number(deliverableOnly),
        new Date(Date.now() - 55 * 60 * 1000).toISOString(),
      )
      .map((row) => ({
        taskId: String(row.taskId),
        sequence: Number(row.sequence),
        messageId: typeof row.messageId === 'string' ? row.messageId : null,
      }))
  }

  delivered(input: {
    bindingVersion: number
    taskId: string
    sequence: number
    messageId: string
  }): void {
    this.store.database
      .prepare(
        `INSERT INTO feishu_messages(binding_version,task_id,sequence,message_id)
      VALUES(?,?,?,?) ON CONFLICT(binding_version,task_id) DO UPDATE SET
      sequence=excluded.sequence,message_id=excluded.message_id`,
      )
      .run(input.bindingVersion, input.taskId, input.sequence, input.messageId)
  }

  /** 首次发送正文在网络前冻结；不确定重发沿用同一 uuid/正文，并受平台一小时去重窗口约束。 */
  createContent(input: {
    bindingVersion: number
    taskId: string
    content: string
  }): string {
    const row = this.store.database
      .prepare(
        `SELECT create_started_at,create_content FROM feishu_messages
      WHERE binding_version=? AND task_id=?`,
      )
      .get(input.bindingVersion, input.taskId)

    if (row) {
      if (
        Date.now() - Date.parse(String(row.create_started_at)) >
        55 * 60 * 1000
      )
        throw new Error('FEISHU_DELIVERY_UNCERTAIN')
      return String(row.create_content)
    }
    this.store.database
      .prepare(
        `INSERT INTO feishu_messages(binding_version,task_id,sequence,
      create_started_at,create_content) VALUES(?,?,0,?,?)`,
      )
      .run(
        input.bindingVersion,
        input.taskId,
        new Date().toISOString(),
        input.content,
      )
    return input.content
  }
}
