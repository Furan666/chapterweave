import { bookDiscoveryQuery, bookInsightsQuery, rankShelf } from './planner.mjs';

const QLOO_API_BASE = 'https://hackathon.api.qloo.com';
const BOOK_TYPE = 'urn:entity:book';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function clientError(message, status = 400) {
  return json({ error: message }, status);
}

function qlooEndpoint(path, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('Qloo API host is invalid');
  }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Qloo API host must use HTTPS');
  }
  if (base.origin !== QLOO_API_BASE || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Qloo event key requires the official hackathon API host');
  }
  return new URL(path, base);
}

function checkedAt(response) {
  const value = response.headers.get('x-qloo-source-checked-at');
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function oldestCheckedAt(...values) {
  return values.filter(Boolean).sort()[0] || null;
}

function sourceDetail(value) {
  return value ? { sourceCheckedAt: value } : {};
}

async function fetchInsights(query, apiKey, fetcher, baseUrl) {
  const url = qlooEndpoint('/v2/insights', baseUrl);
  url.search = query;
  const response = await fetcher(url.toString(), {
    headers: { accept: 'application/json', 'X-Api-Key': apiKey },
  });
  if (response.status === 429) {
    throw new Error('Qloo rate limit reached; try again later');
  }
  if (!response.ok) {
    throw new Error(`Qloo request failed (${response.status})`);
  }
  const body = await response.json();
  if (body?.success !== true || !Array.isArray(body?.results?.entities)) {
    throw new Error('Qloo returned an unexpected Insights response');
  }
  return { entities: body.results.entities, sourceCheckedAt: checkedAt(response) };
}

async function fetchBooks(seedIds, shelfIds, apiKey, fetcher, baseUrl) {
  return fetchInsights(bookInsightsQuery(seedIds, shelfIds), apiKey, fetcher, baseUrl);
}

export async function searchEntities(query, bookOnly, apiKey, fetcher = fetch, baseUrl = QLOO_API_BASE) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 120) {
    throw new TypeError('Search title must be 2–120 characters');
  }
  if (typeof bookOnly !== 'boolean') {
    throw new TypeError('Invalid search type');
  }
  if (!apiKey) {
    throw new Error('Qloo event key is not configured');
  }
  const params = new URLSearchParams({ query: query.trim(), take: '20' });
  if (bookOnly) params.set('types', BOOK_TYPE);
  const response = await fetcher(`${qlooEndpoint('/search', baseUrl)}?${params}`, {
    headers: { accept: 'application/json', 'X-Api-Key': apiKey },
  });
  if (response.status === 429) {
    throw new Error('Qloo rate limit reached; try again later');
  }
  if (response.status === 404) {
    return { choices: [] };
  }
  if (!response.ok) {
    throw new Error(`Qloo search failed (${response.status})`);
  }
  const body = await response.json();
  const found = Array.isArray(body?.results) ? body.results : body?.results?.entities;
  if (body?.success === false || !Array.isArray(found)) {
    throw new Error('Qloo returned an unexpected Search response');
  }
  const seen = new Set();
  const choices = [];
  for (const entity of found) {
    const id = entity?.entity_id ?? entity?.id;
    const subtype = entity?.subtype ?? entity?.type ??
      (Array.isArray(entity?.types) ? entity.types.find((type) => typeof type === 'string' && type.startsWith('urn:entity:')) : null);
    if (typeof id !== 'string' || !id ||
        typeof entity?.name !== 'string' || !entity.name.trim() ||
        typeof subtype !== 'string' || !subtype.startsWith('urn:entity:')) {
      throw new Error('Qloo returned an unexpected Search entity');
    }
    if ((bookOnly && subtype !== BOOK_TYPE) || seen.has(id)) continue;
    seen.add(id);
    const year = subtype === 'urn:entity:movie' ? entity?.properties?.release_year : null;
    const detail = Number.isInteger(year) && year >= 1888 && year <= 2100 ? String(year) :
      typeof entity.disambiguation === 'string' ? entity.disambiguation.trim().slice(0, 80) : '';
    choices.push({ id, name: entity.name, subtype, ...(detail ? { disambiguation: detail } : {}) });
    if (choices.length === 10) break;
  }
  return { choices, ...sourceDetail(checkedAt(response)) };
}

