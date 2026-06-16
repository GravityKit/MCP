/**
 * Wire-format tests for buildEntriesQuery() — the gf_list_entries query builder.
 *
 * The contract these tests pin comes DIRECTLY from Gravity Forms source
 * (includes/webapi/v2/includes/controllers/class-gf-rest-controller.php
 * ::parse_entry_search_params) and GF's own REST tests
 * (tests/unit-tests/rest-api/test-entries.php):
 *
 *   - `sorting` is read as an ARRAY: sorting[key], sorting[direction],
 *     sorting[is_numeric]. A JSON string makes isset($sorting_param['key'])
 *     false → GF silently defaults to key=id, direction=DESC (newest-first).
 *   - `paging` is read as an ARRAY: paging[page_size], paging[current_page],
 *     paging[offset]. A JSON string → defaults page_size=10, offset=0
 *     (stuck on the first 10 entries — the customer-blocking symptom).
 *   - `search` is read as a JSON STRING (json_decode on a non-array).
 *   - `form_ids` is read as an ARRAY (form_ids[0]=…).
 *   - There is NO top-level `status` param — only search.status (default
 *     'active'). NO include/exclude params — id-based selection is done via
 *     field_filters {key:'id', operator:'in'|'not in'} (GFAPI::get_entries,
 *     verified against GF's search-criteria tests + the GFAPI docblock).
 *
 * We assert the REAL wire output by running the builder result through the
 * production paramsSerializer (flattenParams) — the exact bracket-pair
 * encoding GF reconstructs from $_GET. Asserting the params OBJECT alone
 * (as the old entries.test.js paging test did) hides the bug, because a
 * JSON string `{"page_size":50}` still "contains" the substring page_size.
 */

import test from 'node:test';
import assert from 'node:assert';
import { buildEntriesQuery } from '../src/gravity-forms-client.js';
import { flattenParams } from '../src/config/auth.js';
import { ValidationFactory } from '../src/config/validation.js';

// Serialize like the live axios paramsSerializer, then expose wire pairs as a
// Map of `encoded-shape key` → value (no URL-encoding so assertions stay
// readable; flattenParams produces the bracket structure, encoding is a
// separate concern already covered elsewhere).
function wire(query) {
  return new Map(flattenParams(query));
}

test('paging → bracketed wire params GF reads (not a JSON blob)', () => {
  const w = wire(buildEntriesQuery({ paging: { page_size: 50, current_page: 2 } }));
  assert.equal(w.get('paging[page_size]'), '50');
  assert.equal(w.get('paging[current_page]'), '2');
  assert.ok(!w.has('paging'), 'paging must not collapse to a single JSON-encoded value');
});

test('sorting → bracketed wire params GF reads (not a JSON blob)', () => {
  const w = wire(buildEntriesQuery({ sorting: { key: 'date_created', direction: 'ASC', is_numeric: true } }));
  assert.equal(w.get('sorting[key]'), 'date_created');
  assert.equal(w.get('sorting[direction]'), 'ASC');
  assert.equal(w.get('sorting[is_numeric]'), 'true');
  assert.ok(!w.has('sorting'), 'sorting must not collapse to a single JSON-encoded value');
});

test('search → a single JSON-encoded `search` param (GF json_decodes it)', () => {
  const search = { field_filters: [{ key: '1', value: 'John', operator: 'contains' }], mode: 'all' };
  const w = wire(buildEntriesQuery({ search }));
  const raw = w.get('search');
  assert.ok(typeof raw === 'string' && raw.trim().startsWith('{'), 'search must be a JSON string');
  assert.equal(JSON.parse(raw).field_filters[0].key, '1');
  assert.ok(!w.has('search[field_filters][0][key]'), 'search must not be bracket-exploded');
});

test('form_ids → bracketed array (form_ids[0]=…)', () => {
  const w = wire(buildEntriesQuery({ form_ids: [5, 9] }));
  assert.equal(w.get('form_ids[0]'), '5');
  assert.equal(w.get('form_ids[1]'), '9');
});

test('status → folded into search.status (GF has no top-level status param)', () => {
  const w = wire(buildEntriesQuery({ status: 'spam' }));
  assert.ok(!w.has('status'), 'top-level status must be dropped — GF ignores it');
  assert.equal(JSON.parse(w.get('search')).status, 'spam');
});

test('include → native GF include param (fetch-by-id fast path), not a search filter', () => {
  const w = wire(buildEntriesQuery({ include: [101, 102] }));
  assert.equal(w.get('include[0]'), '101');
  assert.equal(w.get('include[1]'), '102');
  assert.ok(!w.has('search'), 'include uses the native fast-path, not search field_filters');
});

test('exclude → search.field_filters {key:id, operator:not in}', () => {
  const w = wire(buildEntriesQuery({ exclude: [7] }));
  assert.ok(!w.has('exclude') && !w.has('exclude[0]'), 'exclude is not a GF entries param');
  const idFilter = JSON.parse(w.get('search')).field_filters.find((f) => f.key === 'id' && f.operator === 'not in');
  assert.deepEqual(idFilter.value, [7]);
});

