import { planBooks, recoverBooks, searchEntities } from '../../worker.mjs';

const QLOO_ORIGIN = 'https://hackathon.api.qloo.com';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

class BudgetExceeded extends Error {}

function budgetedQlooFetch(env) {
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
        return json({ configured: Boolean(
          env.QLOO_API_KEY && env.PER_IP_LIMIT && env.SITE_LIMIT && env.QLOO_BUDGET,
        ) });
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

      const callQloo = budgetedQlooFetch(env);
      if (search) {
        const type = url.searchParams.get('type');
        if (type !== null && type !== 'book') return json({ error: 'Invalid search type' }, 400);
        try {
          return json(await searchEntities(url.searchParams.get('q'), type === 'book', env.QLOO_API_KEY, callQloo));
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
