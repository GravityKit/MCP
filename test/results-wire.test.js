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
