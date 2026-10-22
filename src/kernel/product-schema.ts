import type { DatabaseSync } from 'node:sqlite'

/** 产品版本表追加保存；M1 的 Run JSON 不原地改写，新字段通过契约默认值兼容读取。 */
export const initializeProductSchema = (database: DatabaseSync): void => {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE model_profiles (
      id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(id,version)
    );
    CREATE TABLE requirement_versions (
      id TEXT NOT NULL, version INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL,
      PRIMARY KEY(id,version)
    );
    CREATE TABLE team_versions (
      id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(id,version)
    );
    PRAGMA user_version=3;
    CREATE TABLE role_readiness (
      role_id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL
    );
    COMMIT;
  `)
}
