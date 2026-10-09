import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { budgetStatus, consumeBudget, GENERAL_QLOO_CALLS, initializeBudget, MAX_QLOO_CALLS } from './backend/budget-core.mjs';
import { cacheStatus, CACHE_TTL_MS, createCachedQlooFetch, initializeCache } from './backend/cache-core.mjs';
import { createBackend } from './backend/app.mjs';
import pages from './pages/proxy.mjs';

function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        const rows = /^(CREATE|ALTER|UPDATE)/.test(query.trimStart()) ?
          (statement.run(...bindings), []) : statement.all(...bindings);
        return { toArray: () => rows };
      },
    },
    close: () => db.close(),
  };
}

function defaultQlooResponse(address) {
  const url = new URL(address);
  if (url.pathname === '/search') return Response.json({ success: true, results: [
    { entity_id: 'book-1', name: 'Example', subtype: 'urn:entity:book' },
  ] });
  return Response.json({ success: true, results: { entities:
    url.searchParams.get('filter.results.entities').split(',').map((entity_id) =>
      ({ entity_id, subtype: 'urn:entity:book' })) } });
}

function bindings({ visitor = true, site = true, upstream = defaultQlooResponse, now = Date.now } = {}) {
  const calls = { cache: 0, outbound: 0, visitor: 0, site: 0, name: null, sample: 0 };
  const storage = sqliteStorage();
  initializeBudget(storage);
  initializeCache(storage);
  const cachedFetch = createCachedQlooFetch(storage, 'synthetic-test-key', async (address, options) => {
    calls.outbound += 1;
    return upstream(address, options);
  }, now);
  return {
    calls, storage,
    env: {
      QLOO_API_KEY: 'synthetic-test-key',
      PER_IP_LIMIT: { async limit({ key }) {
        calls.visitor += 1;
        assert.equal(key, '192.0.2.1');
        return { success: visitor };
      } },
      SITE_LIMIT: { async limit({ key }) {
        calls.site += 1;
        assert.equal(key, 'all');
        return { success: site };
      } },
      QLOO_BUDGET: {
        idFromName(name) { calls.name = name; return name; },
        get() { return { async fetch(request) {
          calls.cache += 1;
          if (new URL(request.url).pathname === '/status') {
            assert.equal(request.method, 'GET');
            return Response.json({ ...budgetStatus(storage), ...cacheStatus(storage, now), keyConfigured: true });
          }
          assert.equal(new URL(request.url).pathname, '/request');
          assert.equal(request.method, 'POST');
          const sample = request.headers.get('x-chapterweave-built-in-example') === '1';
          if (sample) calls.sample += 1;
          return cachedFetch(await request.text(), { sample });
        } }; },
      },
    },
  };
}

const client = { headers: { 'x-chapterweave-client-ip': '192.0.2.1' } };
const planInput = {
  groupAIds: ['film-a'], groupBIds: ['film-b'], shelfIds: ['book-1', 'book-2', 'book-3'],
};
const exampleInput = {
  groupAIds: ['C7EC4CA9-1CCC-4991-B738-55F075441B3F'],
  groupBIds: ['057DA9D9-399B-437E-8BCA-A80E499125EF'],
  shelfIds: [
    '2E76F365-7C08-4DDF-8C49-CC27582788E5',
    '6CDF2DC4-2238-4C22-B0E3-7FDE341BF8C8',
    'CF50199E-9457-4A5B-A4D4-378910DE9A77',
    '3681886D-A7AB-484B-ACE8-DEA2027B4964',
  ],
};

test('reserved example IDs match the public illustrative controls', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of [...exampleInput.groupAIds, ...exampleInput.groupBIds, ...exampleInput.shelfIds,
    'A499EC25-7FF6-46DE-9DA5-3E78E99B9E26']) assert.ok(source.includes(id), id);
});

test('SQLite budget reserves the last 60 calls for exact built-in examples', () => {
  const storage = sqliteStorage();
  initializeBudget(storage);
  initializeBudget(storage);
  for (let i = 0; i < GENERAL_QLOO_CALLS; i += 1) assert.equal(consumeBudget(storage), true);
  assert.equal(consumeBudget(storage), false);
  assert.equal(budgetStatus(storage).generalRemaining, 0);
  assert.equal(budgetStatus(storage).remaining, MAX_QLOO_CALLS - GENERAL_QLOO_CALLS);
  for (let i = GENERAL_QLOO_CALLS; i < MAX_QLOO_CALLS; i += 1) {
    assert.equal(consumeBudget(storage, MAX_QLOO_CALLS, true), true);
  }
  assert.equal(consumeBudget(storage, MAX_QLOO_CALLS, true), false);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, MAX_QLOO_CALLS);
  storage.close();
});

