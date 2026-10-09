import { planBooks, recoverBooks, searchEntities } from '../../worker.mjs';

const QLOO_ORIGIN = 'https://hackathon.api.qloo.com';
// Match only the two public, fixed-input walkthroughs in public/app.js.
// This reserves capacity for the built-in demonstration, not for a visitor identity.
const EXAMPLE_A = 'C7EC4CA9-1CCC-4991-B738-55F075441B3F';
const EXAMPLE_B = new Set([
  '057DA9D9-399B-437E-8BCA-A80E499125EF',
  'A499EC25-7FF6-46DE-9DA5-3E78E99B9E26',
]);
const EXAMPLE_SHELF = [
  '2E76F365-7C08-4DDF-8C49-CC27582788E5',
  '6CDF2DC4-2238-4C22-B0E3-7FDE341BF8C8',
  'CF50199E-9457-4A5B-A4D4-378910DE9A77',
  '3681886D-A7AB-484B-ACE8-DEA2027B4964',
];

function exactList(values, expected) {
  return Array.isArray(values) && values.length === expected.length &&
    values.every((value, index) => value === expected[index]);
}

function builtInExamplePlan(input) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === 3 &&
    Object.keys(input).every((key) => ['groupAIds', 'groupBIds', 'shelfIds'].includes(key)) &&
    exactList(input.groupAIds, [EXAMPLE_A]) &&
    Array.isArray(input.groupBIds) && input.groupBIds.length === 1 &&
    EXAMPLE_B.has(input.groupBIds[0]) &&
    exactList(input.shelfIds, EXAMPLE_SHELF);
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

class BudgetExceeded extends Error {}

function budgetedQlooFetch(env, builtInExample = false) {
  return async (address) => {
    const url = new URL(address);
    if (url.origin !== QLOO_ORIGIN ||
        !['/search', '/v2/insights'].includes(url.pathname) ||
        url.username || url.password || url.hash) {
      throw new Error('Unexpected Qloo endpoint');
    }
    const namespace = env.QLOO_BUDGET;
    if (!namespace?.idFromName || !namespace?.get) throw new Error('Shared budget binding missing');
    // One stable object shares cached results and the call cap across all visitors.
    const stub = namespace.get(namespace.idFromName('chapterweave-qloo-key-v1'));
    try {
      const response = await stub.fetch(new Request('https://budget.internal/request', {
        method: 'POST', body: address,
        headers: builtInExample ? { 'x-chapterweave-built-in-example': '1' } : {},
      }));
      if (response.headers.get('x-chapterweave-budget-exhausted') === '1') throw new BudgetExceeded();
      return response;
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      throw new Error('Qloo transport unavailable');
    }
  };
}

function failure(error) {
  if (error instanceof BudgetExceeded) {
    return json({ error: 'Demo call budget reached' }, 429);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return json({ error: error.message }, 400);
  }
  return json({ error: 'Live catalog is unavailable; try again later' }, 503);
}

export function createBackend() {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/api/status') {
        if (request.method !== 'GET') return json({ error: 'Use GET for status' }, 405);
        if (!env.QLOO_API_KEY || !env.PER_IP_LIMIT || !env.SITE_LIMIT || !env.QLOO_BUDGET) {
          return json({ configured: false });
        }
        try {
          const stub = env.QLOO_BUDGET.get(env.QLOO_BUDGET.idFromName('chapterweave-qloo-key-v1'));
          const response = await stub.fetch(new Request('https://budget.internal/status'));
          if (!response.ok) return json({ configured: false });
          const status = await response.json();
          if (!status.keyConfigured) return json({ configured: false });
          return json({ configured: true, localBudget: {
            used: status.used, remaining: status.remaining,
            generalRemaining: status.generalRemaining, freshEntries: status.freshEntries,
          } });
        } catch {
          return json({ configured: false });
        }
      }
      const search = url.pathname === '/api/search';
      const recover = url.pathname === '/api/recover';
      if (!search && !recover && url.pathname !== '/api/plan') {
        return json({ error: 'Page not found' }, 404);
      }
      if (request.method !== (search ? 'GET' : 'POST')) {
        return json({ error: search ? 'Use GET for search' : 'Use POST for planning' }, 405);
      }
      if (!env.QLOO_API_KEY || !env.PER_IP_LIMIT || !env.SITE_LIMIT || !env.QLOO_BUDGET) {
        return json({ error: 'Live catalog is unavailable' }, 503);
      }
      try {
        const ip = request.headers.get('x-chapterweave-client-ip') || 'unknown';
        const [visitor, site] = await Promise.all([
          env.PER_IP_LIMIT.limit({ key: ip }),
          env.SITE_LIMIT.limit({ key: 'all' }),
        ]);
        if (visitor?.success !== true || site?.success !== true) {
          return json({ error: 'Demo request limit reached; try again shortly' }, 429);
        }
      } catch {
        return json({ error: 'Demo request limits are unavailable' }, 503);
      }

      if (search) {
        const type = url.searchParams.get('type');
        if (type !== null && type !== 'book') return json({ error: 'Invalid search type' }, 400);
        try {
          return json(await searchEntities(url.searchParams.get('q'), type === 'book',
            env.QLOO_API_KEY, budgetedQlooFetch(env)));
        } catch (error) {
          return failure(error);
        }
      }

      let raw;
      try {
        raw = await request.text();
      } catch {
        return json({ error: 'Request body could not be read' }, 400);
      }
      if (raw.length > 16_384) return json({ error: 'Request is too large' }, 413);
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return json({ error: 'Request must be JSON' }, 400);
      }
      try {
        const callQloo = budgetedQlooFetch(env, !recover && builtInExamplePlan(input));
        return json(recover ?
          await recoverBooks(input, env.QLOO_API_KEY, callQloo) :
          await planBooks(input, env.QLOO_API_KEY, callQloo));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export default createBackend();
