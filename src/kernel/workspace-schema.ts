import type { DatabaseSync } from 'node:sqlite'
import { initializeProductSchema } from './product-schema.js'
import { initializeHumanSchema } from './human-schema.js'
import { initializeFeishuSchema } from './feishu-schema.js'
import { initializeSkillSchema } from './skill-schema.js'

/** M1 新增表与旧生命周期事件分离，迁移只新增，不改写 M0 历史。 */
const workspaceSchemaV2 = `
    PRAGMA foreign_keys=ON;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, repository_path TEXT NOT NULL UNIQUE, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_versions (
      id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(id, version)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      role_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES projects(id), attempt INTEGER NOT NULL,
      role_id TEXT NOT NULL, role_version INTEGER NOT NULL,
      state TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      UNIQUE(task_id, attempt), FOREIGN KEY(role_id, role_version) REFERENCES role_versions(id, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task ON runs(task_id)
      WHERE state IN ('queued', 'preparing', 'running', 'stopping');
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acceptances (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
      task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL,
      type TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_by_run ON workspace_events(aggregate_id,type,sequence);
    CREATE TABLE IF NOT EXISTS command_receipts (
      idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, response TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_segments (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      pid INTEGER, started_at TEXT, ended_at TEXT, session_id TEXT,
      status TEXT NOT NULL DEFAULT 'launching'
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      event_id TEXT PRIMARY KEY REFERENCES workspace_events(id), delivered INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version=2;
    COMMIT;
`

export const initializeWorkspaceSchema = (database: DatabaseSync): void => {
  database.exec('PRAGMA foreign_keys=ON')

  const version = Number(
    database.prepare('PRAGMA user_version').get()?.user_version,
  )

  if (version < 2) database.exec(workspaceSchemaV2)
  if (version < 3) initializeProductSchema(database)
  // v4 固定团队依赖输入与贡献补丁的 JSON 契约，旧内核必须拒绝打开。
  if (version < 4) database.exec('PRAGMA user_version=4')
  if (version < 5) initializeHumanSchema(database)
  if (version < 6) initializeFeishuSchema(database)
  if (version < 7) initializeSkillSchema(database)
  initializeSnapshotContracts(database, version)
}

/** JSON 契约门禁只升版本，不重写已有业务对象；已发布迁移保持原语句。 */
const initializeSnapshotContracts = (
  database: DatabaseSync,
  version: number,
): void => {
  // v8扩展角色JSON快照；旧内核严格解析不认识的新字段，因此必须拒绝回退读取。
  if (version < 8)
    database.exec('BEGIN IMMEDIATE; PRAGMA user_version=8; COMMIT;')
  // v9允许新需求版本包含元数据；仅提升读取门禁，不补写历史需求、Run或事件。
  if (version < 9)
    database.exec('BEGIN IMMEDIATE; PRAGMA user_version=9; COMMIT;')
  // v10 扩展项目及 Run JSON；仅提升读取门禁，历史行不补写配置或上下文。
  if (version < 10)
    database.exec('BEGIN IMMEDIATE; PRAGMA user_version=10; COMMIT;')
}