test('exclude merges into existing search.field_filters (append, do not clobber)', () => {
  const search = { field_filters: [{ key: '1', value: 'x', operator: 'is' }], mode: 'all' };
  const ff = JSON.parse(wire(buildEntriesQuery({ search, exclude: [5] })).get('search')).field_filters;
  // mode present → field_filters is an object ({"0":…,"1":…,"mode":"all"}).
  // Iterate the actual filter entries (objects), excluding the mode string.
  const filters = Object.values(ff).filter((f) => f && typeof f === 'object');
  assert.equal(ff.mode, 'all', 'mode preserved on field_filters');
  assert.equal(filters.length, 2);
  assert.ok(filters.some((f) => f.key === '1'), 'original filter preserved');
  assert.ok(filters.some((f) => f.key === 'id' && f.operator === 'not in'), 'exclude id filter appended');
});

test('no filters → no `search` param emitted', () => {
  assert.ok(!wire(buildEntriesQuery({})).has('search'), 'empty input must not emit an empty search');
});

test('combined paging+sorting+form_ids (the reporter case) all serialize together', () => {
  const w = wire(buildEntriesQuery({
    form_ids: [129],
    paging: { page_size: 25, current_page: 2 },
    sorting: { key: 'date_created', direction: 'desc' },
  }));
  assert.equal(w.get('form_ids[0]'), '129');
  assert.equal(w.get('paging[page_size]'), '25');
  assert.equal(w.get('paging[current_page]'), '2');
  assert.equal(w.get('sorting[key]'), 'date_created');
  assert.equal(w.get('sorting[direction]'), 'desc');
});

// --- paging variants ---

test('paging with page_size only (no current_page) → just paging[page_size]', () => {
  const w = wire(buildEntriesQuery({ paging: { page_size: 100 } }));
  assert.equal(w.get('paging[page_size]'), '100');
  assert.ok(!w.has('paging[current_page]'));
  assert.ok(!w.has('paging'));
});

test('paging current_page=1 still serializes as a bracketed param', () => {
  const w = wire(buildEntriesQuery({ paging: { page_size: 10, current_page: 1 } }));
  assert.equal(w.get('paging[current_page]'), '1');
});

// --- sorting variants ---

test('sorting without is_numeric omits the is_numeric pair', () => {
  const w = wire(buildEntriesQuery({ sorting: { key: 'id', direction: 'DESC' } }));
  assert.equal(w.get('sorting[key]'), 'id');
  assert.equal(w.get('sorting[direction]'), 'DESC');
  assert.ok(!w.has('sorting[is_numeric]'));
});

test('sorting by a numeric field id (e.g. "1") serializes the key verbatim', () => {
  const w = wire(buildEntriesQuery({ sorting: { key: '1', direction: 'ASC', is_numeric: true } }));
  assert.equal(w.get('sorting[key]'), '1');
  assert.equal(w.get('sorting[is_numeric]'), 'true');
});

// --- search / status interplay ---

test('search mode rides inside field_filters (GF reads $field_filters[mode]), not search top-level', () => {
  const w = wire(buildEntriesQuery({ search: { field_filters: [{ key: '1', value: 'x', operator: 'is' }], mode: 'any' } }));
  const parsed = JSON.parse(w.get('search'));
  // GF reads the search mode from $search_criteria['field_filters']['mode'], so
  // it must be a key ON field_filters, not on the search object. field_filters
  // serializes as an object ({"0":…,"mode":…}).
  assert.equal(parsed.field_filters.mode, 'any');
  assert.ok(!('mode' in parsed), 'mode must NOT sit at the search top level — GF ignores it there');
});

test('top-level status overrides a status already inside search', () => {
  const w = wire(buildEntriesQuery({ search: { field_filters: [], status: 'active' }, status: 'trash' }));
  assert.equal(JSON.parse(w.get('search')).status, 'trash');
});

test('status alone (no search) produces a search criteria with just status', () => {
  const parsed = JSON.parse(wire(buildEntriesQuery({ status: 'spam' })).get('search'));
  assert.deepEqual(parsed, { status: 'spam' });
});

test('search alone does NOT force a status (GF defaults it to active)', () => {
  const parsed = JSON.parse(wire(buildEntriesQuery({ search: { field_filters: [{ key: '1', value: 'x', operator: 'is' }] } })).get('search'));
  assert.ok(!('status' in parsed), 'builder must not inject a status the caller did not ask for');
});

// --- include / exclude combinations ---

test('include + exclude together: include is native, exclude is a not-in field_filter', () => {
  const w = wire(buildEntriesQuery({ include: [1, 2], exclude: [9] }));
  assert.equal(w.get('include[0]'), '1');
  assert.equal(w.get('include[1]'), '2');
  const ff = JSON.parse(w.get('search')).field_filters;
  assert.ok(ff.some((f) => f.key === 'id' && f.operator === 'not in'));
  assert.ok(!ff.some((f) => f.operator === 'in'), 'include must NOT become a search filter');
});

