import type { DatabaseSync } from 'node:sqlite'

/** v5 新增等待态与人工请求；旧迁移不改写，升级前由 Journal 保存 schema 4 一致备份。 */
export const initializeHumanSchema = (database: DatabaseSync): void => {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE human_requests (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_pending_human_per_run ON human_requests(run_id) WHERE status='pending';
    DROP INDEX one_active_run_per_task;
    CREATE UNIQUE INDEX one_active_run_per_task ON runs(task_id)
      WHERE state IN ('queued','preparing','running','stopping','waiting_input','waiting_approval');
    PRAGMA user_version=5;
    COMMIT;
  `)
}
