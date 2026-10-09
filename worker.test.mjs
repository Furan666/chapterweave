import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { planBooks, recoverBooks, searchEntities } from './worker.mjs';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const entity = (entity_id) => ({ entity_id, name: entity_id, subtype: 'urn:entity:book' });

test('requests the same shelf for both groups and returns an evidence-limited choice', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const order = calls.length === 1 ? ids : ['f', 'b', 'c', 'd', 'e', 'a'];
    return Response.json({ success: true, results: { entities: order.map(entity) } });
  };
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids }, 'fake-private-key', fetcher);
  assert.equal(result.pick.id, 'b');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get('filter.results.entities')), [ids.join(','), ids.join(',')]);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get('signal.interests.entities')), ['film-a', 'artist-b']);
  assert.deepEqual(calls.map((call) => call.options.headers['X-Api-Key']), ['fake-private-key', 'fake-private-key']);
  assert.equal(JSON.stringify(result).includes('fake-private-key'), false);
});

test('planning reports the oldest Qloo source check across its group results', async () => {
  let calls = 0;
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['film-b'],
    shelfIds: ['a', 'b', 'c'] }, 'fake-private-key', async () => {
    calls += 1;
    return Response.json({ success: true, results: { entities: ['a', 'b', 'c'].map(entity) } }, {
      headers: { 'x-qloo-source-checked-at': calls === 1 ?
        '2026-10-09T10:00:00.000Z' : '2026-10-10T10:00:00.000Z' },
    });
  });
  assert.equal(result.status, 'bridge_found');
  assert.equal(result.sourceCheckedAt, '2026-10-09T10:00:00.000Z');
});

test('a three-book quick start reaches a shared first choice with two Insights calls', async () => {
  const shelf = ids.slice(0, 3);
  const calls = [];
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: shelf },
    'fake-private-key', async (url) => {
      calls.push(new URL(url));
      return Response.json({ success: true, results: { entities: (calls.length === 1 ? shelf : ['a', 'c', 'b']).map(entity) } });
    });
  assert.equal(result.status, 'bridge_found');
  assert.equal(result.pick.id, 'a');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.searchParams.get('filter.results.entities')), ['a,b,c', 'a,b,c']);
});

test('planning autonomously checks beyond a shelf with no shared top-half book', async () => {
  const calls = [];
  const orders = [ids, [...ids].reverse(), ['x', 'y', 'z', 'w'],
    ['x', 'y', 'z', 'w'], ['w', 'y', 'z', 'x']];
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async (url) => {
      calls.push(new URL(url));
      return Response.json({ success: true, results: { entities: orders[calls.length - 1].map(entity) } });
    });
  assert.equal(result.status, 'no_bridge');
  assert.equal(result.pick, null);
  assert.equal(result.recovery.status, 'lead_found');
  assert.equal(result.recovery.lead.id, 'y');
  assert.deepEqual(result.recovery.leads.map((lead) => lead.id), ['y']);
  assert.equal(result.recovery.availabilityVerified, false);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.searchParams.get('filter.results.entities')),
    [ids.join(','), ids.join(',')]);
  assert.equal(calls[2].searchParams.get('filter.exclude.entities'), ids.join(','));
});

test('planning preserves its shelf result when optional recovery is rate limited', async () => {
  let calls = 0;
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      calls += 1;
      if (calls === 3) return new Response('', { status: 429 });
      return Response.json({ success: true, results: { entities:
        (calls === 1 ? ids : [...ids].reverse()).map(entity) } });
    });
  assert.equal(calls, 3);
  assert.equal(result.status, 'no_bridge');
  assert.equal(result.pick, null);
  assert.match(result.recoveryWarning, /could not complete/);
  assert.equal(result.recovery, undefined);
});

test('incomplete shelf coverage does not trigger recovery', async () => {
  let calls = 0;
  const result = await planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      calls += 1;
      return Response.json({ success: true, results: { entities:
        (calls === 1 ? ids : ids.slice(0, 5)).map(entity) } });
    });
  assert.equal(calls, 2);
  assert.equal(result.status, 'incomplete_coverage');
  assert.equal(result.recovery, undefined);
});

