/**
 * GF's-eye-view wire tests for gf_list_entries.
 *
 * These go one level deeper than entries-query.test.js: instead of inspecting
 * flattenParams() pairs, they build the FULL serialized query string exactly
 * as the production axios paramsSerializer does (gravity-forms-client.js:38-42),
 * then reconstruct it the way PHP's $_GET / WP_REST_Request would — proving GF
 * receives `paging`/`sorting` as nested ARRAYS and `search` as a JSON STRING,
 * which is precisely what parse_entry_search_params (GF
 * class-gf-rest-controller.php) reads. A JSON-stringified paging/sorting would
 * reconstruct as a scalar string and GF's isset() probes would miss it.
 */

import test from 'node:test';
import assert from 'node:assert';
import { buildEntriesQuery, GravityFormsClient } from '../src/gravity-forms-client.js';
import { flattenParams, rfc3986Encode } from '../src/config/auth.js';
import { ValidationFactory } from '../src/config/validation.js';

// Mirror of the production paramsSerializer (gravity-forms-client.js:38-42).
// Kept in lockstep on purpose: if that serializer changes, these tests should
// be updated alongside it.
function serialize(params) {
  return flattenParams(params)
    .map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`)
    .join('&');
}

// Reconstruct a bracketed query string into the nested structure PHP's
// parse_str()/WP_REST_Request param parsing would produce. Values stay strings
// (as $_GET delivers them; GF intval()s numbers itself).
function phpParse(queryString) {
  const out = {};
  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const val = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
    const name = key.replace(/\[.*$/, '');
    const segs = [...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    if (segs.length === 0) { out[name] = val; continue; }
    let node = (out[name] = out[name] || {});
    segs.forEach((seg, i) => {
      const k = seg === '' ? String(Object.keys(node).length) : seg;
      if (i === segs.length - 1) node[k] = val;
      else node = (node[k] = node[k] || {});
    });
  }
  return out;
}

const phpView = (validated) => phpParse(serialize(buildEntriesQuery(validated)));

// --- Production serializer mirrors the real client ---
test('serialize() matches the real client paramsSerializer byte-for-byte', () => {
  const env = { GRAVITY_FORMS_BASE_URL: 'https://example.test', GRAVITY_FORMS_CONSUMER_KEY: 'u', GRAVITY_FORMS_CONSUMER_SECRET: 'p' };
  const client = new GravityFormsClient(env);
  const real = client.httpClient.defaults.paramsSerializer;
  const serializeFn = typeof real === 'function' ? real : real.serialize;
  const params = buildEntriesQuery({ paging: { page_size: 25, current_page: 2 }, form_ids: [129] });
  assert.equal(serialize(params), serializeFn(params), 'test serializer must equal the production one');
});

// --- GF reconstructs paging/sorting as ARRAYS, search as a STRING ---
test("GF's view: paging reconstructs as a nested array (page_size + current_page)", () => {
  const view = phpView({ paging: { page_size: 50, current_page: 3 } });
  assert.deepEqual(view.paging, { page_size: '50', current_page: '3' });
  assert.equal(typeof view.paging, 'object', 'GF must see an array, not a JSON scalar');
});

test("GF's view: sorting reconstructs as a nested array (key/direction/is_numeric)", () => {
  const view = phpView({ sorting: { key: 'date_created', direction: 'ASC', is_numeric: true } });
  assert.deepEqual(view.sorting, { key: 'date_created', direction: 'ASC', is_numeric: 'true' });
});

test("GF's view: search reconstructs as a JSON STRING that json_decodes to criteria", () => {
  const criteria = { field_filters: [{ key: '1', value: 'John', operator: 'contains' }], mode: 'all' };
  const view = phpView({ search: criteria });
  assert.equal(typeof view.search, 'string', 'GF json_decodes a string search param');
  // GF reads the search mode from $field_filters['mode'] (class-gf-query.php:301),
  // so the builder moves search.mode INTO field_filters. The decoded shape is
  // therefore { field_filters: { 0: <filter>, mode: 'all' } } — the PHP array GF
  // iterates after reading + unset('mode'), NOT the original top-level-mode input.
  const decoded = JSON.parse(view.search);
  assert.equal(decoded.field_filters.mode, 'all');
  assert.ok(!('mode' in decoded), 'mode must not stay at the search top level');
  assert.deepEqual(decoded.field_filters['0'], { key: '1', value: 'John', operator: 'contains' });
  assert.ok(view['search[field_filters][0][key]'] === undefined, 'search must not bracket-explode');
});

test("GF's view: form_ids reconstructs as an indexed array", () => {
  const view = phpView({ form_ids: [11, 22, 33] });
  assert.deepEqual(view.form_ids, { 0: '11', 1: '22', 2: '33' });
});

// --- Encoding round-trip: GF urldecodes the search param before json_decode ---
test('search JSON survives encode → urldecode round-trip with hostile characters', () => {
  const criteria = {
    field_filters: [
      { key: '3', value: 'a&b=c d', operator: 'is' },        // & = and space
      { key: '4', value: 'quote " and \\ slash', operator: 'is' }, // quote + backslash
      { key: '5', value: 'café ünïcode 日本語', operator: 'contains' }, // non-ASCII
      { key: '6', value: "tick ' plus + percent %", operator: 'is' },
    ],
    mode: 'any',
  };
  const wireValue = serialize(buildEntriesQuery({ search: criteria }))
    .split('&')
    .map((p) => p.split('='))
    .find(([k]) => k === 'search')[1];
  // PHP urldecode() reverses percent-encoding; the decoded value must round-trip
  // to the criteria the BUILDER produces — search.mode is moved into
  // field_filters (GF reads $field_filters[mode]), so the expected shape carries
  // mode on field_filters, not at the search top level. This test pins the
  // hostile-character encoding round-trip, independent of mode placement.
  const expected = {
    field_filters: Object.assign({}, criteria.field_filters, { mode: criteria.mode }),
  };
  const decoded = decodeURIComponent(wireValue);
  assert.equal(decoded, JSON.stringify(expected));
  assert.deepEqual(JSON.parse(decoded), expected);
});

test('brackets are single-encoded on the wire (no %255B double-encoding)', () => {
  const qs = serialize(buildEntriesQuery({ paging: { page_size: 10 } }));
  assert.ok(qs.includes('paging%5Bpage_size%5D=10'), 'bracket key must be single-encoded');
  assert.ok(!qs.includes('%255B'), 'must not double-encode brackets');
});

// --- Pagination actually varies (the core "stuck on first 10" failure) ---
test('paging varies across pages: page 2 and page 3 differ on the wire', () => {
  const p2 = phpView({ paging: { page_size: 25, current_page: 2 } }).paging;
  const p3 = phpView({ paging: { page_size: 25, current_page: 3 } }).paging;
  assert.equal(p2.current_page, '2');
  assert.equal(p3.current_page, '3');
  assert.notEqual(p2.current_page, p3.current_page, 'consecutive pages must produce different wire');
  assert.equal(p2.page_size, p3.page_size, 'page_size stays stable across pages');
});

test('page_size is honoured for a range of sizes (1, 10, 100, 200)', () => {
  for (const size of [1, 10, 100, 200]) {
    assert.equal(phpView({ paging: { page_size: size } }).paging.page_size, String(size));
  }
});

// --- The exact reporter scenarios ---
test('reporter repro: form_ids[129] + page 2 size 25 serialize so GF can page', () => {
  const view = phpView({ form_ids: [129], paging: { page_size: 25, current_page: 2 } });
  assert.equal(view.form_ids['0'], '129');
  assert.equal(view.paging.page_size, '25');
  assert.equal(view.paging.current_page, '2');
});

test('reporter repro: exclude ids become a GF id "not in" field_filter', () => {
  const view = phpView({ exclude: [96656, 96653] });
  const ff = JSON.parse(view.search).field_filters.find((f) => f.key === 'id');
  assert.equal(ff.operator, 'not in');
  assert.deepEqual(ff.value, [96656, 96653]);
});

// --- Whole real path: validator → builder → wire ---
test('full path: ValidationFactory → buildEntriesQuery → wire is GF-correct', () => {
  const validated = ValidationFactory.validateToolInput('gf_list_entries', {
    form_ids: [129],
    paging: { page_size: 25, current_page: 2 },
    sorting: { key: 'date_created', direction: 'desc' },
    include: [1, 2, 3],
    status: 'active',
  });
  const view = phpView(validated);
  assert.equal(view.paging.page_size, '25');
  assert.equal(view.paging.current_page, '2');
  assert.equal(view.sorting.key, 'date_created');
  assert.equal(view.sorting.direction, 'desc');
  assert.equal(view.form_ids['0'], '129');
  assert.deepEqual(view.include, { 0: '1', 1: '2', 2: '3' }); // native include param
  assert.equal(JSON.parse(view.search).status, 'active');
  assert.ok(view.status === undefined, 'no GF-unknown top-level params leak');
});

// --- Querying MULTIPLE forms at once (GF accepts form_ids as an array) ---

test('multiple forms: form_ids serialize to a full indexed array GF reads', () => {
  const view = phpView({ form_ids: [101, 202, 303, 404] });
  assert.deepEqual(view.form_ids, { 0: '101', 1: '202', 2: '303', 3: '404' });
});

test('multiple forms: order is preserved on the wire', () => {
  assert.deepEqual(phpView({ form_ids: [3, 1, 2] }).form_ids, { 0: '3', 1: '1', 2: '2' });
});

test('multiple forms: a large form_ids list keeps every index', () => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const view = phpView({ form_ids: ids });
  assert.equal(Object.keys(view.form_ids).length, 12);
  assert.equal(view.form_ids['0'], '1');
  assert.equal(view.form_ids['11'], '12');
});

test('multiple forms + paging + sorting + exclude all serialize together (GF view)', () => {
  const view = phpView({
    form_ids: [1, 2, 3],
    paging: { page_size: 50, current_page: 2 },
    sorting: { key: 'date_created', direction: 'DESC' },
    exclude: [999],
  });
  assert.equal(Object.keys(view.form_ids).length, 3);
  assert.equal(view.paging.current_page, '2');
  assert.equal(view.sorting.key, 'date_created');
  assert.ok(JSON.parse(view.search).field_filters.some((f) => f.key === 'id' && f.operator === 'not in'));
});

test('multiple forms via the real validator path', () => {
  const validated = ValidationFactory.validateToolInput('gf_list_entries', {
    form_ids: [5, 9, 13],
    paging: { page_size: 100, current_page: 3 },
  });
  const view = phpView(validated);
  assert.deepEqual(Object.values(view.form_ids), ['5', '9', '13']);
  assert.equal(view.paging.page_size, '100');
});

// --- ALL THE THINGS: every subset of the 7 params obeys the GF wire contract ---

test('combinatorial sweep: all 128 param subsets honour the GF contract', () => {
  const PARAMS = {
    form_ids: [1, 2, 3],
    paging: { page_size: 25, current_page: 2 },
    sorting: { key: 'date_created', direction: 'DESC', is_numeric: true },
    search: { field_filters: [{ key: '1', value: 'q', operator: 'is' }], mode: 'all' },
    status: 'active',
    include: [10, 11],
    exclude: [20],
  };
  const KEYS = Object.keys(PARAMS);
  const total = 1 << KEYS.length;

  for (let mask = 0; mask < total; mask++) {
    const input = {};
    KEYS.forEach((k, i) => { if (mask & (1 << i)) input[k] = PARAMS[k]; });
    const label = JSON.stringify(Object.keys(input));
    const raw = serialize(buildEntriesQuery(input));
    const view = phpParse(raw);

    // GF-unknown top-level params must NEVER leak onto the wire. (include IS a
    // native GF /entries param, so it is allowed top-level.)
    for (const bad of ['status', 'exclude']) {
      assert.ok(view[bad] === undefined, `${bad} must never be a top-level param — ${label}`);
    }
    // paging/sorting must ALWAYS be bracketed arrays, never a bare scalar value.
    assert.ok(!/(^|&)paging=/.test(raw), `paging must be bracketed, never a JSON scalar — ${label}`);
    assert.ok(!/(^|&)sorting=/.test(raw), `sorting must be bracketed, never a JSON scalar — ${label}`);

    if ('paging' in input) {
      assert.equal(typeof view.paging, 'object', `paging must reconstruct as an array — ${label}`);
      assert.equal(view.paging.page_size, '25');
      assert.equal(view.paging.current_page, '2');
    }
    if ('sorting' in input) {
      assert.equal(typeof view.sorting, 'object', `sorting must reconstruct as an array — ${label}`);
      assert.equal(view.sorting.key, 'date_created');
    }
    if ('form_ids' in input) {
      assert.deepEqual(Object.values(view.form_ids), ['1', '2', '3'], `form_ids must survive intact — ${label}`);
    }
    if ('include' in input) {
      assert.deepEqual(Object.values(view.include), ['10', '11'], `include must be the native param — ${label}`);
    } else {
      assert.ok(view.include === undefined, `no include param when not requested — ${label}`);
    }

    const wantsSearch = ['search', 'status', 'exclude'].some((k) => k in input);
    if (wantsSearch) {
      assert.equal(typeof view.search, 'string', `search must be a JSON string — ${label}`);
      const decoded = JSON.parse(view.search); // throws if the JSON is malformed
      if ('status' in input) assert.equal(decoded.status, 'active', `status must fold into search — ${label}`);
      if ('exclude' in input) {
        // field_filters is an array when no mode is set, an object ({0:…,mode:…})
        // when the search subset carries a mode — Object.values handles both.
        const filters = Object.values(decoded.field_filters || {}).filter((f) => f && typeof f === 'object');
        assert.ok(filters.some((f) => f.key === 'id' && f.operator === 'not in'), `exclude → id not in — ${label}`);
        if ('search' in input) assert.equal(decoded.field_filters.mode, 'all', `mode rides on field_filters — ${label}`);
      }
    } else {
      assert.ok(view.search === undefined, `no search param when none requested — ${label}`);
    }
  }
});
