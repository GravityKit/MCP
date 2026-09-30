/**
 * gf_create_entry / gf_update_entry must not report success for values that
 * were never stored.
 *
 * GF's POST /entries answers with the request body plus an id, and silently
 * ignores any key that is not a field on the form. So a caller's typo, an
 * invented field id, or a guessed nested `entry: {…}` shape came back looking
 * like a stored entry. These tests pin the two halves of the fix: a write whose
 * keys resolve to no field is refused before it reaches GF, and what a create
 * returns is what GF stored, read back, not what the caller sent.
 *
 * Assertions read the wire through the recorded requests, not the return value.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { ValidationFactory, EntriesValidator } from '../src/config/validation.js';

const FORM = {
  id: 161,
  fields: [
    { id: 1, type: 'text', label: 'Name' },
    { id: 2, type: 'email', label: 'Email' },
    {
      id: 6,
      type: 'address',
      label: 'Address',
      inputs: [{ id: '6.1', label: 'Street' }, { id: '6.2', label: 'Line 2' }, { id: '6.3', label: 'City' }]
    },
    {
      id: 7,
      type: 'checkbox',
      label: 'Topics',
      choices: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }],
      inputs: [{ id: '7.1', label: 'A' }, { id: '7.2', label: 'B' }]
    }
  ]
};

/** A client whose HTTP layer records every request and answers from `routes`. */
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
    if (route instanceof Error) throw route;
    return { data: typeof route === 'function' ? route(body) : route };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  return { client, requests };
}

const writes = (requests) => requests.filter((r) => r.method !== 'GET');

// --- create: refuse keys that resolve to no field ---

test('create refuses a key that names no field on the form, and writes nothing', async () => {
  const { client, requests } = makeClient({ 'GET /forms/161': FORM, 'POST /entries': (b) => ({ ...b, id: 9 }) });

  await assert.rejects(
    () => client.createEntry({ form_id: 161, '1': 'Ada', '9999': 'ghost' }),
    (error) => {
      assert.match(error.message, /9999/, 'the bad key is named');
      assert.match(error.message, /form 161/);
      assert.match(error.message, /1, 2, 6, 7/, 'the ids that do exist are listed');
      return true;
    }
  );
  assert.equal(writes(requests).length, 0, 'nothing may be POSTed');
});

test('create refuses the nested entry shape and shows the top-level one', async () => {
  const { client, requests } = makeClient({ 'GET /forms/161': FORM, 'POST /entries': { id: 9 } });

  await assert.rejects(
    () => client.createEntry({ form_id: 161, entry: { '1': 'Ada', '2': 'ada@example.com' } }),
    (error) => {
      assert.match(error.message, /"entry"/);
      assert.match(error.message, /top-level/);
      assert.match(error.message, /form_id: 161/);
      return true;
    }
  );
  assert.equal(requests.length, 0, 'refused before any HTTP call');
});

test('create with no field value at all is refused with the key shape', () => {
  assert.throws(
    () => ValidationFactory.validateToolInput('gf_create_entry', { form_id: 161, status: 'active' }),
    /no field values were given: pass them as top-level field-id keys \(e\.g\. "1": "Ada"/
  );
});

test('create accepts every key that resolves: fields, sub-inputs, and entry properties', async () => {
  const { client, requests } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada' }
  });

  await client.createEntry({ form_id: 161, '1': 'Ada', '6.3': 'Oslo', status: 'active', created_by: 1 });

  const post = requests.find((r) => r.method === 'POST');
  assert.equal(post.body['6.3'], 'Oslo');
  assert.equal(post.body.status, 'active');
});

test('create refuses a sub-input the field does not have', async () => {
  const { client, requests } = makeClient({ 'GET /forms/161': FORM, 'POST /entries': { id: 9 } });

  await assert.rejects(
    () => client.createEntry({ form_id: 161, '6.9': 'x' }),
    (error) => {
      assert.match(error.message, /6\.9/);
      assert.match(error.message, /6\.1, 6\.2, 6\.3/, 'the real inputs are listed');
      return true;
    }
  );
  assert.equal(writes(requests).length, 0);
});

test('create reads one form for both the key check and checkbox expansion', async () => {
  const { client, requests } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161 }
  });

  await client.createEntry({ form_id: 161, '1': 'Ada', '7': ['B'] });

  assert.equal(requests.filter((r) => r.path === '/forms/161').length, 1, 'the form is fetched once');
  const post = requests.find((r) => r.method === 'POST');
  assert.equal(post.body['7.2'], 'B', 'expansion still ran against the same fields');
});

// --- sub-input key convention: the same one gf_submit_form_data uses ---

test('an underscored sub-input is the dotted one, as on gf_submit_form_data', () => {
  const v = ValidationFactory.validateToolInput('gf_create_entry', { form_id: 161, '6_3': 'Oslo' });
  assert.equal(v['6.3'], 'Oslo');
  assert.ok(!('6_3' in v), 'the underscored spelling must not ride to GF, which would ignore it');
});

test('one sub-input under both spellings with different values is refused', () => {
  assert.throws(
    () => ValidationFactory.validateToolInput('gf_create_entry', { form_id: 161, '6.3': 'Oslo', '6_3': 'Bergen' }),
    /6_3 and 6\.3 name the same input and disagree; pass one/
  );
  // The same value twice says one thing, so it is not a contradiction.
  const same = ValidationFactory.validateToolInput('gf_create_entry', { form_id: 161, '6.3': 'Oslo', '6_3': 'Oslo' });
  assert.equal(same['6.3'], 'Oslo');
});

// --- create: what comes back is what was stored ---

test('create returns the stored entry, not the request echoed by GF', async () => {
  const { client, requests } = makeClient({
    'GET /forms/161': FORM,
    // GF echoes the body. Field 2 is sent but stored empty: the echo must not leak.
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada', '2': '' }
  });

  const result = await client.createEntry({ form_id: 161, '1': 'Ada', '2': 'not-stored@example.com' });

  assert.deepEqual(result.entry, { id: 9, form_id: 161, '1': 'Ada', '2': '' });
  assert.ok(requests.some((r) => r.method === 'GET' && r.path === '/entries/9'), 'the entry is read back by id');
});

test('create that cannot read the entry back still returns the id and says so', async () => {
  const { client } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': new Error('timeout')
  });

  const result = await client.createEntry({ form_id: 161, '1': 'Ada' });

  assert.deepEqual(result.entry, { id: 9, form_id: 161 }, 'only what is known to be true');
  assert.match(result.warning, /id 9/);
  assert.match(result.warning, /gf_get_entry/);
});

// --- the unit the client leans on ---

test('assertKeysResolve passes a field whose form lists no inputs for a dotted key', () => {
  // post_image and similar types may not list their inputs; refusing their
  // sub-keys would block a legitimate write. The stored entry read-back covers it.
  const fields = [{ id: 3, type: 'post_image' }];
  EntriesValidator.assertKeysResolve({ '3.1': 'Title' }, fields, 161);
});