test('recovery discovers outside the shelf, compares both groups, and returns an unverified inventory lead', async () => {
  const calls = [];
  const candidateIds = ['x', 'y', 'z', 'w'];
  const orders = [candidateIds, candidateIds, ['w', 'y', 'z', 'x']];
  const fetcher = async (url) => {
    calls.push(new URL(url));
    return Response.json({ success: true, results: { entities: orders[calls.length - 1].map(entity) } });
  };
  const result = await recoverBooks({
    groupAIds: ['film-a', 'shared'], groupBIds: ['shared', 'artist-b'], shelfIds: ids, rejectedIds: ['b'],
  }, 'fake-private-key', fetcher);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.pathname === '/v2/insights'));
  assert.equal(calls[0].searchParams.get('filter.type'), 'urn:entity:book');
  assert.equal(calls[0].searchParams.get('signal.interests.entities'), 'film-a,shared,artist-b');
  assert.equal(calls[0].searchParams.get('filter.exclude.entities'), ids.join(','));
  assert.equal(calls[0].searchParams.get('filter.results.entities'), null);
  assert.equal(calls[0].searchParams.get('take'), '6');
  assert.deepEqual(calls.slice(1).map((call) => call.searchParams.get('filter.results.entities')),
    [candidateIds.join(','), candidateIds.join(',')]);
  assert.deepEqual(calls.slice(1).map((call) => call.searchParams.get('signal.interests.entities')),
    ['film-a,shared', 'shared,artist-b']);
  assert.deepEqual(result, {
    status: 'lead_found',
    lead: { id: 'y', name: 'y', aRank: 2, bRank: 2 },
    leads: [{ id: 'y', name: 'y', aRank: 2, bRank: 2 }],
    trace: [
      { step: 'discover', candidateCount: 4, excludedCount: 6 },
      { step: 'compare', candidateCount: 4 },
      { step: 'decision', outcome: 'lead_found' },
    ],
    availabilityVerified: false,
  });
  assert.equal(JSON.stringify(result).includes('fake-private-key'), false);
});

test('recovery keeps every qualifying lead from one Qloo comparison for unavailable-book feedback', async () => {
  const orders = [['x', 'y', 'z', 'w'], ['x', 'y', 'z', 'w'], ['y', 'x', 'z', 'w']];
  let calls = 0;
  const result = await recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      const response = Response.json({ success: true, results: { entities: orders[calls].map(entity) } });
      calls += 1;
      return response;
    });
  assert.equal(calls, 3);
  assert.equal(result.status, 'lead_found');
  assert.deepEqual(result.leads, [
    { id: 'x', name: 'x', aRank: 1, bRank: 2 },
    { id: 'y', name: 'y', aRank: 2, bRank: 1 },
  ]);
  assert.deepEqual(result.lead, result.leads[0]);
});

test('recovery stops after discovery when Qloo finds no candidates', async () => {
  let calls = 0;
  const result = await recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      calls += 1;
      return Response.json({ success: true, results: { entities: [] } });
    });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: 'no_candidates', lead: null, leads: [],
    trace: [{ step: 'discover', candidateCount: 0, excludedCount: 6 },
      { step: 'decision', outcome: 'no_candidates' }],
    availabilityVerified: false,
  });
});

test('recovery abstains when one candidate would rank first for both groups by default', async () => {
  let calls = 0;
  const result = await recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      calls += 1;
      return Response.json({ success: true, results: { entities: [entity('x')] } });
    });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: 'insufficient_candidates', lead: null, leads: [],
    trace: [{ step: 'discover', candidateCount: 1, excludedCount: 6 },
      { step: 'decision', outcome: 'insufficient_candidates' }],
    availabilityVerified: false,
  });
});

test('recovery abstains when separate Qloo comparisons find no bridge or incomplete coverage', async () => {
  for (const [lastOrder, status] of [
    [['w', 'z', 'y', 'x'], 'no_bridge'],
    [['w', 'y', 'z'], 'incomplete_coverage'],
  ]) {
    let calls = 0;
    const orders = [['x', 'y', 'z', 'w'], ['x', 'y', 'z', 'w'], lastOrder];
    const result = await recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
      'fake-private-key', async () => {
        const response = Response.json({ success: true, results: { entities: orders[calls].map(entity) } });
        calls += 1;
        return response;
      });
    assert.equal(calls, 3);
    assert.equal(result.status, status);
    assert.equal(result.lead, null);
    assert.deepEqual(result.leads, []);
    assert.equal(result.trace.at(-1).outcome, status);
  }
});

