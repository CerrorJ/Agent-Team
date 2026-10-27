import type { WorkspaceStore } from './workspace-store.js'
import { runSchema } from './business-contracts.js'
import type { FeishuBinding } from './feishu-contracts.js'

export interface RoleNotification {
  runId: string
  sequence: number
  messageId: string | null
}

/** 投递表只记录渠道副作用；Run/任务/审批仍由原业务表唯一裁决。 */
export class RoleFeishuStore {
  constructor(private readonly store: WorkspaceStore) {}

  pending(binding: FeishuBinding, deliverableOnly = false): RoleNotification[] {
    return this.store.database
      .prepare(
        `
      SELECT r.id AS runId, MAX(e.sequence) AS sequence, m.message_id AS messageId
      FROM runs r JOIN workspace_events e ON e.aggregate_id=r.id OR
        e.aggregate_id=r.task_id OR e.aggregate_id IN
          (SELECT id FROM human_requests WHERE run_id=r.id)
      LEFT JOIN role_feishu_messages m ON m.run_id=r.id AND m.binding_id=?
      WHERE json_extract(r.data,'$.roleSnapshot.feishuBinding.id')=?
        AND json_extract(r.data,'$.purpose') IS NOT 'role_trial'
        AND e.type!='run.activity'
        AND (?=0 OR m.message_id IS NOT NULL OR m.create_started_at IS NULL OR m.create_started_at>=?)
      GROUP BY r.id HAVING MAX(e.sequence)>COALESCE(m.sequence,0)
      ORDER BY sequence`,
      )
      .all(
        binding.id,
        binding.id,
        Number(deliverableOnly),
        new Date(Date.now() - 55 * 60 * 1000).toISOString(),
      )
      .map((row) => ({
        runId: String(row.runId),
        sequence: Number(row.sequence),
        messageId: typeof row.messageId === 'string' ? row.messageId : null,
      }))
  }

  bindings(): FeishuBinding[] {
    const bindings = new Map<string, FeishuBinding>()
    for (const run of this.store.list('runs', runSchema)) {
      const binding = run.roleSnapshot.feishuBinding
      if (binding?.enabled && run.purpose !== 'role_trial')
        bindings.set(binding.id, binding)
    }
    return [...bindings.values()]
  }

  delivered(
    input: RoleNotification & { bindingId: string; messageId: string },
  ): void {
    this.store.database
      .prepare(
        `
      INSERT INTO role_feishu_messages(binding_id,run_id,sequence,message_id)
      VALUES(?,?,?,?) ON CONFLICT(binding_id,run_id) DO UPDATE SET
      sequence=excluded.sequence,message_id=excluded.message_id`,
      )
      .run(input.bindingId, input.runId, input.sequence, input.messageId)
  }

  /** 在网络前固定正文；超过平台去重窗口必须由人工对账，禁止自动新发。 */
  createContent(input: {
    bindingId: string
    runId: string
    content: string
  }): string {
    const row = this.store.database
      .prepare(
        `
      SELECT create_started_at,create_content FROM role_feishu_messages
      WHERE binding_id=? AND run_id=?`,
      )
      .get(input.bindingId, input.runId)

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
        `
      INSERT INTO role_feishu_messages(binding_id,run_id,sequence,create_started_at,create_content)
      VALUES(?,?,0,?,?)`,
      )
      .run(
        input.bindingId,
        input.runId,
        new Date().toISOString(),
        input.content,
      )
    return input.content
  }
}