test('include (native) + exclude + existing search field_filters coexist correctly', () => {
  const search = { field_filters: [{ key: '2', value: 'a', operator: 'is' }], mode: 'all' };
  const w = wire(buildEntriesQuery({ search, include: [5], exclude: [6] }));
  assert.equal(w.get('include[0]'), '5');
  // mode present → field_filters is an object; iterate its filter entries.
  const ffObj = JSON.parse(w.get('search')).field_filters;
  const ff = Object.values(ffObj).filter((f) => f && typeof f === 'object');
  assert.equal(ff.length, 2); // original + exclude not-in
  assert.ok(ff.some((f) => f.key === '2'));
  assert.ok(ff.some((f) => f.key === 'id' && f.operator === 'not in'));
});

test('empty include/exclude arrays add no field_filters and emit no search', () => {
  assert.ok(!wire(buildEntriesQuery({ include: [], exclude: [] })).has('search'));
});

test('exclude with many ids preserves order and values', () => {
  const ff = JSON.parse(wire(buildEntriesQuery({ exclude: [5, 4, 3, 2, 1] })).get('search')).field_filters[0];
  assert.deepEqual(ff.value, [5, 4, 3, 2, 1]);
});

// --- form_ids variants ---

test('single form_id serializes as form_ids[0]', () => {
  assert.equal(wire(buildEntriesQuery({ form_ids: [7] })).get('form_ids[0]'), '7');
});

// --- whole-kitchen-sink ---

test('kitchen sink: every param together serializes to its correct GF shape', () => {
  const w = wire(buildEntriesQuery({
    form_ids: [1, 2],
    paging: { page_size: 50, current_page: 4 },
    sorting: { key: 'date_created', direction: 'DESC', is_numeric: false },
    search: { field_filters: [{ key: '3', value: 'q', operator: 'contains' }], mode: 'all' },
    status: 'active',
    include: [10],
    exclude: [11],
  }));
  assert.equal(w.get('form_ids[0]'), '1');
  assert.equal(w.get('form_ids[1]'), '2');
  assert.equal(w.get('paging[page_size]'), '50');
  assert.equal(w.get('paging[current_page]'), '4');
  assert.equal(w.get('sorting[key]'), 'date_created');
  assert.equal(w.get('include[0]'), '10'); // native include param
  const s = JSON.parse(w.get('search'));
  assert.equal(s.status, 'active');
  // mode present → field_filters is an object carrying mode + numeric filters.
  assert.equal(s.field_filters.mode, 'all');
  const ff = Object.values(s.field_filters).filter((f) => f && typeof f === 'object');
  assert.equal(ff.length, 2); // original + exclude not-in
  assert.ok(!w.has('status') && !w.has('exclude[0]'), 'no GF-unknown top-level params');
});

// --- purity / safety ---

test('buildEntriesQuery does not mutate the caller input (search.field_filters)', () => {
  const input = { search: { field_filters: [{ key: '1', value: 'x', operator: 'is' }], mode: 'all' }, include: [5] };
  const before = JSON.stringify(input);
  buildEntriesQuery(input);
  assert.equal(JSON.stringify(input), before, 'input object and nested arrays must be untouched');
});

test('key insertion order does not affect output', () => {
  const a = wire(buildEntriesQuery({ paging: { page_size: 25 }, form_ids: [1], status: 'active' }));
  const b = wire(buildEntriesQuery({ status: 'active', form_ids: [1], paging: { page_size: 25 } }));
  assert.equal(a.get('paging[page_size]'), b.get('paging[page_size]'));
  assert.equal(a.get('search'), b.get('search'));
});

test('empty input yields an empty query (no params at all)', () => {
  assert.equal(flattenParams(buildEntriesQuery({})).length, 0);
});

// --- real validator path composition ---

test('search field_filter accepts lowercase in/not in operators (GF is case-insensitive)', () => {
  const validated = ValidationFactory.validateToolInput('gf_list_entries', {
    search: { field_filters: [{ key: 'id', operator: 'in', value: [2, 4, 6] }] }
  });
  const ff = validated.search.field_filters[0];
  assert.equal(ff.operator, 'in');
  assert.deepEqual(ff.value, ['2', '4', '6'], 'multi-value array preserved, not flattened to a scalar');
});

test('ValidationFactory(gf_list_entries) → buildEntriesQuery preserves the GF contract', () => {
  const validated = ValidationFactory.validateToolInput('gf_list_entries', {
    paging: { page_size: 25, current_page: 3 },
    sorting: { key: 'date_created', direction: 'desc' },
    form_ids: [129],
    include: [1, 2],
  });
  const w = wire(buildEntriesQuery(validated));
  assert.equal(w.get('paging[page_size]'), '25');
  assert.equal(w.get('paging[current_page]'), '3');
  assert.equal(w.get('sorting[key]'), 'date_created');
  assert.equal(w.get('form_ids[0]'), '129');
  assert.equal(w.get('include[0]'), '1');
  assert.equal(w.get('include[1]'), '2');
});
