const BOOK_TYPE = 'urn:entity:book';

function uniqueIds(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} must be a nonempty array of Qloo entity IDs`);
  }
  const ids = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.includes(',')) {
      throw new TypeError(`${label} contains an invalid Qloo entity ID`);
    }
    return value.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} contains a duplicate Qloo entity ID`);
  }
  return ids;
}

export function bookInsightsQuery(seedIds, shelfIds) {
  const seeds = uniqueIds(seedIds, 'seedIds');
  const shelf = uniqueIds(shelfIds, 'shelfIds');
  if (shelf.length > 50) {
    throw new RangeError('shelfIds exceeds the documented 50-result limit');
  }
  return new URLSearchParams({
    'filter.type': BOOK_TYPE,
    'signal.interests.entities': seeds.join(','),
    'filter.results.entities': shelf.join(','),
    take: String(shelf.length),
  });
}

export function bookDiscoveryQuery(groupAIds, groupBIds, shelfIds) {
  const groupA = uniqueIds(groupAIds, 'groupAIds');
  const groupB = uniqueIds(groupBIds, 'groupBIds');
  const shelf = uniqueIds(shelfIds, 'shelfIds');
  if (shelf.length > 50) {
    throw new RangeError('shelfIds exceeds the documented 50-result limit');
  }
  return new URLSearchParams({
    'filter.type': BOOK_TYPE,
    'signal.interests.entities': [...new Set([...groupA, ...groupB])].join(','),
    'filter.exclude.entities': shelf.join(','),
    take: '6',
  });
}

function rankMap(entities, shelf, label) {
  if (!Array.isArray(entities)) {
    throw new TypeError(`${label} must be an array of Qloo result entities`);
  }
  const allowed = new Set(shelf);
  const ranks = new Map();
  for (const entity of entities) {
    const id = entity?.entity_id;
    if (typeof id !== 'string' || !allowed.has(id) || entity.subtype !== BOOK_TYPE) {
      throw new Error(`${label} returned an entity outside the requested shelf`);
    }
    if (ranks.has(id)) {
      throw new Error(`${label} returned a duplicate entity`);
    }
    ranks.set(id, ranks.size + 1);
  }
  return ranks;
}

// Qloo's affinity scores are normalized per query. Compare positions within
// each group's own result list; never compare the two raw scores directly.
export function rankShelf(shelfIds, groupAEntities, groupBEntities) {
  const shelf = uniqueIds(shelfIds, 'shelfIds');
  const aRanks = rankMap(groupAEntities, shelf, 'group A');
  const bRanks = rankMap(groupBEntities, shelf, 'group B');
  // Round down for odd shelves so a shared place is not guaranteed by set overlap.
  const topHalf = Math.floor(shelf.length / 2);
  const rows = shelf.map((id) => {
    const aRank = aRanks.get(id) ?? null;
    const bRank = bRanks.get(id) ?? null;
    return {
      id,
      aRank,
      bRank,
      bridge: aRank !== null && bRank !== null && aRank <= topHalf && bRank <= topHalf,
    };
  });
  rows.sort((left, right) => {
    const leftWorst = Math.max(left.aRank ?? Infinity, left.bRank ?? Infinity);
    const rightWorst = Math.max(right.aRank ?? Infinity, right.bRank ?? Infinity);
    return leftWorst - rightWorst ||
      (left.aRank ?? Infinity) + (left.bRank ?? Infinity) -
        (right.aRank ?? Infinity) - (right.bRank ?? Infinity) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  const missing = rows.filter((row) => row.aRank === null || row.bRank === null).map((row) => row.id);
  const pick = missing.length ? null : rows.find((row) => row.bridge) ?? null;
  return {
    status: missing.length ? 'incomplete_coverage' : pick ? 'bridge_found' : 'no_bridge',
    pick,
    ranked: rows,
    missing,
  };
}
