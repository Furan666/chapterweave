import { consumeBudget } from './budget-core.mjs';

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const AUTH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const QLOO_ORIGIN = 'https://hackathon.api.qloo.com';
const BOOK_TYPE = 'urn:entity:book';

export function initializeCache(storage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS qloo_cache (
    url TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS qloo_retry (
    url TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    retry_after INTEGER NOT NULL
  )`);
}

function officialUrl(address) {
  const url = new URL(address);
  if (url.origin !== QLOO_ORIGIN || !['/search', '/v2/insights'].includes(url.pathname) ||
      url.username || url.password || url.hash) {
    throw new Error('Unexpected Qloo endpoint');
  }
  return url;
}

function entityType(entity) {
  return entity?.subtype ?? entity?.type ??
    (Array.isArray(entity?.types) ? entity.types.find((type) =>
      typeof type === 'string' && type.startsWith('urn:entity:')) : null);
}

// Keep only fields ChapterWeave uses. Reject malformed responses before storing them.
function compactSuccessfulBody(url, raw) {
  let body;
  try { body = JSON.parse(raw); } catch { return null; }
  if (url.pathname === '/search') {
    const found = Array.isArray(body?.results) ? body.results : body?.results?.entities;
    if (body?.success === false || !Array.isArray(found) || found.length > 20) return null;
    const entities = [];
    for (const entity of found) {
      const entity_id = entity?.entity_id ?? entity?.id;
      const subtype = entityType(entity);
      if (typeof entity_id !== 'string' || !entity_id ||
          typeof entity?.name !== 'string' || !entity.name.trim() ||
          typeof subtype !== 'string' || !subtype.startsWith('urn:entity:')) return null;
      const copy = { entity_id, name: entity.name, subtype };
      if (typeof entity.disambiguation === 'string') copy.disambiguation = entity.disambiguation;
      if (Number.isInteger(entity?.properties?.release_year)) {
        copy.properties = { release_year: entity.properties.release_year };
      }
      entities.push(copy);
    }
    return JSON.stringify({ success: true, results: entities });
  }
  const found = body?.results?.entities;
  const take = Number(url.searchParams.get('take'));
  if (body?.success !== true || !Array.isArray(found) ||
      !Number.isInteger(take) || take < 1 || take > 50 || found.length > take) return null;
  const requested = url.searchParams.get('filter.results.entities');
  const allowed = requested ? new Set(requested.split(',')) : null;
  const excluded = new Set((url.searchParams.get('filter.exclude.entities') || '').split(','));
  const seen = new Set();
  const entities = [];
  for (const entity of found) {
    const id = entity?.entity_id;
    if (typeof id !== 'string' || !id || entity.subtype !== BOOK_TYPE ||
        seen.has(id) || (allowed && !allowed.has(id)) || excluded.has(id) ||
        (!allowed && (typeof entity.name !== 'string' || !entity.name.trim()))) return null;
    seen.add(id);
    entities.push({ entity_id: id, subtype: BOOK_TYPE,
      ...(typeof entity.name === 'string' ? { name: entity.name } : {}) });
  }
  return JSON.stringify({ success: true, results: { entities } });
}

function success(body, fetchedAt) {
  return new Response(body, { status: 200, headers: {
    'content-type': 'application/json',
    'x-qloo-source-checked-at': new Date(fetchedAt).toISOString(),
  } });
}

export function cacheStatus(storage, now = Date.now) {
  const timestamp = now();
  const row = storage.sql.exec(
    'SELECT COUNT(*) AS fresh FROM qloo_cache WHERE fetched_at <= ? AND ? - fetched_at < ?',
    timestamp, timestamp, CACHE_TTL_MS,
  ).toArray()[0];
  return { freshEntries: row?.fresh ?? 0 };
}

export function createCachedQlooFetch(storage, apiKey, fetcher = fetch, now = Date.now) {
  const pending = new Map();
  return async (address, { sample = false } = {}) => {
    const url = officialUrl(address);
    const key = url.toString();
    const timestamp = now();
    const cached = storage.sql.exec('SELECT body, fetched_at FROM qloo_cache WHERE url = ?', key).toArray()[0];
    if (cached && cached.fetched_at <= timestamp && timestamp - cached.fetched_at < CACHE_TTL_MS) {
      return success(cached.body, cached.fetched_at);
    }
    const retry = storage.sql.exec('SELECT status, retry_after FROM qloo_retry WHERE url = ?', key).toArray()[0];
    if (retry && retry.retry_after > timestamp) return new Response(null, { status: retry.status });
    const pendingKey = `${sample ? 'sample' : 'general'}:${key}`;
    let task = pending.get(pendingKey);
    if (!task) {
      task = (async () => {
        if (!consumeBudget(storage, undefined, sample)) return { status: 429, budgetExhausted: true };
        const failed = (status) => {
          const cooldown = status === 401 || status === 403 ?
            AUTH_FAILURE_COOLDOWN_MS : FAILURE_COOLDOWN_MS;
          storage.sql.exec(`INSERT INTO qloo_retry (url, status, retry_after) VALUES (?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET status = excluded.status, retry_after = excluded.retry_after`,
          key, status, now() + cooldown);
          return { status };
        };
        let response;
        try {
          response = await fetcher(key, { headers: { accept: 'application/json', 'X-Api-Key': apiKey } });
        } catch {
          return failed(503);
        }
        if (!response.ok) return failed(response.status);
        let raw;
        try { raw = await response.text(); } catch { return failed(503); }
        const body = compactSuccessfulBody(url, raw);
        if (!body) return failed(502);
        const fetchedAt = now();
        storage.sql.exec(`INSERT INTO qloo_cache (url, body, fetched_at) VALUES (?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
        key, body, fetchedAt);
        storage.sql.exec('DELETE FROM qloo_retry WHERE url = ?', key);
        return { status: 200, body, fetchedAt };
      })();
      pending.set(pendingKey, task);
      void task.finally(() => pending.delete(pendingKey)).catch(() => {});
    }
    const result = await task;
    if (result.status === 200) return success(result.body, result.fetchedAt);
    return new Response(null, { status: result.status, headers:
      result.budgetExhausted ? { 'x-chapterweave-budget-exhausted': '1' } : {} });
  };
}
