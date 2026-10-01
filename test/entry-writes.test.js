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

// --- update ---

const EXISTING = { id: 101696, form_id: 161, '1': 'Ada', status: 'active' };

test('update refuses the nested entry shape, and writes nothing', async () => {
  const { client, requests } = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    'PUT /entries/101696': EXISTING
  });

  await assert.rejects(
    () => client.updateEntry({ id: 101696, entry: { '1': 'Should not land' } }),
    (error) => {
      assert.match(error.message, /"entry"/);
      assert.match(error.message, /id: 101696/);
      return true;
    }
  );
  assert.equal(writes(requests).length, 0, 'no PUT may be sent');
});

test('update refuses a key that is no field on the entry\'s form, and writes nothing', async () => {
  const { client, requests } = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    'PUT /entries/101696': EXISTING
  });

  await assert.rejects(() => client.updateEntry({ id: 101696, '9999': 'ghost' }), /9999.*form 161/);
  assert.equal(writes(requests).length, 0);
});

test('update accepts real fields and sub-inputs, and saves them', async () => {
  const { client, requests } = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    'PUT /entries/101696': (b) => b
  });

  await client.updateEntry({ id: 101696, '1': 'Grace', '6_3': 'Oslo' });

  const put = requests.find((r) => r.method === 'PUT');
  assert.equal(put.body['1'], 'Grace');
  assert.equal(put.body['6.3'], 'Oslo');
  assert.equal(put.body['6_3'], undefined);
});

test('an update that touches no field never fetches the form', async () => {
  const { client, requests } = makeClient({
    'GET /entries/101696': EXISTING,
    'PUT /entries/101696': (b) => b
  });

  await client.updateEntry({ id: 101696, status: 'spam' });

  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['GET /entries/101696', 'PUT /entries/101696']);
});

// --- the unit the client leans on ---

test('assertKeysResolve passes a field whose form lists no inputs for a dotted key', () => {
  // post_image and similar types may not list their inputs; refusing their
  // sub-keys would block a legitimate write. The stored entry read-back covers it.
  const fields = [{ id: 3, type: 'post_image' }];
  EntriesValidator.assertKeysResolve({ '3.1': 'Title' }, fields, 161);
});

// --- keys Gravity Forms did not store ---
//
// create and update keep passing non-field keys through, because registered entry
// meta is per-site (GravityView's is_approved). GF saves such a key only when a
// gform_entry_meta filter registers it (GFAPI::add_entry, api.php:1319-1324) and
// drops the rest. The stored entry GF answers with always lists every registered
// meta key, as false when unset (class-gf-query.php get_entries), so a key missing
// from it was not registered.

const IGNORED_WARNING = 'Gravity Forms stored no value for: banana. It saves a non-field key only when the form registers it as entry meta; check the key name.';

test('create reports a non-field key that is absent from the stored entry', async () => {
  const { client } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada' }
  });

  const result = await client.createEntry({ form_id: 161, '1': 'Ada', banana: 'x' });

  assert.deepEqual(result.ignored_keys, ['banana']);
  assert.equal(result.warning, IGNORED_WARNING);
});

test('update reports a non-field key that is absent from the stored entry', async () => {
  const { client } = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    // GF answers a PUT with GFAPI::get_entry: banana was not stored.
    'PUT /entries/101696': { id: 101696, form_id: 161, '1': 'Ada', status: 'active' }
  });

  const result = await client.updateEntry({ id: 101696, '1': 'Ada', banana: 'x' });

  assert.deepEqual(result.ignored_keys, ['banana']);
  assert.equal(result.warning, IGNORED_WARNING);
});

test('registered entry meta present in the stored entry is not reported, on create or update', async () => {
  const create = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada', is_approved: '1' }
  });
  const created = await create.client.createEntry({ form_id: 161, '1': 'Ada', is_approved: '1' });
  assert.ok(!('ignored_keys' in created), 'no ignored_keys when everything was stored');
  assert.ok(!('warning' in created));

  const update = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    'PUT /entries/101696': { ...EXISTING, is_approved: '1' }
  });
  const updated = await update.client.updateEntry({ id: 101696, is_approved: '1' });
  assert.ok(!('ignored_keys' in updated));
  assert.ok(!('warning' in updated));
});

