/** 生命周期表与备份schema参考共用定义，避免恢复白名单与实际建库漂移。 */
export const journalEventsSchema = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL,
    type TEXT NOT NULL
  );
`
