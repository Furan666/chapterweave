const BOOK_SUBTYPE = 'urn:entity:book';
const entries = {
  a: Array.from({ length: 2 }, () => ({ query: '', id: null, name: null })),
  b: Array.from({ length: 2 }, () => ({ query: '', id: null, name: null })),
  book: Array.from({ length: 6 }, () => ({ query: '', id: null, name: null })),
};

const fixtureBooks = [
  { id: 'fixture-1', name: 'The Night Orchard' },
  { id: 'fixture-2', name: 'Letters from the Observatory' },
  { id: 'fixture-3', name: 'The Atlas of Small Things' },
  { id: 'fixture-4', name: 'When Rivers Return' },
  { id: 'fixture-5', name: 'A Map of Rain' },
  { id: 'fixture-6', name: 'The Last Lantern' },
];

// Public catalog IDs resolved with Qloo on 9 October 2026. The groups are
// illustrative and the library list does not establish copy availability.
const liveExample = {
  a: [{ id: 'C7EC4CA9-1CCC-4991-B738-55F075441B3F', name: 'Arrival' }],
  b: [{ id: '057DA9D9-399B-437E-8BCA-A80E499125EF', name: 'Interstellar' }],
  book: [
    { id: '2E76F365-7C08-4DDF-8C49-CC27582788E5', name: "The Handmaid's Tale" },
    { id: '6CDF2DC4-2238-4C22-B0E3-7FDE341BF8C8', name: 'Exit West' },
    { id: 'CF50199E-9457-4A5B-A4D4-378910DE9A77', name: 'Americanah' },
    { id: '3681886D-A7AB-484B-ACE8-DEA2027B4964', name: 'The Vegetarian' },
  ],
};
const parasiteExample = {
  id: 'A499EC25-7FF6-46DE-9DA5-3E78E99B9E26', name: 'Parasite', displayName: 'Parasite (2019)',
};

const panels = [1, 2, 3].map((number) => document.getElementById(`step-${number}`));
const tabs = [...document.querySelectorAll('.step-tab')];
const message = document.getElementById('message');
const planButton = document.getElementById('plan-button');
let result = null;
let resultSource = null;
let scenario = 'bridge';
let inputRevision = 0;
let recovery = null;
let previewAcceptedLead = null;
let liveExampleLoaded = false;
let exampleBefore = null;
const rejectedPicks = new Set();
const unavailableRecoveryLeads = new Set();

async function showConnectionStatus() {
  const note = document.getElementById('connection-note');
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const body = await response.json();
    if (response.ok && body?.configured === true) {
      note.textContent = 'A Qloo credential is configured. Search a title to check the live catalog, then choose the intended match before planning.';
      return;
    }
  } catch { /* A static preview has no Worker status endpoint. */ }
  note.textContent = 'Live Qloo planning is not configured here. The synthetic example remains available without a Qloo request.';
}

function checkedAtNote(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? `Qloo data last checked ${date.toLocaleString()}. Reused results may be up to 7 days old.`
    : 'Qloo source check time is unavailable.';
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
  message.scrollIntoView({ block: 'nearest' });
}

function clearMessage() {
  message.textContent = '';
  message.hidden = true;
}

function showStep(number) {
  if (number === 3 && !result) return;
  clearMessage();
  panels.forEach((panel, index) => { panel.hidden = index + 1 !== number; });
  tabs.forEach((tab, index) => {
    if (index + 1 === number) tab.setAttribute('aria-current', 'step');
    else tab.removeAttribute('aria-current');
  });
  tabs[2].disabled = !result;
  panels[number - 1].querySelector('h2').focus({ preventScroll: true });
  document.querySelector('.planner').scrollIntoView({ block: 'start' });
}

function invalidateResult() {
  inputRevision += 1;
  result = null;
  resultSource = null;
  recovery = null;
  rejectedPicks.clear();
  unavailableRecoveryLeads.clear();
  tabs[2].disabled = true;
}

function setEntryStatus(status, text, type = '') {
  status.textContent = text;
  status.className = `entry-status${type ? ` is-${type}` : ''}`;
}

function leaveLiveExample() {
  liveExampleLoaded = false;
  exampleBefore = null;
  document.getElementById('example-note').hidden = true;
  document.getElementById('example-replan-note').hidden = true;
}

