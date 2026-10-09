import assert from 'node:assert/strict';
import test from 'node:test';
import { bookDiscoveryQuery, bookInsightsQuery, rankShelf } from './planner.mjs';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const entities = (order) => order.map((entity_id) => ({ entity_id, subtype: 'urn:entity:book' }));

test('builds a shelf-limited Qloo book query without comparing scores', () => {
  const query = bookInsightsQuery(['film-1', 'artist-2'], ids);
  assert.equal(query.get('filter.type'), 'urn:entity:book');
  assert.equal(query.get('signal.interests.entities'), 'film-1,artist-2');
  assert.equal(query.get('filter.results.entities'), ids.join(','));
  assert.equal(query.has('sort_by'), false);
  assert.equal(query.get('take'), '6');
});

test('builds a bounded discovery query from both groups and excludes the existing shelf', () => {
  const query = bookDiscoveryQuery(['film-1', 'shared'], ['shared', 'artist-2'], ids);
  assert.equal(query.get('filter.type'), 'urn:entity:book');
  assert.equal(query.get('signal.interests.entities'), 'film-1,shared,artist-2');
  assert.equal(query.get('filter.exclude.entities'), ids.join(','));
  assert.equal(query.has('filter.results.entities'), false);
  assert.equal(query.get('take'), '6');
});

test('prefers a book that both groups place in the top half', () => {
  const result = rankShelf(ids, entities(['a', 'b', 'c', 'd', 'e', 'f']), entities(['f', 'b', 'c', 'd', 'e', 'a']));
  assert.equal(result.status, 'bridge_found');
  assert.deepEqual(result.pick, { id: 'b', aRank: 2, bRank: 2, bridge: true });
});

test('keeps the same pick when shelf input order changes but Qloo rankings do not', () => {
  const groupA = entities(['a', 'b', 'c', 'd', 'e', 'f']);
  const groupB = entities(['b', 'a', 'c', 'd', 'e', 'f']);
  const first = rankShelf(ids, groupA, groupB);
  const reversed = rankShelf([...ids].reverse(), groupA, groupB);
  assert.equal(first.pick.id, 'a');
  assert.equal(reversed.pick.id, first.pick.id);
  assert.deepEqual(reversed.ranked, first.ranked);
});

test('abstains when there is no top-half bridge', () => {
  const result = rankShelf(ids, entities(['a', 'b', 'c', 'd', 'e', 'f']), entities(['f', 'e', 'd', 'c', 'b', 'a']));
  assert.equal(result.status, 'no_bridge');
  assert.equal(result.pick, null);
});

test('a three-book shelf requires the same first-ranked book instead of forcing a shared top two', () => {
  const shelf = ['a', 'b', 'c'];
  const differentFavorites = rankShelf(shelf, entities(shelf), entities(['b', 'a', 'c']));
  assert.equal(differentFavorites.status, 'no_bridge');
  assert.equal(differentFavorites.pick, null);
  const sameFavorite = rankShelf(shelf, entities(shelf), entities(['a', 'c', 'b']));
  assert.deepEqual(sameFavorite.pick, { id: 'a', aRank: 1, bRank: 1, bridge: true });
});

test('does not promote a missing Qloo result as a match', () => {
  const result = rankShelf(ids, entities(['a', 'b']), entities(['a', 'c']));
  assert.equal(result.status, 'incomplete_coverage');
  assert.equal(result.pick, null);
  assert.equal(result.missing.length, 5);
});

test('fails if a requested result filter appears to have been ignored', () => {
  assert.throws(() => rankShelf(ids, entities(['a', 'outside']), entities(['a'])), /outside the requested shelf/);
  assert.throws(() => rankShelf(ids, [{ entity_id: 'a', subtype: 'urn:entity:movie' }], entities(['a'])), /outside the requested shelf/);
});

test('rejects duplicate entities and seed IDs', () => {
  assert.throws(() => rankShelf(ids, entities(['a', 'a']), entities(['a'])), /duplicate entity/);
  assert.throws(() => bookInsightsQuery(['same', 'same'], ids), /duplicate Qloo entity ID/);
});