test('legacy SQLite usage migrates without replenishing the general lane', () => {
  const storage = sqliteStorage();
  storage.sql.exec('CREATE TABLE qloo_budget (id INTEGER PRIMARY KEY, used INTEGER NOT NULL)');
  storage.sql.exec('INSERT INTO qloo_budget (id, used) VALUES (1, 7)');
  initializeBudget(storage);
  assert.deepEqual({ ...storage.sql.exec('SELECT used, general_used FROM qloo_budget').toArray()[0] },
    { used: 7, general_used: 7 });
  initializeBudget(storage);
  assert.equal(consumeBudget(storage), true);
  assert.equal(budgetStatus(storage).generalRemaining, GENERAL_QLOO_CALLS - 8);
  storage.close();
});

test('changing the call cap preserves prior usage', () => {
  const storage = sqliteStorage();
  initializeBudget(storage);
  assert.equal(consumeBudget(storage, 2), true);
  assert.equal(consumeBudget(storage, 2), true);
  assert.equal(consumeBudget(storage, 2), false);
  initializeBudget(storage);
  assert.equal(consumeBudget(storage, 1), false);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 2);
  assert.equal(consumeBudget(storage, 4), true);
  assert.equal(consumeBudget(storage, 4), true);
  assert.equal(consumeBudget(storage, 4), false);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 4);
  storage.close();
});

test('repeated Qloo Search reuses one valid response and preserves its check time', async () => {
  const { env, calls, storage } = bindings({ upstream: (address, options) => {
    assert.equal(new URL(address).origin, 'https://hackathon.api.qloo.com');
    assert.equal(options.headers['X-Api-Key'], 'synthetic-test-key');
    return defaultQlooResponse(address);
  } });
  const app = createBackend();
  const request = () => new Request('https://backend.internal/api/search?q=Example&type=book', client);
  const first = await app.fetch(request(), env);
  const second = await app.fetch(request(), env);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.choices[0].id, 'book-1');
  assert.deepEqual(await second.json(), firstBody);
  assert.ok(firstBody.sourceCheckedAt);
  assert.equal(calls.outbound, 1);
  assert.equal(calls.cache, 2);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 1);
  assert.equal(JSON.stringify(firstBody).includes('synthetic-test-key'), false);
  assert.equal(calls.name, 'chapterweave-qloo-key-v1');
  storage.close();
});

test('two group Insights calls reserve separately, then repeat plans hit the cache', async () => {
  const { env, calls, storage } = bindings();
  const app = createBackend();
  const request = () => new Request('https://backend.internal/api/plan', {
    method: 'POST', ...client, body: JSON.stringify(planInput),
  });
  const first = await app.fetch(request(), env);
  const second = await app.fetch(request(), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'bridge_found');
  assert.equal((await second.json()).status, 'bridge_found');
  assert.equal(calls.outbound, 2);
  assert.equal(calls.cache, 4);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 2);
  storage.close();
});

test('budget denial blocks the next outbound call', async () => {
  const { env, calls, storage } = bindings();
  for (let i = 0; i < GENERAL_QLOO_CALLS - 1; i += 1) consumeBudget(storage);
  const app = createBackend();
  const response = await app.fetch(new Request('https://backend.internal/api/plan', {
    method: 'POST', ...client, body: JSON.stringify(planInput),
  }), env);
  assert.equal(response.status, 429);
  assert.equal(calls.outbound, 1);
  assert.equal(calls.cache, 2);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, GENERAL_QLOO_CALLS);
  storage.close();
});

test('only exact built-in plan inputs use the reserve, regardless of client headers', async () => {
  const { env, calls, storage } = bindings();
  for (let i = 0; i < GENERAL_QLOO_CALLS; i += 1) consumeBudget(storage);
  const app = createBackend();
  const request = (input) => new Request('https://backend.internal/api/plan', {
    method: 'POST',
    headers: { ...client.headers, 'x-chapterweave-built-in-example': '1' },
    body: JSON.stringify(input),
  });
  assert.equal((await app.fetch(request(planInput), env)).status, 429);
  assert.equal(calls.sample, 0);
  assert.equal((await app.fetch(request({ ...exampleInput, extra: true }), env)).status, 429);
  assert.equal(calls.sample, 0);
  const response = await app.fetch(request(exampleInput), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'bridge_found');
  const changedGroupB = { ...exampleInput,
    groupBIds: ['A499EC25-7FF6-46DE-9DA5-3E78E99B9E26'] };
  assert.equal((await app.fetch(request(changedGroupB), env)).status, 200);
  assert.equal(calls.sample, 4);
  assert.equal(calls.outbound, 3);
  assert.equal(budgetStatus(storage).generalRemaining, 0);
  assert.equal(budgetStatus(storage).remaining, MAX_QLOO_CALLS - GENERAL_QLOO_CALLS - 3);
  storage.close();
});