function selectExampleEntry(group, index, selection) {
  const field = entries[group][index];
  field.query = selection?.name || '';
  field.id = selection?.id || null;
  field.name = selection?.displayName || selection?.name || null;
  field.controls.input.value = field.query;
  field.controls.matches.replaceChildren();
  field.controls.matches.hidden = true;
  setEntryStatus(field.controls.status, field.name ? `Selected example: ${field.name}` : '',
    field.name ? 'selected' : '');
}

function loadLiveExample() {
  for (const group of ['a', 'b', 'book']) {
    entries[group].forEach((_, index) => selectExampleEntry(group, index, liveExample[group][index]));
  }
  invalidateResult();
  exampleBefore = null;
  liveExampleLoaded = true;
  document.getElementById('example-note').hidden = false;
  document.getElementById('example-replan-note').hidden = true;
  showStep(1);
}

function canSwitchExampleGroup() {
  return liveExampleLoaded && resultSource === 'server' && rejectedPicks.size === 0 &&
    entries.a[0].id === liveExample.a[0].id && !entries.a[1].id &&
    entries.b[0].id === liveExample.b[0].id && !entries.b[1].id &&
    entries.book.every((field, index) => field.id === (liveExample.book[index]?.id || null));
}

function canCompareExample() {
  return exampleBefore && liveExampleLoaded && resultSource === 'server' &&
    entries.a[0].id === liveExample.a[0].id && !entries.a[1].id &&
    entries.b[0].id === parasiteExample.id && !entries.b[1].id &&
    entries.book.every((field, index) => field.id === (liveExample.book[index]?.id || null));
}

function makeEntry(group, index) {
  const field = entries[group][index];
  const isBook = group === 'book';
  const name = isBook ? `Book ${index + 1}${index >= 3 ? ' · optional' : ''}` : `Anchor ${index + 1}${index ? ' · optional' : ''}`;
  const entry = node('div', 'entry');
  const label = node('label', '', name);
  const input = node('input');
  input.id = `title-${group}-${index}`;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = isBook ? 'Enter a book title' : 'Film, artist, or book';
  label.htmlFor = input.id;
  const line = node('div', 'entry-line');
  const searchButton = node('button', 'search-button', 'Search');
  searchButton.type = 'button';
  searchButton.setAttribute('aria-label', `Search catalog for ${isBook ? 'book' : `group ${group.toUpperCase()} anchor`} ${index + 1}`);
  const status = node('p', 'entry-status', '');
  status.setAttribute('aria-live', 'polite');
  const matches = node('div', 'matches');
  matches.hidden = true;
  line.append(input, searchButton);
  entry.append(label, line, status, matches);
  field.controls = { input, status, matches };

  input.addEventListener('input', () => {
    leaveLiveExample();
    field.query = input.value;
    field.id = null;
    field.name = null;
    matches.replaceChildren();
    matches.hidden = true;
    setEntryStatus(status, input.value.trim() ? 'Unresolved title' : '');
    invalidateResult();
  });

  searchButton.addEventListener('click', () => searchTitle(group, index, searchButton, status, matches));
  return entry;
}

