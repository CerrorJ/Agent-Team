import type { DatabaseSync } from 'node:sqlite'

export const initializeSkillSchema = (database: DatabaseSync): void => {
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE skill_sources (id TEXT NOT NULL, version INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TABLE skill_imports (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE skill_packages (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
    PRAGMA user_version=7;
    COMMIT;`)
}