test('registered meta stored as false (GF lists unset meta that way) is present, not ignored', async () => {
  const { client } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada', is_approved: false }
  });

  const result = await client.createEntry({ form_id: 161, '1': 'Ada', is_approved: '0' });

  assert.ok(!('ignored_keys' in result));
});

test('a sent null or empty value for an absent key is not reported', async () => {
  const create = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada' }
  });
  const created = await create.client.createEntry({ form_id: 161, '1': 'Ada', banana: null, cherry: '' });
  assert.ok(!('ignored_keys' in created), 'clearing meta that is not there says nothing');

  const update = makeClient({
    'GET /entries/101696': EXISTING,
    'GET /forms/161': FORM,
    'PUT /entries/101696': EXISTING
  });
  const updated = await update.client.updateEntry({ id: 101696, banana: null, cherry: '' });
  assert.ok(!('ignored_keys' in updated));
});

test('entry columns, including source_id and date_updated, are never reported', async () => {
  const { client } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    // The stored entry does not echo them back here; they are columns, not meta.
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada' }
  });

  const result = await client.createEntry({
    form_id: 161, '1': 'Ada', source_id: 4, date_updated: '2026-01-01 00:00:00', is_starred: 1, status: 'active'
  });

  assert.ok(!('ignored_keys' in result));
});

test('every key GF ignored is listed, once, in the warning', async () => {
  const { client } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, '1': 'Ada' }
  });

  const result = await client.createEntry({ form_id: 161, '1': 'Ada', banana: 'x', cherry: 'y' });

  assert.deepEqual(result.ignored_keys, ['banana', 'cherry']);
  assert.match(result.warning, /for: banana, cherry\./);
});

// --- value shape must match what the field stores ---
//
// assertKeysResolve checks that a key NAMES a field, not that the value fits it.
// _normalizeArrayValues expands an array only for fields with choices; on a field
// that holds one value the array went to GF, which stored nothing, and the call
// answered with an entry id. Measured live on staging (form 165, field 1 a text):
// ["a","b"], [["a","b"]], {"x":"y"} and [] each returned an id with no value stored.

const SHAPE_FORM = {
  id: 162,
  fields: [
    { id: 1, type: 'text', label: 'Name' },
    { id: 2, type: 'email', label: 'Email' },
    { id: 3, type: 'multiselect', label: 'Tags', choices: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }] },
    { id: 4, type: 'list', label: 'Rows' },
    { id: 5, type: 'fileupload', label: 'Files', multipleFiles: true },
    { id: 6, type: 'radio', label: 'Pick', choices: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }] },
    {
      id: 7,
      type: 'checkbox',
      label: 'Topics',
      choices: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }],
      inputs: [{ id: '7.1', label: 'A' }, { id: '7.2', label: 'B' }]
    },
    {
      id: 8,
      type: 'name',
      label: 'Full name',
      inputs: [{ id: '8.3', label: 'First' }, { id: '8.6', label: 'Last' }]
    },
    { id: 9, type: 'repeater', label: 'Rows', fields: [{ id: 10, type: 'text', label: 'Cell' }] },
    { id: 11, type: 'acme_custom', label: 'Add-on field' },
    { id: 12, type: 'multiselect', label: 'Choices not listed' }
  ]
};

function makeShapeClient() {
  return makeClient({
    'GET /forms/162': SHAPE_FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 162 },
    'GET /entries/50': { id: 50, form_id: 162 },
    'PUT /entries/50': { id: 50, form_id: 162 }
  });
}

test('create refuses an array or object on a single-value field, and writes nothing', async () => {
  for (const [label, value, given] of [
    ['an array', ['a', 'b'], 'an array'],
    ['a nested array', [['a', 'b']], 'an array'],
    ['an empty array', [], 'an array'],
    ['an object', { x: 'y' }, 'an object']
  ]) {
    const { client, requests } = makeShapeClient();
    await assert.rejects(
      () => client.createEntry({ form_id: 162, '1': value }),
      (error) => {
        assert.match(error.message, /field 1 \(text\) takes a single value/, `${label}: names the field and its type`);
        assert.match(error.message, new RegExp(`${given} was given`), `${label}: says what was given`);
        assert.match(error.message, /stores nothing/);
        return true;
      },
      `${label} must be refused`
    );
    assert.equal(writes(requests).length, 0, `${label}: nothing may be POSTed`);
  }
});

