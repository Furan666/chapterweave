// A lifetime cap until the event issuer confirms this key's quota.
export const MAX_QLOO_CALLS = 120;
export const GENERAL_QLOO_CALLS = 60;

export function initializeBudget(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS qloo_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used INTEGER NOT NULL CHECK (used >= 0),
    general_used INTEGER NOT NULL DEFAULT 0 CHECK (general_used >= 0)
  )`);
  // Existing deployments already have a used count. Charge those calls to the
  // general lane so a release cannot silently replenish its lifetime budget.
  const columns = storage.sql.exec('PRAGMA table_info(qloo_budget)').toArray();
  if (!columns.some((column) => column.name === 'general_used')) {
    storage.sql.exec('ALTER TABLE qloo_budget ADD COLUMN general_used INTEGER NOT NULL DEFAULT 0');
    storage.sql.exec('UPDATE qloo_budget SET general_used = used');
  }
}

export function budgetStatus(storage) {
  const row = storage.sql.exec('SELECT used, general_used FROM qloo_budget WHERE id = 1').toArray()[0];
  const used = row?.used ?? 0;
  const generalUsed = row?.general_used ?? 0;
  return {
    used,
    remaining: Math.max(0, MAX_QLOO_CALLS - used),
    generalRemaining: Math.max(0, Math.min(GENERAL_QLOO_CALLS - generalUsed, MAX_QLOO_CALLS - used)),
  };
}

export function consumeBudget(storage, maxCalls = MAX_QLOO_CALLS, sample = false) {
  // Each lane uses one SQLite statement, so concurrent reservations are atomic.
  if (sample) {
    const rows = storage.sql.exec(
      `INSERT INTO qloo_budget (id, used, general_used) SELECT 1, 1, 0 WHERE ? > 0
       ON CONFLICT(id) DO UPDATE SET used = used + 1
       WHERE used < ?
       RETURNING used`,
      maxCalls, maxCalls,
    ).toArray();
    return rows.length === 1;
  }
  const rows = storage.sql.exec(
    `INSERT INTO qloo_budget (id, used, general_used) SELECT 1, 1, 1 WHERE ? > 0 AND ? > 0
     ON CONFLICT(id) DO UPDATE SET used = used + 1, general_used = general_used + 1
     WHERE used < ? AND general_used < ?
     RETURNING used`,
    maxCalls, GENERAL_QLOO_CALLS, maxCalls, GENERAL_QLOO_CALLS,
  ).toArray();
  return rows.length === 1;
}
