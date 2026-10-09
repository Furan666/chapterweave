import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(tag = '') {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  scrollIntoView() {}
}

function find(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

test('offline lead confirmation compares a revised synthetic shelf without a Qloo call', () => {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelector: () => new Element(),
    querySelectorAll: (selector) => selector === '.step-tab'
      ? [new Element(), new Element(), new Element()] : [],
  };
  let requests = 0;
  const context = vm.createContext({ document, URLSearchParams, fetch: async () => {
    requests += 1;
    throw new Error('offline');
  } });
  vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);

  for (const [unavailable, expectedId] of [[false, 'fixture-7'], [true, 'fixture-8']]) {
    vm.runInContext("showPreview('no-bridge')", context);
    const recovery = elements.get('recovery-body');
    if (unavailable) {
      const next = find(recovery, (element) => element.tag === 'button' &&
        element.textContent.startsWith('I cannot obtain it'));
      assert.ok(next);
      next.listeners.click();
    }
    const confirm = find(recovery, (element) => element.tag === 'button' &&
      element.textContent.startsWith('Simulate obtaining it'));
    assert.ok(confirm);
    const before = requests;
    confirm.listeners.click();
    assert.equal(requests, before);
    assert.equal(vm.runInContext('result.status', context), 'bridge_found');
    assert.equal(vm.runInContext('result.pick.id', context), expectedId);
    assert.equal(vm.runInContext('result.ranked.length', context), 6);
    assert.equal(elements.get('reject-pick').hidden, true);
    assert.equal(elements.get('recovery-body').hidden, true);
  }
});

test('same-title movie matches show distinct release years before selection', () => {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelector: () => new Element(),
    querySelectorAll: () => [new Element(), new Element(), new Element()],
  };
  const context = vm.createContext({ document, URLSearchParams, fetch: async () => { throw new Error('offline'); } });
  vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`renderChoices('a', 0, [
    { id: 'film-2019', name: 'Parasite', subtype: 'urn:entity:movie', disambiguation: '2019' },
    { id: 'film-1982', name: 'Parasite', subtype: 'urn:entity:movie', disambiguation: '1982' },
  ], document.getElementById('matches-test'), document.getElementById('status-test'))`, context);
  const matches = elements.get('matches-test');
  assert.ok(find(matches, (element) => element.tag === 'small' && element.textContent === 'movie · 2019'));
  assert.ok(find(matches, (element) => element.tag === 'small' && element.textContent === 'movie · 1982'));
});

test('illustrative live example and counterfactual switch make no request until Plan', async () => {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelector: () => new Element(),
    querySelectorAll: () => [new Element(), new Element(), new Element()],
  };
  const requests = [];
  const context = vm.createContext({ document, URLSearchParams, fetch: async (url) => {
    requests.push(url);
    throw new Error('offline');
  } });
  vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);
  const before = requests.length; // The page checks /api/status on startup.

  elements.get('load-live-example').listeners.click();
  assert.equal(requests.length, before);
  assert.equal(vm.runInContext('entries.a[0].id', context), 'C7EC4CA9-1CCC-4991-B738-55F075441B3F');
  assert.equal(vm.runInContext('entries.b[0].id', context), '057DA9D9-399B-437E-8BCA-A80E499125EF');
  assert.equal(vm.runInContext('entries.book.filter((field) => field.id).length', context), 4);
  assert.equal(vm.runInContext('entries.book[0].name', context), "The Handmaid's Tale");
  assert.equal(elements.get('example-note').hidden, false);
  assert.equal(vm.runInContext('preparedInput().error', context), undefined);

  vm.runInContext(`result = {
    status: 'bridge_found',
    pick: { id: entries.book[0].id, aRank: 1, bRank: 1, bridge: true },
    ranked: entries.book.slice(0, 4).map((book, index) => ({
      id: book.id, aRank: index + 1, bRank: index + 1, bridge: index < 2,
    })),
    missing: [],
  }; resultSource = 'server'; renderResult();`, context);
  assert.equal(elements.get('switch-example-group').hidden, false);

  elements.get('switch-example-group').listeners.click();
  assert.equal(requests.length, before);
  assert.equal(vm.runInContext('entries.b[0].id', context), 'A499EC25-7FF6-46DE-9DA5-3E78E99B9E26');
  assert.equal(vm.runInContext('entries.b[0].name', context), 'Parasite (2019)');
  assert.equal(vm.runInContext('entries.a[0].id', context), 'C7EC4CA9-1CCC-4991-B738-55F075441B3F');
  assert.equal(vm.runInContext('entries.book.filter((field) => field.id).length', context), 4);
  assert.equal(elements.get('example-replan-note').hidden, false);
  assert.equal(elements.get('switch-example-group').hidden, true);
  assert.equal(vm.runInContext('result', context), null);

  await elements.get('plan-button').listeners.click();
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1), '/api/plan');
});