test('read-only status reports the local budget without an upstream call', async () => {
  const { env, calls, storage } = bindings();
  const app = createBackend();
  const response = await app.fetch(new Request('https://backend.internal/api/status'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true, localBudget: {
    used: 0, remaining: MAX_QLOO_CALLS,
    generalRemaining: GENERAL_QLOO_CALLS, freshEntries: 0,
  } });
  assert.equal(calls.outbound, 0);
  assert.equal(calls.visitor, 0);
  storage.close();
});

test('missing or failing safety bindings fail closed', async () => {
  const app = createBackend();
  const request = () => new Request('https://backend.internal/api/search?q=Example', client);
  const missing = bindings().env;
  delete missing.QLOO_BUDGET;
  assert.equal((await app.fetch(request(), missing)).status, 503);
  const limited = bindings({ visitor: false }).env;
  assert.equal((await app.fetch(request(), limited)).status, 429);
  const siteLimited = bindings({ site: false }).env;
  assert.equal((await app.fetch(request(), siteLimited)).status, 429);
  const broken = bindings().env;
  broken.QLOO_BUDGET.get = () => ({ fetch: async () => new Response(null, { status: 503 }) });
  assert.equal((await app.fetch(request(), broken)).status, 503);
  const throwing = bindings().env;
  throwing.QLOO_BUDGET.get = () => ({ fetch: async () => { throw new Error('budget offline'); } });
  assert.equal((await app.fetch(request(), throwing)).status, 503);
  const invalid = bindings().env;
  assert.equal((await app.fetch(new Request('https://backend.internal/api/search?q=x', client), invalid)).status, 400);
});

test('a Qloo transport failure is a server error after exactly one reservation', async () => {
  const { env, calls, storage } = bindings({ upstream: () => { throw new TypeError('network failed'); } });
  const app = createBackend();
  const response = await app.fetch(new Request('https://backend.internal/api/search?q=Example', client), env);
  assert.equal(response.status, 503);
  assert.equal(calls.outbound, 1);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 1);
  assert.equal((await response.json()).error.includes('network failed'), false);
  storage.close();
});

test('exact URL cache coalesces concurrent requests and expires after seven days', async () => {
  const storage = sqliteStorage();
  initializeBudget(storage);
  initializeCache(storage);
  let time = Date.parse('2026-10-09T10:00:00.000Z');
  let outbound = 0;
  const fetchCached = createCachedQlooFetch(storage, 'synthetic-test-key', async (address) => {
    outbound += 1;
    await Promise.resolve();
    return defaultQlooResponse(address);
  }, () => time);
  const address = 'https://hackathon.api.qloo.com/search?query=Example&take=20';
  const [first, second] = await Promise.all([fetchCached(address), fetchCached(address)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(outbound, 1);
  assert.equal(first.headers.get('x-qloo-source-checked-at'), '2026-10-09T10:00:00.000Z');
  time += CACHE_TTL_MS - 1;
  assert.equal((await fetchCached(address)).headers.get('x-qloo-source-checked-at'),
    '2026-10-09T10:00:00.000Z');
  assert.equal(outbound, 1);
  time += 1;
  assert.equal((await fetchCached(address)).status, 200);
  assert.equal(outbound, 2);
  assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 2);
  assert.equal(storage.sql.exec('SELECT COUNT(*) AS count FROM qloo_cache').toArray()[0].count, 1);
  storage.close();
});

test('fresh cached results remain available at the cap, but new URLs cannot spend more', async () => {
  const storage = sqliteStorage();
  initializeBudget(storage);
  initializeCache(storage);
  let outbound = 0;
  const fetchCached = createCachedQlooFetch(storage, 'synthetic-test-key', async (address) => {
    outbound += 1;
    return defaultQlooResponse(address);
  });
  const address = 'https://hackathon.api.qloo.com/search?query=Example&take=20';
  assert.equal((await fetchCached(address)).status, 200);
  for (let i = 1; i < MAX_QLOO_CALLS; i += 1) consumeBudget(storage);
  assert.equal((await fetchCached(address)).status, 200);
  const denied = await fetchCached('https://hackathon.api.qloo.com/search?query=Different&take=20');
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('x-chapterweave-budget-exhausted'), '1');
  assert.equal(outbound, 1);
  storage.close();
});

