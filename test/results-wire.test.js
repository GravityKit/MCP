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