export async function planBooks(input, apiKey, fetcher = fetch, baseUrl = QLOO_API_BASE) {
  if (!apiKey) {
    throw new Error('Qloo event key is not configured');
  }
  if (!input || typeof input !== 'object') {
    throw new TypeError('Request must be an object');
  }
  const { groupAIds, groupBIds, shelfIds } = input;
  // Validate every argument before making any external request.
  bookInsightsQuery(groupAIds, shelfIds);
  bookInsightsQuery(groupBIds, shelfIds);
  if (shelfIds.length < 3 || shelfIds.length > 6) {
    throw new RangeError('shelfIds must contain 3–6 books');
  }
  const a = await fetchBooks(groupAIds, shelfIds, apiKey, fetcher, baseUrl);
  const b = await fetchBooks(groupBIds, shelfIds, apiKey, fetcher, baseUrl);
  const plan = rankShelf(shelfIds, a.entities, b.entities);
  const planCheckedAt = oldestCheckedAt(a.sourceCheckedAt, b.sourceCheckedAt);
  if (plan.status !== 'no_bridge') return { ...plan, ...sourceDetail(planCheckedAt) };
  try {
    const recovery = await recoverBooks({ groupAIds, groupBIds, shelfIds }, apiKey, fetcher, baseUrl);
    return { ...plan, recovery,
      ...sourceDetail(oldestCheckedAt(planCheckedAt, recovery.sourceCheckedAt)) };
  } catch {
    // Keep the honest shelf result when the optional next step is unavailable.
    return { ...plan, ...sourceDetail(planCheckedAt),
      recoveryWarning: 'The search beyond this shelf could not complete. Try again later.' };
  }
}

