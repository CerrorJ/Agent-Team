import type { DatabaseSync } from 'node:sqlite'

export const initializeFeishuSchema = (database: DatabaseSync): void => {
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE feishu_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL);
    CREATE TABLE feishu_messages(binding_version INTEGER NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
      sequence INTEGER NOT NULL, message_id TEXT, create_started_at TEXT, create_content TEXT,
      PRIMARY KEY(binding_version,task_id));
    PRAGMA user_version=6;
    COMMIT;`)
}
