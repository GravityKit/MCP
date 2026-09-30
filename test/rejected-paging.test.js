/**
 * gf_list_entries / gf_list_forms refuse parameters Gravity Forms does not read.
 * Top-level page/per_page/offset on /entries and per_page/page/status/active/
 * exclude/search on /forms used to be dropped, so the caller got an unpaginated
 * or unfiltered answer and believed the request had been honored.
 *
 * GF sources: class-gf-rest-controller.php parse_entry_search_params (paging
 * object: page_size, current_page, offset) and class-controller-forms.php
 * get_items (reads only `include`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { ValidationFactory } from '../src/config/validation.js';

const validate = (tool, input) => ValidationFactory.validateToolInput(tool, input);

function makeClient(routes = {}) {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass'
  });
  const requests = [];
  const answer = (method) => async (path, data) => {
    const body = method === 'GET' ? undefined : data;
    requests.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    return { data: typeof route === 'function' ? route(body) : route, headers: {} };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  return { client, requests };
}

// --- 1. gf_list_entries -----------------------------------------------------

for (const key of ['per_page', 'offset', 'page']) {
  test(`gf_list_entries refuses a top-level ${key} and names the paging shape`, () => {
    assert.throws(
      () => validate('gf_list_entries', { form_id: 1, [key]: 100 }),
      (error) => {
        assert.match(error.message, new RegExp(key));
        assert.match(error.message, /paging: \{ page_size, current_page \}/);
        assert.match(error.message, /offset/, 'the paging.offset alternative is named');
        return true;
      }
    );
  });
}

test('gf_list_entries names every top-level paging key it was given', () => {
  assert.throws(
    () => validate('gf_list_entries', { per_page: 25, page: 2 }),
    /per_page, page/
  );
});

test('gf_list_entries sends nothing when it refuses a top-level offset', async () => {
  const { client, requests } = makeClient({ 'GET /entries': { entries: [], total_count: 0 } });
  await assert.rejects(() => client.listEntries({ form_id: 1, offset: 100 }), /offset/);
  assert.equal(requests.length, 0);
});

test('gf_list_entries still accepts paging, with offset or current_page, and ignores unset top-level keys', () => {
  assert.deepEqual(validate('gf_list_entries', { paging: { page_size: 20, offset: 40 } }).paging, { page_size: 20, offset: 40 });
  assert.deepEqual(validate('gf_list_entries', { paging: { page_size: 20, current_page: 3 } }).paging, { page_size: 20, current_page: 3 });
  assert.doesNotThrow(() => validate('gf_list_entries', { per_page: undefined, page: null, offset: undefined }));
});

// --- 1b. gf_list_forms ------------------------------------------------------

for (const key of ['per_page', 'page', 'status', 'active', 'exclude', 'search']) {
  test(`gf_list_forms refuses ${key} instead of returning every form`, () => {
    assert.throws(
      () => validate('gf_list_forms', { [key]: key === 'exclude' ? [9] : 'x' }),
      (error) => {
        assert.match(error.message, new RegExp(key));
        assert.match(error.message, /include/, 'the one filter GF reads is named');
        return true;
      }
    );
  });
}

test('gf_list_forms still accepts include and ignores unset keys', () => {
  assert.deepEqual(validate('gf_list_forms', { include: [1, 2], per_page: undefined }), { include: [1, 2] });
});