test('recovery validates feedback and refuses invalid Qloo candidates before comparing', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return Response.json({ success: true, results: { entities: [entity('a')] } });
  };
  await assert.rejects(recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids,
    rejectedIds: ['outside'] }, 'fake-private-key', fetcher), /rejectedIds/);
  assert.equal(calls, 0);
  await assert.rejects(recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', fetcher), /invalid recovery candidate/);
  assert.equal(calls, 1);
  await assert.rejects(recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'],
    shelfIds: [' a ', ...ids.slice(1)] }, 'fake-private-key', fetcher), /invalid recovery candidate/);
  assert.equal(calls, 2);
});

test('recovery never converts a Qloo rate limit into an inventory lead', async () => {
  let calls = 0;
  await assert.rejects(recoverBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids },
    'fake-private-key', async () => {
      calls += 1;
      return calls === 1 ? Response.json({ success: true, results: { entities: [entity('x'), entity('y')] } }) :
        new Response('', { status: 429 });
    }), /rate limit/);
  assert.equal(calls, 2);
});

test('invalid input does not reach Qloo', async () => {
  let called = false;
  await assert.rejects(
    planBooks({ groupAIds: ['film-a'], groupBIds: [], shelfIds: ids }, 'fake-private-key', async () => {
      called = true;
    }),
    /nonempty array/,
  );
  assert.equal(called, false);
  for (const shelfIds of [ids.slice(0, 2), [...ids, 'g']]) {
    await assert.rejects(planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds },
      'fake-private-key', async () => { called = true; }), /3–6 books/);
  }
  assert.equal(called, false);
});

test('does not silently convert a Qloo rate limit into a recommendation', async () => {
  await assert.rejects(
    planBooks({ groupAIds: ['film-a'], groupBIds: ['artist-b'], shelfIds: ids }, 'fake-private-key', async () => new Response('', { status: 429 })),
    /rate limit/,
  );
});

test('search resolves exact book IDs through Qloo without exposing the event key', async () => {
  let call;
  const result = await searchEntities('Dune', true, 'fake-private-key', async (url, options) => {
    call = { url: new URL(url), options };
    return Response.json({ success: true, results: { entities: [
      { entity_id: 'film-1', name: 'Dune', subtype: 'urn:entity:movie' },
      { entity_id: 'book-1', name: 'Dune', subtype: 'urn:entity:book' },
      { entity_id: 'book-1', name: 'Dune', subtype: 'urn:entity:book' },
    ] } });
  });
  assert.equal(call.url.pathname, '/search');
  assert.equal(call.url.origin, 'https://hackathon.api.qloo.com');
  assert.equal(call.url.searchParams.get('query'), 'Dune');
  assert.equal(call.url.searchParams.get('types'), 'urn:entity:book');
  assert.equal(call.options.headers['X-Api-Key'], 'fake-private-key');
  assert.deepEqual(result, { choices: [{ id: 'book-1', name: 'Dune', subtype: 'urn:entity:book' }] });
  assert.equal(JSON.stringify(result).includes('fake-private-key'), false);
});

test('search distinguishes same-title films by their Qloo release years', async () => {
  const result = await searchEntities('Parasite', false, 'fake-private-key', async () =>
    Response.json({ success: true, results: [
      { entity_id: 'film-2019', name: 'Parasite', types: ['urn:entity:movie'], properties: { release_year: 2019 } },
      { entity_id: 'film-1982', name: 'Parasite', types: ['urn:entity:movie'], properties: { release_year: 1982 } },
    ] }));
  assert.deepEqual(result.choices, [
    { id: 'film-2019', name: 'Parasite', subtype: 'urn:entity:movie', disambiguation: '2019' },
    { id: 'film-1982', name: 'Parasite', subtype: 'urn:entity:movie', disambiguation: '1982' },
  ]);
});

test('search accepts the current Qloo CLI result envelope and entity aliases', async () => {
  let host;
  const result = await searchEntities('Dune', true, 'fake-private-key', async () =>
    Response.json({ results: [
      { id: 'book-2', name: 'Dune', type: 'urn:entity:book' },
      { id: 'book-3', name: 'Dune Messiah', types: ['urn:entity:book'] },
    ] }));
  assert.deepEqual(result, { choices: [
    { id: 'book-2', name: 'Dune', subtype: 'urn:entity:book' },
    { id: 'book-3', name: 'Dune Messiah', subtype: 'urn:entity:book' },
  ] });
  assert.deepEqual(await searchEntities('Unknown', true, 'fake-private-key', async () =>
    Response.json({ results: [] })), { choices: [] });
  await searchEntities('Dune', true, 'fake-private-key', async (url) => {
    host = new URL(url).host;
    return Response.json({ results: [] });
  }, 'https://hackathon.api.qloo.com');
  assert.equal(host, 'hackathon.api.qloo.com');
});