test('create still accepts null and an empty string for a single-value field', async () => {
  const { client, requests } = makeShapeClient();

  await client.createEntry({ form_id: 162, '1': null, '2': 'keep@example.com' });
  await client.createEntry({ form_id: 162, '1': '' });

  assert.equal(writes(requests).length, 2);
});

test('create accepts an array where the field holds several values', async () => {
  const { client, requests } = makeShapeClient();

  await client.createEntry({
    form_id: 162,
    '3': ['A', 'B'],               // multiselect
    '4': [['a', 'b'], ['c', 'd']], // list: rows
    '5': ['one.pdf', 'two.pdf'],   // fileupload
    '7': ['B'],                    // checkbox: expanded to its inputs
    '9': [{ 10: 'x' }],            // repeater: JSON rows
    '12': ['x', 'y']               // multiselect: the registry says it stores several
  });

  const post = requests.find((r) => r.method === 'POST');
  assert.equal(post.body['7.2'], 'B', 'checkbox expansion still ran');
  assert.deepEqual(post.body['3'], ['A', 'B'], 'a multiselect array reaches GF as an array');
  assert.deepEqual(post.body['4'], [['a', 'b'], ['c', 'd']], 'list rows reach GF as given');
});

test('create refuses an array on a radio: it holds one value, and the first used to be taken', async () => {
  for (const value of [['A', 'B'], ['A']]) {
    const { client, requests } = makeShapeClient();
    await assert.rejects(
      () => client.createEntry({ form_id: 162, '6': value }),
      /field 6 \(radio\) takes a single value, but an array was given/
    );
    assert.equal(writes(requests).length, 0, 'nothing may be POSTed');
  }
});

test('create refuses an array on a compound field\'s own id and on a single input', async () => {
  // Field 8 is a name: refused, but as a compound field (it is not a single-value one;
  // test/compound-value-shapes.test.js pins the message). Its inputs hold one value each.
  for (const key of ['8.3', '7.1']) {
    const { client, requests } = makeShapeClient();
    await assert.rejects(
      () => client.createEntry({ form_id: 162, [key]: ['Ada'] }),
      new RegExp(`${key.replace('.', '\\.')}.*takes a single value`),
      `${key} holds one value`
    );
    assert.equal(writes(requests).length, 0);
  }
  const { client, requests } = makeShapeClient();
  await assert.rejects(() => client.createEntry({ form_id: 162, '8': ['Ada'] }), /field 8 \(name\).*8\.3.*an array/);
  assert.equal(writes(requests).length, 0);
});

test('create refuses a plain object on a checkbox, which the expansion never handled', async () => {
  const { client, requests } = makeShapeClient();
  await assert.rejects(() => client.createEntry({ form_id: 162, '7': { A: true } }), /field 7 \(checkbox\).*an object was given/);
  assert.equal(writes(requests).length, 0);
});

test('a field type the registry does not know is not refused: its shape cannot be judged', async () => {
  const { client, requests } = makeShapeClient();
  await client.createEntry({ form_id: 162, '11': ['x'] });
  assert.equal(writes(requests).length, 1);
});

test('every offending key is named in one refusal', async () => {
  const { client } = makeShapeClient();
  await assert.rejects(
    () => client.createEntry({ form_id: 162, '1': ['a'], '2': { x: 1 } }),
    (error) => {
      assert.match(error.message, /field 1 \(text\)/);
      assert.match(error.message, /field 2 \(email\)/);
      return true;
    }
  );
});

test('update refuses an array on a single-value field, and sends no PUT', async () => {
  const { client, requests } = makeShapeClient();
  await assert.rejects(
    () => client.updateEntry({ id: 50, '1': ['a', 'b'] }),
    /field 1 \(text\) takes a single value/
  );
  assert.equal(writes(requests).length, 0);
});
