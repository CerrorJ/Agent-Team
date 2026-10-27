import type { DatabaseSync } from 'node:sqlite'

/** 新投影按不可变绑定身份和Run隔离；不改旧单连接游标或历史JSON。 */
export const initializeRoleFeishuSchema = (database: DatabaseSync): void => {
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE role_feishu_messages (
      binding_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL, message_id TEXT,
      create_started_at TEXT, create_content TEXT,
      PRIMARY KEY(binding_id,run_id)
    );
    PRAGMA user_version=12;
    COMMIT;`)
}
