// A lifetime cap until the event issuer confirms this key's quota.
export const MAX_QLOO_CALLS = 120;

export function initializeBudget(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS qloo_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used INTEGER NOT NULL CHECK (used >= 0)
  )`);
}

export function consumeBudget(storage, maxCalls = MAX_QLOO_CALLS) {
  // One SQLite statement makes every reservation atomic, including concurrent calls.
  const rows = storage.sql.exec(
    `INSERT INTO qloo_budget (id, used) SELECT 1, 1 WHERE ? > 0
     ON CONFLICT(id) DO UPDATE SET used = used + 1
     WHERE used < ?
     RETURNING used`,
    maxCalls, maxCalls,
  ).toArray();
  return rows.length === 1;
}