test('two live example plans show their returned ranks side by side without another request', async () => {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelector: () => new Element(),
    querySelectorAll: () => [new Element(), new Element(), new Element()],
  };
  const requests = [];
  const ranks = [
    { groupB: [1, 3, 4, 2], status: 'bridge_found' },
    { groupB: [3, 4, 1, 2], status: 'no_bridge' },
  ];
  const context = vm.createContext({ document, URLSearchParams, fetch: async (url, options) => {
    if (url === '/api/status') return Response.json({ configured: true });
    assert.equal(url, '/api/plan');
    requests.push(JSON.parse(options.body));
    const current = ranks[requests.length - 1];
    const groupA = [1, 2, 4, 3];
    const ranked = requests.at(-1).shelfIds.map((id, index) => ({
      id, aRank: groupA[index], bRank: current.groupB[index],
      bridge: groupA[index] <= 2 && current.groupB[index] <= 2,
    }));
    return Response.json({
      status: current.status,
      pick: ranked.find((row) => row.bridge) || null,
      ranked,
      missing: [],
      sourceCheckedAt: requests.length === 1 ? '2026-10-09T10:00:00.000Z' : '2026-10-10T10:00:00.000Z',
    });
  } });
  vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);

  elements.get('load-live-example').listeners.click();
  await elements.get('plan-button').listeners.click();
  assert.equal(requests.length, 1);
  assert.equal(find(elements.get('result-body'), (item) => item.className === 'example-comparison'), null);

  elements.get('switch-example-group').listeners.click();
  assert.equal(requests.length, 1);
  await elements.get('plan-button').listeners.click();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].groupBIds[0], '057DA9D9-399B-437E-8BCA-A80E499125EF');
  assert.equal(requests[1].groupBIds[0], 'A499EC25-7FF6-46DE-9DA5-3E78E99B9E26');
  assert.deepEqual(requests[0].shelfIds, requests[1].shelfIds);

  const comparison = find(elements.get('result-body'), (item) => item.className === 'example-comparison');
  assert.ok(comparison);
  assert.ok(find(comparison, (item) => item.textContent.includes('source-check times are shown')));
  const cards = find(comparison, (item) => item.className === 'comparison-grid').children;
  assert.equal(cards.length, 2);
  assert.ok(find(cards[0], (item) => item.textContent === 'Before · Interstellar'));
  assert.ok(find(cards[0], (item) => item.textContent === "Shared pick: The Handmaid's Tale"));
  assert.ok(find(cards[0], (item) => item.textContent === 'A #1 · B #1'));
  assert.ok(find(cards[0], (item) => item.textContent.includes('7 days old')));
  assert.ok(find(cards[1], (item) => item.textContent === 'After · Parasite (2019)'));
  assert.ok(find(cards[1], (item) => item.textContent === 'No shared top-half book'));
  assert.ok(find(cards[1], (item) => item.textContent === 'A #1 · B #3'));

  vm.runInContext("showPreview('bridge')", context);
  assert.equal(find(elements.get('result-body'), (item) => item.className === 'example-comparison'), null);
  assert.equal(requests.length, 2);
});

test('live abstention puts the actual recovery outcome and next action before the rank table', async () => {
  const cases = [
    {
      status: 'lead_found',
      lead: { id: 'new-book', name: 'A Possible Bridge', aRank: 1, bRank: 2 },
      leads: [{ id: 'new-book', name: 'A Possible Bridge', aRank: 1, bRank: 2 }],
      trace: [{ step: 'discover', candidateCount: 4, excludedCount: 4 },
        { step: 'compare', candidateCount: 4 }, { step: 'decision', outcome: 'lead_found' }],
    },
    {
      status: 'no_candidates', lead: null, leads: [],
      trace: [{ step: 'discover', candidateCount: 0, excludedCount: 4 },
        { step: 'decision', outcome: 'no_candidates' }],
    },
  ];
  for (const recovery of cases) {
    const elements = new Map();
    const document = {
      createElement: (tag) => new Element(tag),
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      querySelector: () => new Element(),
      querySelectorAll: () => [new Element(), new Element(), new Element()],
    };
    const context = vm.createContext({ document, URLSearchParams, fetch: async (url, options) => {
      if (url === '/api/status') return Response.json({ configured: true });
      assert.equal(url, '/api/plan');
      const { shelfIds } = JSON.parse(options.body);
      return Response.json({
        status: 'no_bridge', pick: null, missing: [],
        ranked: shelfIds.map((id, index) => ({
          id, aRank: index + 1, bRank: [3, 4, 1, 2][index], bridge: false,
        })),
        recovery: { ...recovery, availabilityVerified: false,
          sourceCheckedAt: '2026-10-09T09:00:00.000Z' },
        sourceCheckedAt: '2026-10-09T08:00:00.000Z',
      });
    } });
    vm.runInContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);
    elements.get('load-live-example').listeners.click();
    await elements.get('plan-button').listeners.click();

    const resultBody = elements.get('result-body');
    const recoveryBody = elements.get('recovery-body');
    assert.equal(resultBody.children[0].className, 'outcome no-bridge');
    assert.equal(resultBody.children[1], recoveryBody);
    assert.equal(recoveryBody.hidden, false);
    assert.ok(resultBody.children.find((item) => item.className === 'rank-heading'));
    assert.ok(find(recoveryBody, (item) => item.textContent.includes('7 days old')));
    assert.ok(resultBody.children.some((item) => item.className === 'rank-note' &&
      item.textContent.includes('7 days old')));
    const trace = find(recoveryBody, (item) => item.className === 'recovery-trace');
    assert.deepEqual(trace.children.map((item) => item.textContent.split(' — ')[0]),
      recovery.status === 'lead_found' ? ['Discover', 'Compare', 'Decision'] : ['Discover', 'Decision']);
    if (recovery.status === 'lead_found') {
      assert.ok(find(resultBody.children[0], (item) => item.textContent === 'A new book to check.'));
      assert.ok(find(recoveryBody, (item) => item.textContent.includes('Check that you can obtain this book.')));
      assert.ok(find(recoveryBody, (item) => item.tag === 'button' &&
        item.textContent === 'I can obtain it · Replace and compare'));
    } else {
      assert.ok(find(resultBody.children[0], (item) => item.textContent === 'No supported new lead.'));
      assert.ok(find(recoveryBody, (item) => item.textContent === 'No new shared lead yet'));
      assert.equal(find(recoveryBody, (item) => item.tag === 'button'), null);
    }
  }
});