async function searchTitle(group, index, button, status, matches) {
  const field = entries[group][index];
  const query = field.query.trim();
  if (!query) {
    setEntryStatus(status, 'Enter a title first.', 'error');
    return;
  }
  leaveLiveExample();
  field.id = null;
  field.name = null;
  invalidateResult();
  button.disabled = true;
  setEntryStatus(status, 'Searching for matches…');
  matches.hidden = true;
  matches.replaceChildren();
  try {
    const params = new URLSearchParams({ q: query });
    if (group === 'book') params.set('type', 'book');
    const response = await fetch(`/api/search?${params}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (field.query.trim() !== query) return;
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw new Error(failure?.error || `Search unavailable (${response.status}).`);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Search returned an unexpected format.');
    }
    const body = await response.json();
    if (!Array.isArray(body?.choices)) throw new Error('Search returned an unexpected format.');
    const choices = body.choices.filter((choice) =>
      choice && typeof choice.id === 'string' && choice.id &&
      typeof choice.name === 'string' && choice.name &&
      typeof choice.subtype === 'string' &&
      (group !== 'book' || choice.subtype === BOOK_SUBTYPE)
    );
    if (!choices.length) {
      setEntryStatus(status, group === 'book' ? 'No matching books found. Try a more specific title.' : 'No matches found. Try a more specific title.', 'error');
      return;
    }
    renderChoices(group, index, choices.slice(0, 10), matches, status);
    setEntryStatus(status, `Choose the intended match below. ${checkedAtNote(body.sourceCheckedAt)}`);
  } catch (error) {
    setEntryStatus(status, error.message || 'Title search is unavailable.', 'error');
  } finally {
    button.disabled = false;
  }
}

function renderChoices(group, index, choices, matches, status) {
  const field = entries[group][index];
  const set = node('fieldset');
  set.append(node('legend', '', 'Select the exact title'));
  choices.forEach((choice) => {
    const option = node('label', 'match-option');
    const radio = node('input');
    radio.type = 'radio';
    radio.name = `match-${group}-${index}`;
    radio.value = choice.id;
    const text = node('span', '', choice.name);
    const detail = [
      choice.subtype.replace(/^urn:entity:/, ''),
      typeof choice.disambiguation === 'string' ? choice.disambiguation : '',
    ].filter(Boolean).join(' · ');
    text.append(node('small', '', detail));
    option.append(radio, text);
    set.append(option);
    radio.addEventListener('change', () => {
      field.id = choice.id;
      field.name = typeof choice.disambiguation === 'string' && choice.disambiguation.trim()
        ? `${choice.name} (${choice.disambiguation.trim()})` : choice.name;
      setEntryStatus(status, `Selected: ${field.name}`, 'selected');
      invalidateResult();
    });
  });
  matches.replaceChildren(set);
  matches.hidden = false;
}

function preparedInput() {
  const a = entries.a.filter((field) => field.query.trim());
  const b = entries.b.filter((field) => field.query.trim());
  if (!a.length || !b.length) return { error: 'Enter at least one cultural anchor for each group.' };
  if ([...a, ...b].some((field) => !field.id)) return { error: 'Resolve each group anchor to an exact catalog match before planning.' };
  const books = entries.book.filter((field) => field.query.trim());
  if (books.length < 3) return { error: 'Enter at least three candidate book titles.' };
  if (books.some((field) => !field.id)) return { error: 'Resolve each entered book to an exact catalog match before planning.' };
  const shelfIds = books.map((field) => field.id);
  if (new Set(shelfIds).size !== shelfIds.length) return { error: 'Each candidate book must be a different catalog title.' };
  return { groupAIds: a.map((field) => field.id), groupBIds: b.map((field) => field.id), shelfIds };
}

function validPlan(data, shelfIds) {
  if (!data || !['bridge_found', 'no_bridge', 'incomplete_coverage'].includes(data.status) ||
      !Array.isArray(data.ranked) || data.ranked.length !== shelfIds.length || !Array.isArray(data.missing)) return false;
  const shelf = new Set(shelfIds);
  const seen = new Set();
  const top = Math.floor(shelfIds.length / 2);
  for (const row of data.ranked) {
    if (!row || !shelf.has(row.id) || seen.has(row.id) || typeof row.bridge !== 'boolean') return false;
    if (![row.aRank, row.bRank].every((rank) => rank === null || Number.isInteger(rank) && rank >= 1 && rank <= shelfIds.length)) return false;
    if (row.bridge !== (row.aRank !== null && row.bRank !== null && row.aRank <= top && row.bRank <= top)) return false;
    seen.add(row.id);
  }
  const missing = data.ranked.filter((row) => row.aRank === null || row.bRank === null).map((row) => row.id);
  if (data.missing.length !== missing.length || data.missing.some((id) => !missing.includes(id))) return false;
  if (data.status === 'incomplete_coverage' && !missing.length) return false;
  if (data.status !== 'incomplete_coverage' && missing.length) return false;
  if (data.status === 'bridge_found' && (!data.pick || !shelf.has(data.pick.id) || !data.ranked.find((row) => row.id === data.pick.id)?.bridge)) return false;
  if (data.status !== 'bridge_found' && data.pick !== null) return false;
  if (data.status === 'no_bridge' && data.ranked.some((row) => row.bridge)) return false;
  return true;
}

async function requestPlan(keepRejectedIds = [...rejectedPicks]) {
  clearMessage();
  const input = preparedInput();
  if (input.error) {
    showMessage(input.error);
    return;
  }
  document.getElementById('example-replan-note').hidden = true;
  const revision = inputRevision;
  planButton.disabled = true;
  const oldLabel = planButton.textContent;
  planButton.textContent = 'Comparing the two groups…';
  try {
    const response = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(input),
    });
    const body = await response.json();
    if (revision !== inputRevision) return;
    if (!response.ok) throw new Error(body?.error || `Planning unavailable (${response.status}).`);
    if (!validPlan(body, input.shelfIds)) throw new Error('The planner returned an unexpected result.');
    if (body.recovery != null && !validRecovery(body.recovery, input.shelfIds)) {
      throw new Error('The planner returned an unexpected recovery result.');
    }
    result = body;
    resultSource = 'server';
    recovery = body.recovery || null;
    rejectedPicks.clear();
    unavailableRecoveryLeads.clear();
    keepRejectedIds.filter((id) => input.shelfIds.includes(id)).forEach((id) => rejectedPicks.add(id));
    renderResult();
    showStep(3);
    if (body.recoveryWarning) showMessage(body.recoveryWarning);
  } catch (error) {
    if (revision === inputRevision) showMessage(error.message || 'Planning is unavailable. Please try again.');
  } finally {
    planButton.disabled = false;
    planButton.textContent = oldLabel;
  }
}

function previewBooks() {
  return previewAcceptedLead ? [...fixtureBooks.slice(0, -1), previewAcceptedLead] : fixtureBooks;
}

function fixtureResult(which) {
  const aRanks = which === 'replan' ? [2, 3, 4, 5, 6, 1] : [1, 2, 3, 4, 5, 6];
  const bRanks = which === 'replan' || which === 'no-bridge' ? [6, 5, 4, 3, 2, 1] :
    which === 'incomplete' ? [2, 5, null, 1, 3, 4] : [2, 3, 5, 1, 4, 6];
  const ranked = previewBooks().map((book, index) => ({
    id: book.id,
    aRank: aRanks[index],
    bRank: bRanks[index],
    bridge: aRanks[index] <= 3 && bRanks[index] !== null && bRanks[index] <= 3,
  }));
  ranked.sort((left, right) =>
    Math.max(left.aRank ?? Infinity, left.bRank ?? Infinity) - Math.max(right.aRank ?? Infinity, right.bRank ?? Infinity)
  );
  const missing = ranked.filter((row) => row.aRank === null || row.bRank === null).map((row) => row.id);
  const pick = which === 'bridge' || which === 'replan' ? ranked.find((row) => row.bridge) : null;
  return { status: pick ? 'bridge_found' : which === 'no-bridge' ? 'no_bridge' : 'incomplete_coverage', pick, ranked, missing };
}

function fixtureRecovery() {
  const leads = [
    { id: 'fixture-7', name: 'The Paper Voyage', aRank: 1, bRank: 2 },
    { id: 'fixture-8', name: 'The Glass Garden', aRank: 2, bRank: 1 },
  ];
  return {
    status: 'lead_found',
    lead: leads[0],
    leads,
    trace: [{ step: 'discover', candidateCount: 4, excludedCount: 6 }, { step: 'compare', candidateCount: 4 }, { step: 'decision', outcome: 'lead_found' }],
    availabilityVerified: false,
  };
}

function showPreview(which = 'bridge', acceptedLead = null) {
  const opening = panels[2].hidden;
  inputRevision += 1;
  exampleBefore = null;
  scenario = which;
  previewAcceptedLead = which === 'replan' ? acceptedLead : null;
  result = fixtureResult(which);
  resultSource = 'preview';
  recovery = which === 'no-bridge' ? fixtureRecovery() : null;
  rejectedPicks.clear();
  unavailableRecoveryLeads.clear();
  renderResult();
  if (opening) showStep(3);
}

function renderProvenance(bookName, aRank, bRank, comparison) {
  const panel = node('section', 'provenance');
  panel.append(node('h4', '', `Inputs and ranks for ${bookName}`));
  const list = node('ul', 'provenance-list');
  for (const [group, label, rank] of [['a', 'Group A', aRank], ['b', 'Group B', bRank]]) {
    const anchors = entries[group].filter((field) => field.query.trim()).map((field) => field.name);
    const item = node('li');
    item.append(node('strong', '', `${label}: `),
      node('span', '', `${anchors.join(' + ')} · Qloo rank #${rank} among ${comparison}.`));
    list.append(item);
  }
  panel.append(list, node('p', 'provenance-note',
    'Each rank is an affinity signal for the whole group-anchor set. It does not show that any one anchor caused this result.'));
  return panel;
}

function renderExampleComparison(names) {
  if (!canCompareExample()) return null;
  const section = node('section', 'example-comparison');
  section.append(node('h3', '', 'One change, two Qloo-backed plans'));
  section.append(node('p', 'comparison-note',
    'Only Group B changed from Interstellar to Parasite (2019). Group A stayed Arrival, and both plans compared the same four books. The Qloo source-check times are shown below.'));
  const grid = node('div', 'comparison-grid');
  for (const [heading, plan] of [
    ['Before · Interstellar', exampleBefore],
    ['After · Parasite (2019)', result],
  ]) {
    const card = node('div', 'comparison-card');
    const outcome = plan.status === 'bridge_found'
      ? `Shared pick: ${names.get(plan.pick.id) || plan.pick.id}`
      : plan.status === 'no_bridge' ? 'No shared top-half book' : 'Coverage incomplete';
    card.append(node('h4', '', heading), node('p', 'comparison-outcome', outcome),
      node('p', 'comparison-note', checkedAtNote(plan.sourceCheckedAt)));
    const list = node('ul', 'comparison-list');
    for (const book of liveExample.book) {
      const row = plan.ranked.find((candidate) => candidate.id === book.id);
      const item = node('li');
      const rank = (value) => value === null ? 'not returned' : `#${value}`;
      item.append(node('span', '', book.name),
        node('span', '', `A ${rank(row.aRank)} · B ${rank(row.bRank)}`));
      list.append(item);
    }
    card.append(list);
    grid.append(card);
  }
  section.append(grid, node('p', 'comparison-note',
    'Each rank is relative to its own group query. The two results show the observed effect of changing the input; they do not explain why individual ranks moved.'));
  return section;
}

function renderResult() {
  const names = new Map((resultSource === 'preview' ? previewBooks() : entries.book).map((field) => [field.id, field.name]));
  const pick = result.status === 'bridge_found'
    ? result.ranked.find((row) => row.bridge && !rejectedPicks.has(row.id))
    : null;
  const recoveryLead = recovery?.leads.find((lead) => !unavailableRecoveryLeads.has(lead.id));
  document.getElementById('reject-pick').hidden = !pick || (resultSource === 'preview' && scenario === 'replan');
  document.getElementById('find-lead').hidden = !!pick || result.status === 'incomplete_coverage' || recovery !== null;
  document.getElementById('switch-example-group').hidden = !canSwitchExampleGroup();
  const source = document.getElementById('result-source');
  source.textContent = resultSource === 'preview' ? 'Synthetic preview' : 'Qloo-backed result';
  source.className = `source-badge${resultSource === 'preview' ? ' preview' : ''}`;
  const previewControls = document.getElementById('preview-controls');
  previewControls.hidden = resultSource !== 'preview';
  previewControls.querySelectorAll('[data-scenario]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario));
  });

  const body = document.getElementById('result-body');
  const outcome = node('div', `outcome ${result.status === 'no_bridge' ? 'no-bridge' : result.status === 'incomplete_coverage' ? 'incomplete' : ''}`);
  const label = node('p', 'outcome-label');
  const title = node('h3');
  const copy = node('p', 'outcome-copy');
  const top = Math.floor(result.ranked.length / 2);
  if (pick) {
    label.textContent = rejectedPicks.size ? 'Another shared pick' : 'A shared pick';
    title.textContent = names.get(pick.id) || 'A shared title';
    copy.textContent = `This book ranks in both groups’ top ${top} on the ${result.ranked.length}-book shortlist. The positions come from separate group results; their raw affinity scores are not compared.${rejectedPicks.size ? ' Previously passed-over books are skipped without changing their ranks.' : ''}`;
  } else if (result.status === 'bridge_found') {
    label.textContent = 'No acceptable shared pick remains';
    title.textContent = recoveryLead ? 'A new book to check.' : 'Try a different shortlist.';
    copy.textContent = `Every shared top-half book on this shelf was passed over. ChapterWeave will not force a recommendation.${recoveryLead ? ' Check the unverified lead below before changing the shortlist.' : ''}`;
  } else if (result.status === 'no_bridge') {
    label.textContent = 'No bridge on this shelf';
    title.textContent = recoveryLead ? 'A new book to check.' : recovery ? 'No supported new lead.' : 'Try a different shortlist.';
    copy.textContent = `All ${result.ranked.length} books were covered, but none ranks in both groups’ top ${top}. ChapterWeave will not force a recommendation.${recoveryLead ? ' Check the unverified lead below and confirm availability before replacing a book.' : ''}`;
  } else {
    label.textContent = 'Coverage is incomplete';
    title.textContent = 'No recommendation yet.';
    const missing = result.missing.map((id) => names.get(id) || id).join(', ');
    copy.textContent = `At least one book was absent from a group result${missing ? `: ${missing}` : ''}. Revise the shortlist and run it again; missing ranks are not treated as low scores.`;
  }
  outcome.append(label, title, copy);
  if (resultSource === 'preview' && scenario === 'replan') {
    outcome.append(node('p', 'outcome-copy',
      `Synthetic replan: the facilitator confirmed ${previewAcceptedLead.name} can be obtained, replaced The Last Lantern, and compared the revised six-book shelf. No Qloo request was made.`));
  }

  const rankHeading = node('div', 'rank-heading');
  rankHeading.append(node('h3', '', 'Relative rank on this shelf'), node('span', '', `Top half = positions 1–${top} of ${result.ranked.length}`));
  const wrap = node('div', 'table-wrap');
  const table = node('table', 'rank-table');
  const thead = node('thead');
  const headerRow = node('tr');
  ['Book', 'Group A', 'Group B', 'Both top half?'].forEach((heading) => headerRow.append(node('th', '', heading)));
  thead.append(headerRow);
  const tbody = node('tbody');
  result.ranked.forEach((row) => {
    const tr = node('tr', pick?.id === row.id ? 'is-pick' : '');
    tr.append(node('td', '', `${names.get(row.id) || row.id}${rejectedPicks.has(row.id) ? ' · passed over' : ''}`));
    [row.aRank, row.bRank].forEach((rank) => tr.append(node('td', rank === null ? 'missing-rank' : '', rank === null ? 'Not returned' : `#${rank}`)));
    tr.append(node('td', '', row.aRank === null || row.bRank === null ? 'Unknown' : row.bridge ? 'Yes' : 'No'));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  const note = node('p', 'rank-note', 'Each position is relative to that group’s separate query. The shortlist is supplied by the facilitator; ChapterWeave does not verify book availability.');
  const provenance = resultSource === 'server' && pick
    ? renderProvenance(names.get(pick.id) || 'this book', pick.aRank, pick.bRank,
      `${result.ranked.length} shortlisted books`)
    : null;
  const comparison = renderExampleComparison(names);
  const recoveryBody = document.getElementById('recovery-body');
  body.replaceChildren(outcome, recoveryBody, ...(comparison ? [comparison] : []),
    ...(provenance ? [provenance] : []), rankHeading, wrap, note,
    ...(resultSource === 'server' ? [node('p', 'rank-note', checkedAtNote(result.sourceCheckedAt))] : []));
  renderRecovery();
}

function renderRecovery() {
  const body = document.getElementById('recovery-body');
  body.replaceChildren();
  body.hidden = !recovery;
  if (!recovery) return;
  const illustrative = resultSource === 'preview';
  const lead = recovery.leads.find((candidate) => !unavailableRecoveryLeads.has(candidate.id));
  const exhausted = recovery.status === 'lead_found' && !lead;
  const card = node('section', 'recovery-card');
  const kicker = node('p', 'recovery-kicker', 'Beyond the shortlist');
  const title = node('h3', '', lead ? lead.name : exhausted ? 'All new leads were unavailable' : 'No new shared lead yet');
  title.tabIndex = -1;
  const copy = node('p', '', lead
    ? `${illustrative ? 'In this synthetic example, the new book ranks' : 'Qloo ranks this new book'} #${lead.aRank} for Group A and #${lead.bRank} for Group B among the new candidates. It is an inventory lead, not a confirmed available book.`
    : exhausted
      ? 'Every shared lead from this search was passed over because the books were unavailable. Revise the shortlist or group anchors before trying again.'
    : recovery.status === 'insufficient_candidates'
      ? 'Qloo found only one new book. Ranking it first for both groups would prove nothing, so ChapterWeave will not recommend it. Try different anchors.'
    : recovery.status === 'incomplete_coverage'
      ? 'Qloo did not cover every new candidate for both groups. ChapterWeave will not guess at the missing ranks.'
      : 'The bounded search found no new book that both groups rank in the top half. Try a different shortlist or anchors.');
  card.append(kicker, title, copy);
  if (lead && resultSource === 'server') {
    card.append(renderProvenance(lead.name, lead.aRank, lead.bRank, 'the newly discovered books'));
  }
  const trace = node('ol', 'recovery-trace');
  const steps = illustrative ? {
    discover: `Discover — Illustrates a search beyond the current ${result.ranked.length} books.`,
    compare: 'Compare — Illustrates separate comparisons for both groups.',
    decision: 'Decision — Illustrates keeping only a shared top-half lead.',
  } : {
    discover: `Discover — Searched Qloo Book insights beyond the current ${result.ranked.length} books.`,
    compare: 'Compare — Ranked the new candidates separately for both groups.',
    decision: recovery.status === 'lead_found' ? 'Decision — Kept only shared top-half leads.' : 'Decision — Abstained when the evidence did not support a lead.',
  };
  recovery.trace.forEach((step) => trace.append(node('li', '', steps[step.step])));
  card.append(trace);
  if (!illustrative) card.append(node('p', 'recovery-note', checkedAtNote(recovery.sourceCheckedAt)));
  if (lead && resultSource === 'server') {
    const replaceId = rejectedPicks.values().next().value || result.ranked.at(-1)?.id;
    const replaceName = entries.book.find((field) => field.id === replaceId)?.name;
    card.append(node('p', 'recovery-note', `Check that you can obtain this book. If confirmed, it can replace ${replaceName || 'one shortlisted book'}; ChapterWeave will compare the revised shelf again.`));
    const confirm = node('button', 'button button-dark', 'I can obtain it · Replace and compare');
    confirm.type = 'button';
    confirm.addEventListener('click', acceptRecoveryLead);
    card.append(confirm);
  } else if (lead) {
    card.append(node('p', 'recovery-note', 'Synthetic preview only. Simulate confirming availability to see the revised shelf compared without a Qloo request.'));
    const confirm = node('button', 'button button-dark', 'Simulate obtaining it · Compare revised shelf');
    confirm.type = 'button';
    confirm.addEventListener('click', () => showPreview('replan', lead));
    card.append(confirm);
  }
  if (lead) {
    const next = node('button', 'text-button', 'I cannot obtain it · Show the next lead');
    next.type = 'button';
    next.addEventListener('click', () => {
      unavailableRecoveryLeads.add(lead.id);
      renderRecovery();
      body.querySelector('h3')?.focus();
    });
    card.append(next);
  }
  body.append(card);
}

function validRecovery(data, shelfIds) {
  if (!data || !['lead_found', 'no_candidates', 'insufficient_candidates', 'no_bridge', 'incomplete_coverage'].includes(data.status) ||
      data.availabilityVerified !== false || !Array.isArray(data.trace) || data.trace.length < 2 || data.trace.length > 3 ||
      data.trace.some((step) => !['discover', 'compare', 'decision'].includes(step?.step))) return false;
  if (!Array.isArray(data.leads) || data.leads.length > 6) return false;
  const ids = new Set();
  for (const lead of data.leads) {
    if (typeof lead?.id !== 'string' || !lead.id || shelfIds.includes(lead.id) || ids.has(lead.id) ||
        typeof lead.name !== 'string' || !lead.name.trim() ||
        !Number.isInteger(lead.aRank) || lead.aRank < 1 || lead.aRank > 6 ||
        !Number.isInteger(lead.bRank) || lead.bRank < 1 || lead.bRank > 6) return false;
    ids.add(lead.id);
  }
  if (data.status !== 'lead_found') return data.lead === null && data.leads.length === 0;
  const first = data.leads[0];
  return first && data.lead?.id === first.id && data.lead?.name === first.name &&
    data.lead?.aRank === first.aRank && data.lead?.bRank === first.bRank;
}

async function requestRecovery() {
  if (!result || result.status === 'incomplete_coverage' ||
      result.ranked.some((row) => row.bridge && !rejectedPicks.has(row.id))) return;
  if (resultSource === 'preview') {
    recovery = fixtureRecovery();
    renderResult();
    return;
  }
  const input = preparedInput();
  if (input.error) return showMessage(input.error);
  clearMessage();
  const revision = inputRevision;
  const button = document.getElementById('find-lead');
  button.disabled = true;
  const oldLabel = button.textContent;
  button.textContent = 'Checking beyond this shelf…';
  try {
    const response = await fetch('/api/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ ...input, rejectedIds: [...rejectedPicks] }),
    });
    const body = await response.json();
    if (revision !== inputRevision) return;
    if (!response.ok) throw new Error(body?.error || `Recovery unavailable (${response.status}).`);
    if (!validRecovery(body, input.shelfIds)) throw new Error('Recovery returned an unexpected result.');
    recovery = body;
    unavailableRecoveryLeads.clear();
    renderResult();
  } catch (error) {
    if (revision === inputRevision) showMessage(error.message || 'Recovery is unavailable. Please try again.');
  } finally {
    button.disabled = false;
    button.textContent = oldLabel;
  }
}

async function acceptRecoveryLead() {
  if (resultSource !== 'server' || recovery?.status !== 'lead_found') return;
  const lead = recovery.leads.find((candidate) => !unavailableRecoveryLeads.has(candidate.id));
  if (!lead) return;
  const replaceId = rejectedPicks.values().next().value || result.ranked.at(-1)?.id;
  const keepRejectedIds = [...rejectedPicks].filter((id) => id !== replaceId);
  const index = entries.book.findIndex((field) => field.id === replaceId);
  if (index < 0) return showMessage('The shortlist changed. Please revise it before planning.');
  const field = entries.book[index];
  field.query = lead.name;
  field.id = lead.id;
  field.name = lead.name;
  const entry = document.getElementById(`title-book-${index}`).closest('.entry');
  entry.querySelector('input').value = field.query;
  entry.querySelector('.matches').replaceChildren();
  entry.querySelector('.matches').hidden = true;
  setEntryStatus(entry.querySelector('.entry-status'), `Selected: ${field.name}`, 'selected');
  exampleBefore = null;
  invalidateResult();
  keepRejectedIds.forEach((id) => rejectedPicks.add(id));
  showStep(2);
  await requestPlan();
}

entries.a.forEach((_, index) => document.getElementById('group-a-fields').append(makeEntry('a', index)));
entries.b.forEach((_, index) => document.getElementById('group-b-fields').append(makeEntry('b', index)));
entries.book.forEach((_, index) => document.getElementById('book-fields').append(makeEntry('book', index)));

tabs.forEach((tab) => tab.addEventListener('click', () => showStep(Number(tab.dataset.step))));
document.getElementById('to-shelf').addEventListener('click', () => {
  if (!entries.a.some((field) => field.query.trim()) || !entries.b.some((field) => field.query.trim())) {
    showMessage('Enter at least one cultural anchor for each group.');
    return;
  }
  showStep(2);
});
document.getElementById('back-to-groups').addEventListener('click', () => showStep(1));
document.getElementById('plan-button').addEventListener('click', () => requestPlan());
document.getElementById('start-button').addEventListener('click', () => showStep(1));
document.getElementById('load-live-example').addEventListener('click', loadLiveExample);
document.getElementById('preview-button').addEventListener('click', () => showPreview());
document.getElementById('switch-example-group').addEventListener('click', () => {
  if (!canSwitchExampleGroup()) return;
  const before = result;
  selectExampleEntry('b', 0, parasiteExample);
  invalidateResult();
  exampleBefore = before;
  document.getElementById('switch-example-group').hidden = true;
  document.getElementById('example-replan-note').hidden = false;
  showStep(2);
});
document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', () => showPreview(button.dataset.scenario)));
document.getElementById('reject-pick').addEventListener('click', () => {
  const pick = result?.ranked.find((row) => row.bridge && !rejectedPicks.has(row.id));
  if (!pick) return;
  rejectedPicks.add(pick.id);
  recovery = null;
  renderResult();
  if (!result.ranked.some((row) => row.bridge && !rejectedPicks.has(row.id))) requestRecovery();
});
document.getElementById('find-lead').addEventListener('click', requestRecovery);
document.getElementById('revise-shelf').addEventListener('click', () => showStep(2));
document.getElementById('revise-groups').addEventListener('click', () => showStep(1));
showConnectionStatus();