test('search treats documented 404 as no matches but preserves auth and rate errors', async () => {
  const empty = await searchEntities('Unknown title', true, 'fake-private-key', async () =>
    new Response('', { status: 404 }));
  assert.deepEqual(empty, { choices: [] });
  assert.equal(JSON.stringify(empty).includes('fake-private-key'), false);
  await assert.rejects(searchEntities('Dune', true, 'fake-private-key', async () =>
    new Response('', { status: 401 })), /Qloo search failed \(401\)/);
  await assert.rejects(searchEntities('Dune', true, 'fake-private-key', async () =>
    new Response('', { status: 429 })), /rate limit/);
});

test('search rejects invalid input and unexpected Qloo response without fake matches', async () => {
  let called = false;
  await assert.rejects(searchEntities(' ', false, 'fake-private-key', async () => {
    called = true;
  }), /2–120 characters/);
  assert.equal(called, false);
  await assert.rejects(searchEntities('Dune', false, 'fake-private-key', async () =>
    Response.json({ success: true, results: {} })), /unexpected Search response/);
});

test('search never sends an event key to an unapproved configured host', async () => {
  let called = false;
  await assert.rejects(searchEntities('Dune', true, 'fake-private-key', async () => {
    called = true;
  }, 'http://api.qloo.com'), /must use HTTPS/);
  await assert.rejects(searchEntities('Dune', true, 'fake-private-key', async () => {
    called = true;
  }, 'https://api.qloo.com'), /official hackathon API host/);
  assert.equal(called, false);
});

test('public status says when the Worker has a key and both request limits', async () => {
  const request = new Request('https://example.test/api/status');
  const disconnected = await worker.fetch(request, {});
  assert.deepEqual(await disconnected.json(), { configured: false });
  const connected = await worker.fetch(request, {
    QLOO_API_KEY: 'fake-private-key', PER_IP_LIMIT: {}, SITE_LIMIT: {},
  });
  assert.deepEqual(await connected.json(), { configured: true });
  const wrongMethod = await worker.fetch(new Request(request.url, { method: 'POST' }), {});
  assert.equal(wrongMethod.status, 405);
});

test('public planning route fails closed without quota guards', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/plan', {
    method: 'POST',
    body: '{}',
  }), { QLOO_API_KEY: 'fake-private-key' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /request limits/);
});

test('public planning route refuses a limited visitor before contacting Qloo', async () => {
  const checked = [];
  const response = await worker.fetch(new Request('https://example.test/api/plan', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '192.0.2.1' },
    body: '{}',
  }), {
    QLOO_API_KEY: 'fake-private-key',
    PER_IP_LIMIT: { limit: async ({ key }) => { checked.push(key); return { success: false }; } },
    SITE_LIMIT: { limit: async ({ key }) => { checked.push(key); return { success: true }; } },
  });
  assert.equal(response.status, 429);
  assert.deepEqual(checked, ['192.0.2.1', 'all']);
  assert.equal(JSON.stringify(await response.json()).includes('fake-private-key'), false);
});

test('public search route is guarded and reports a missing event key', async () => {
  const request = new Request('https://example.test/api/search?q=Dune&type=book');
  assert.equal((await worker.fetch(request, {})).status, 503);
  const env = {
    PER_IP_LIMIT: { limit: async () => ({ success: true }) },
    SITE_LIMIT: { limit: async () => ({ success: true }) },
  };
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /event key/);
});

test('public recovery route requires POST, quota guards, and the event key', async () => {
  const url = 'https://example.test/api/recover';
  assert.equal((await worker.fetch(new Request(url), {})).status, 405);
  const request = new Request(url, { method: 'POST', body: '{}' });
  assert.equal((await worker.fetch(request.clone(), {})).status, 503);
  const response = await worker.fetch(request, {
    PER_IP_LIMIT: { limit: async () => ({ success: true }) },
    SITE_LIMIT: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /event key/);
});
