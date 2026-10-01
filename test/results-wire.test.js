/**
 * Wire tests for gf_get_results search forwarding.
 *
 * The client forwarded `searchParams` spread from validated input, but
 * validation returned only {form_id}, so search criteria were silently
 * dropped and every call returned unfiltered results. GF's /results endpoint
 * accepts `search` as a JSON string (parse_entry_search_params, same as
 * /entries) — verified against GF 2.10.5.1.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';

function makeClient() {
  return new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass',
  });
}

test('gf_get_results: search criteria reach the wire as a JSON string', async () => {
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => {
    gets.push({ path, params: config?.params });
    return { data: { entry_count: 1 } };
  };

  await client.getResults({
    form_id: 2,
    search: { field_filters: [{ key: 'created_by', value: '1', operator: '=' }] },
  });

  assert.equal(gets[0].path, '/forms/2/results');
  const wireSearch = gets[0].params?.search;
  assert.ok(typeof wireSearch === 'string', `search must be a JSON string on the wire, got ${typeof wireSearch}`);
  const parsed = JSON.parse(wireSearch);
  assert.deepEqual(parsed.field_filters, [{ key: 'created_by', value: '1', operator: '=' }]);
});

test('gf_get_results: no stray params when search is omitted', async () => {
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => {
    gets.push({ path, params: config?.params });
    return { data: { entry_count: 3 } };
  };

  await client.getResults({ form_id: 2 });

  assert.deepEqual(gets[0].params ?? {}, {}, 'no search param should be sent when none was requested');
});

test('gf_get_results: a malformed search is rejected, not silently dropped', async () => {
  const client = makeClient();
  await assert.rejects(
    () => client.getResults({ form_id: 2, search: 'not-an-object' }),
    /search must be an object/
  );
});

// --- search.mode must reach GF where GF reads it ---

test('gf_get_results: search.mode is moved into field_filters, as /entries does', async () => {
  // GF reads the mode from $field_filters['mode'], never from a top-level
  // search.mode, so serializing the validated object directly drops it silently
  // and every "any" search behaves as "all".
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => { gets.push(config?.params); return { data: {} }; };

  await client.getResults({
    form_id: 1,
    search: { mode: 'any', field_filters: [{ key: '1', value: 'x' }] },
  });

  const sent = JSON.parse(gets[0].search);
  assert.equal(sent.mode, undefined, 'mode must not stay at the top level');
  assert.equal(sent.field_filters.mode, 'any', 'mode belongs inside field_filters');
  assert.equal(sent.field_filters['0'].key, '1', 'the filters themselves survive');
});

test('gf_get_results: a search with no mode is unchanged', async () => {
  // The control: moving unconditionally would rewrite field_filters into an
  // object for every caller, including those who never set a mode.
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => { gets.push(config?.params); return { data: {} }; };

  await client.getResults({ form_id: 1, search: { field_filters: [{ key: '1', value: 'x' }] } });

  const sent = JSON.parse(gets[0].search);
  assert.ok(Array.isArray(sent.field_filters), 'stays an array when no mode is given');
});

// --- a serialized WP_Error arrives inside an HTTP 200 ---
//
// GF's results controller wraps whatever the results cache returned in a 200
// (class-controller-form-results.php prepare_item_for_response), so a failed read
// is a success carrying an `errors` object. The cache returns exactly one such
// error — not_found for a form id that does not resolve — and a form with no
// entries answers with an ordinary payload of zero counts, so `errors` is never
// a way of saying "no data".

test('gf_get_results: a not_found WP_Error in a 200 throws rather than reporting empty results', async () => {
  const client = makeClient();
  client.httpClient.get = async () => ({
    data: { errors: { not_found: ['Form not found'] }, error_data: [] }
  });

  await assert.rejects(
    () => client.getResults({ form_id: 99999999 }),
    (error) => {
      // The same condition on the sibling field-filters call reports a 404, so
      // this must read the same way rather than as a successful empty read.
      assert.match(error.message, /Resource not found: Form not found/);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'not_found');
      return true;
    }
  );
});

test('gf_get_results: any other WP_Error code in a 200 also throws', async () => {
  const client = makeClient();
  client.httpClient.get = async () => ({
    data: { errors: { results_unavailable: ['Something broke'] }, error_data: [] }
  });

  await assert.rejects(
    () => client.getResults({ form_id: 1 }),
    (error) => {
      assert.match(error.message, /Something broke/);
      assert.equal(error.code, 'results_unavailable');
      return true;
    }
  );
});

test('gf_get_results: a real results payload with zero entries is returned, not treated as an error', async () => {
  // The control. A form with no entries is a successful read of nothing, and GF
  // spells it as a normal payload — status/entry_count/field_data, no `errors`.
  const client = makeClient();
  client.httpClient.get = async () => ({
    data: { status: 'complete', entry_count: 0, field_data: {}, timestamp: 1758000000 }
  });

  const result = await client.getResults({ form_id: 159 });
  assert.equal(result.results.entry_count, 0);
  assert.equal(result.results.status, 'complete');
});

test('gf_get_results: a populated results payload still comes back untouched', async () => {
  const client = makeClient();
  client.httpClient.get = async () => ({
    data: { status: 'complete', entry_count: 7, field_data: { 1: { Yes: 4, No: 3 } }, timestamp: 1758000000 }
  });

  const result = await client.getResults({ form_id: 159 });
  assert.equal(result.results.entry_count, 7);
  assert.deepEqual(result.results.field_data, { 1: { Yes: 4, No: 3 } });
});