export async function recoverBooks(input, apiKey, fetcher = fetch, baseUrl = QLOO_API_BASE) {
  if (!apiKey) {
    throw new Error('Qloo event key is not configured');
  }
  if (!input || typeof input !== 'object') {
    throw new TypeError('Request must be an object');
  }
  const { groupAIds, groupBIds, shelfIds, rejectedIds = [] } = input;
  // Validate the complete request before spending a Qloo call.
  bookInsightsQuery(groupAIds, shelfIds);
  bookInsightsQuery(groupBIds, shelfIds);
  if (shelfIds.length < 3 || shelfIds.length > 6) {
    throw new RangeError('shelfIds must contain 3–6 books');
  }
  const discoveryQuery = bookDiscoveryQuery(groupAIds, groupBIds, shelfIds);
  const shelf = new Set(shelfIds.map((id) => id.trim()));
  if (!Array.isArray(rejectedIds) ||
      rejectedIds.some((id) => typeof id !== 'string' || !shelf.has(id)) ||
      new Set(rejectedIds).size !== rejectedIds.length) {
    throw new TypeError('rejectedIds must contain distinct IDs from shelfIds');
  }

  const discovery = await fetchInsights(discoveryQuery, apiKey, fetcher, baseUrl);
  const candidates = discovery.entities;
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate?.entity_id !== 'string' || !candidate.entity_id ||
        typeof candidate.name !== 'string' || !candidate.name.trim() ||
        candidate.subtype !== BOOK_TYPE || shelf.has(candidate.entity_id) ||
        seen.has(candidate.entity_id)) {
      throw new Error('Qloo returned an invalid recovery candidate');
    }
    seen.add(candidate.entity_id);
  }
  if (candidates.length > 6) {
    throw new Error('Qloo returned too many recovery candidates');
  }
  const trace = [{ step: 'discover', candidateCount: candidates.length, excludedCount: shelf.size }];
  if (!candidates.length) {
    return { status: 'no_candidates', lead: null, leads: [],
      trace: [...trace, { step: 'decision', outcome: 'no_candidates' }], availabilityVerified: false,
      ...sourceDetail(discovery.sourceCheckedAt) };
  }
  if (candidates.length === 1) {
    return { status: 'insufficient_candidates', lead: null, leads: [],
      trace: [...trace, { step: 'decision', outcome: 'insufficient_candidates' }], availabilityVerified: false,
      ...sourceDetail(discovery.sourceCheckedAt) };
  }

  const candidateIds = candidates.map((candidate) => candidate.entity_id);
  const a = await fetchBooks(groupAIds, candidateIds, apiKey, fetcher, baseUrl);
  const b = await fetchBooks(groupBIds, candidateIds, apiKey, fetcher, baseUrl);
  const ranked = rankShelf(candidateIds, a.entities, b.entities);
  const status = ranked.status === 'bridge_found' ? 'lead_found' : ranked.status;
  const leads = status === 'lead_found' ? ranked.ranked.filter((row) => row.bridge).map((row) => ({
    id: row.id,
    name: candidates.find((candidate) => candidate.entity_id === row.id).name,
    aRank: row.aRank,
    bRank: row.bRank,
  })) : [];
  return {
    status,
    lead: leads[0] || null,
    leads,
    trace: [...trace, { step: 'compare', candidateCount: candidates.length }, { step: 'decision', outcome: status }],
    availabilityVerified: false,
    ...sourceDetail(oldestCheckedAt(discovery.sourceCheckedAt, a.sourceCheckedAt, b.sourceCheckedAt)),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/status') {
      if (request.method !== 'GET') return clientError('Use GET for status', 405);
      return json({ configured: Boolean(env.QLOO_API_KEY && env.PER_IP_LIMIT && env.SITE_LIMIT) });
    }
    const isSearch = url.pathname === '/api/search';
    const isRecover = url.pathname === '/api/recover';
    if (!isSearch && !isRecover && url.pathname !== '/api/plan') {
      return env.ASSETS ? env.ASSETS.fetch(request) : clientError('Page not found', 404);
    }
    if (request.method !== (isSearch ? 'GET' : 'POST')) {
      return clientError(isSearch ? 'Use GET for search' : isRecover ? 'Use POST for recovery' : 'Use POST for planning', 405);
    }
    if (!env.PER_IP_LIMIT || !env.SITE_LIMIT) {
      return clientError('Demo request limits are not configured', 503);
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const [visitor, site] = await Promise.all([
      env.PER_IP_LIMIT.limit({ key: ip }),
      env.SITE_LIMIT.limit({ key: 'all' }),
    ]);
    if (!visitor.success || !site.success) {
      return clientError('Demo request limit reached; try again shortly', 429);
    }
    if (isSearch) {
      const type = url.searchParams.get('type');
      if (type !== null && type !== 'book') return clientError('Invalid search type');
      try {
        return json(await searchEntities(url.searchParams.get('q'), type === 'book', env.QLOO_API_KEY, fetch, env.QLOO_API_BASE_URL || QLOO_API_BASE));
      } catch (error) {
        if (error instanceof TypeError) return clientError(error.message);
        return clientError(error.message, 503);
      }
    }
    const raw = await request.text();
    if (raw.length > 16_384) {
      return clientError('Request is too large', 413);
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return clientError('Request must be JSON');
    }
    try {
      const baseUrl = env.QLOO_API_BASE_URL || QLOO_API_BASE;
      return json(isRecover ?
        await recoverBooks(input, env.QLOO_API_KEY, fetch, baseUrl) :
        await planBooks(input, env.QLOO_API_KEY, fetch, baseUrl));
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return clientError(error.message);
      }
      return clientError(error.message, 503);
    }
  },
};