test('auth, rate, malformed, and transport failures get a bounded retry cooldown', async () => {
  const address = 'https://hackathon.api.qloo.com/search?query=Example&take=20';
  for (const [label, upstream, expected] of [
    ['auth', () => new Response(null, { status: 401 }), 401],
    ['rate', () => new Response(null, { status: 429 }), 429],
    ['malformed', () => Response.json({ success: true, results: {} }), 502],
    ['transport', () => { throw new Error('offline'); }, 503],
  ]) {
    const storage = sqliteStorage();
    initializeBudget(storage);
    initializeCache(storage);
    let outbound = 0;
    let current = 1_000_000;
    const fetchCached = createCachedQlooFetch(storage, 'synthetic-test-key', async (...args) => {
      outbound += 1;
      return upstream(...args);
    }, () => current);
    assert.equal((await fetchCached(address)).status, expected, label);
    assert.equal((await fetchCached(address)).status, expected, label);
    assert.equal(outbound, 1, label);
    assert.equal(storage.sql.exec('SELECT COUNT(*) AS count FROM qloo_cache').toArray()[0].count, 0, label);
    assert.equal(storage.sql.exec('SELECT used FROM qloo_budget').toArray()[0].used, 1, label);
    current += 60 * 60 * 1000 + 1;
    assert.equal((await fetchCached(address)).status, expected, label);
    assert.equal(outbound, 2, label);
    storage.close();
  }
});

test('cache stores only needed public fields and never stores or returns the key', async () => {
  const storage = sqliteStorage();
  initializeBudget(storage);
  initializeCache(storage);
  const fetchCached = createCachedQlooFetch(storage, 'synthetic-test-key', async (_address, options) => {
    assert.equal(options.headers['X-Api-Key'], 'synthetic-test-key');
    return Response.json({ success: true, results: [
      { entity_id: 'book-1', name: 'Example', subtype: 'urn:entity:book', privateExtra: 'discard me' },
    ] });
  });
  const response = await fetchCached('https://hackathon.api.qloo.com/search?query=Example&take=20');
  const cached = storage.sql.exec('SELECT url, body FROM qloo_cache').toArray()[0];
  assert.equal(response.status, 200);
  assert.equal(cached.body.includes('privateExtra'), false);
  assert.equal(JSON.stringify(cached).includes('synthetic-test-key'), false);
  assert.equal((await response.text()).includes('synthetic-test-key'), false);
  storage.close();
});

test('Pages forwards only allowlisted API paths and controlled headers', async () => {
  let forwarded;
  const env = {
    ASSETS: { fetch: async () => new Response('site') },
    BACKEND: { fetch: async (request) => { forwarded = request; return Response.json({ ok: true }); } },
  };
  const response = await pages.fetch(new Request('https://chapterweave.bmgg.eu/api/plan?x=1', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '192.0.2.1',
      'x-chapterweave-client-ip': 'spoofed',
      'x-chapterweave-built-in-example': '1',
      authorization: 'must-not-forward',
      'content-type': 'application/json',
    },
    body: '{}',
  }), env);
  assert.equal(response.status, 200);
  assert.equal(forwarded.url, 'https://chapterweave.bmgg.eu/api/plan?x=1');
  assert.equal(forwarded.headers.get('x-chapterweave-client-ip'), '192.0.2.1');
  assert.equal(forwarded.headers.get('x-chapterweave-built-in-example'), null);
  assert.equal(forwarded.headers.get('authorization'), null);
  assert.equal(await forwarded.text(), '{}');
  assert.equal((await pages.fetch(new Request('https://chapterweave.bmgg.eu/'), env)).status, 200);
  assert.equal((await pages.fetch(new Request('https://chapterweave.bmgg.eu/api/other'), env)).status, 404);
  assert.equal((await pages.fetch(new Request('https://chapterweave.bmgg.eu/api/search'), {})).status, 503);
});

test('staged configs keep the key off Pages and the backend off public Worker URLs', async () => {
  const backend = JSON.parse(await readFile(new URL('./backend/wrangler.jsonc', import.meta.url)));
  const page = JSON.parse(await readFile(new URL('./pages/wrangler.jsonc', import.meta.url)));
  assert.equal(backend.workers_dev, false);
  assert.equal(backend.preview_urls, false);
  assert.equal(backend.durable_objects.bindings[0].name, 'QLOO_BUDGET');
  assert.deepEqual(backend.migrations[0].new_sqlite_classes, ['QlooBudget']);
  assert.deepEqual(backend.ratelimits.map((item) => item.name), ['PER_IP_LIMIT', 'SITE_LIMIT']);
  assert.equal(page.services[0].binding, 'BACKEND');
  assert.equal(page.services[0].service, backend.name);
  assert.equal(JSON.stringify(page).includes('QLOO_API_KEY'), false);
  assert.equal(JSON.stringify(backend).includes('QLOO_API_KEY'), false);
});
