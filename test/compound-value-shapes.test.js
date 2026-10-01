/**
 * A value for a compound field has to be named by input, not sent under the field's own key.
 *
 * Measured on staging, form 175 (name field 1, address field 10), read back with gf_get_entry:
 *   create  "1": "Ada Lovelace"   -> entry created, stored {}      (nothing, success reported)
 *   create  "10": "1 Main St"     -> entry created, stored {}
 *   create  "10": ["1 Main St", "Leverett"]
 *                                 -> refused "field 10 (address) takes a single value"  (wrong: it is not one)
 *   create  "1.3": "Ada", "10.1": "1 Main St" -> stored as sent (the working spelling)
 *   submit  input_10: "1 Main St" -> GF "At least one field must be filled out."
 *
 * Gravity Forms reads a compound field only from its inputs (GFAPI::queue_batch_field_operation walks
 * get_entry_inputs()). The guard used to name checkbox; it now asks the registry for storage.type
 * 'compound'. The fixture holds a `time` field as the negative control: it has inputs (5.1, 5.2, 5.3)
 * but the registry says string/single, and a scalar under its own key stores (measured: {"5": "14:30"}).
 * A guard keyed on "has inputs" refuses it, so the time tests are what separate that guard from
 * the registry one. A name or address with inputs is the positive: compound AND inputs listed.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';

const inputs = (id, ...parts) => parts.map(([n, label]) => ({ id: `${id}.${n}`, label }));

const FORM_175 = {
  id: 175,
  fields: [
    { id: 1, type: 'name', label: 'Name', inputs: inputs(1, [2, 'Prefix'], [3, 'First'], [4, 'Middle'], [6, 'Last'], [8, 'Suffix']) },
    { id: 2, type: 'text', label: 'Text' },
    { id: 5, type: 'time', label: 'Time', inputs: inputs(5, [1, 'HH'], [2, 'MM'], [3, 'AM/PM']) },
    { id: 10, type: 'address', label: 'Address', inputs: inputs(10, [1, 'Street'], [2, 'Line 2'], [3, 'City'], [4, 'State'], [5, 'ZIP'], [6, 'Country']) },
    { id: 11, type: 'consent', label: 'Consent', inputs: inputs(11, [1, 'Consent'], [2, 'Text'], [3, 'Revision']) },
    { id: 12, type: 'creditcard', label: 'Card', inputs: inputs(12, [1, 'Number'], [2, 'Expiration'], [3, 'Security'], [4, 'Type'], [5, 'Name']) },
    { id: 13, type: 'chainedselect', label: 'Chained', inputs: inputs(13, [1, 'Make'], [2, 'Model']) },
    // No inputs listed: GF then stores under the field's own key, so nothing is refused.
    { id: 14, type: 'name', label: 'Bare name' }
  ]
};

function makeClient(routes) {
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
    return { data: typeof route === 'function' ? route(body) : route };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  return { client, requests };
}

const writes = (requests) => requests.filter((r) => r.method !== 'GET');
const routes = () => ({
  'GET /forms/175': FORM_175,
  'GET /entries/9': { id: 9, form_id: 175, '1.3': 'Ada' },
  'POST /entries': (b) => ({ ...b, id: 9 }),
  'PUT /entries/9': (b) => ({ ...b, id: 9 }),
  'POST /forms/175/submissions': { is_valid: true, entry_id: 33 },
  'POST /forms/175/submissions/validation': { is_valid: true }
});

// --- positive: a scalar under a compound field's own key is refused, with the repair ---

test('create refuses a scalar under a name field and names its inputs and a pasteable call', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '1': 'Ada Lovelace' }),
    (error) => {
      assert.match(error.message, /field 1 \(name\)/);
      assert.match(error.message, /stored nowhere/);
      for (const id of ['1.2', '1.3', '1.4', '1.6', '1.8']) assert.ok(error.message.includes(id), `names ${id}`);
      assert.match(error.message, /"1\.2": "Ada Lovelace"/);
      assert.doesNotMatch(error.message, /array to tick/, 'a name has no array spelling to offer');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses a scalar under an address field', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(() => client.createEntry({ form_id: 175, '10': '1 Main St' }), /field 10 \(address\).*10\.1.*10\.6/);
  assert.strictEqual(writes(requests).length, 0);
});

test('update refuses a scalar under a name field', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(() => client.updateEntry({ id: 9, form_id: 175, '1': 'Ada' }), /field 1 \(name\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('submit and both validation tools refuse a scalar under input_N of an address, before sending', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(() => client.submitFormData({ form_id: 175, input_10: '1 Main St' }), /field 10 \(address\).*10\.1/);
  await assert.rejects(() => client.validateSubmission({ form_id: 175, input_10: '1 Main St' }), /field 10 \(address\)/);
  await assert.rejects(() => client.validateForm({ form_id: 175, input_10: '1 Main St' }), /field 10 \(address\)/);
  assert.strictEqual(writes(requests).length, 0);
});

// --- the array branch must not call a compound field a single-value field, nor promise an array works ---

test('create refuses an array under an address without calling it a single-value field', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '10': ['1 Main St', 'Leverett'] }),
    (error) => {
      assert.match(error.message, /field 10 \(address\)/);
      assert.match(error.message, /an array/);
      assert.match(error.message, /10\.1/);
      assert.doesNotMatch(error.message, /takes a single value/, 'an address is not a single-value field');
      assert.doesNotMatch(error.message, /array to tick/, 'no array form is offered');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses an object under a name field, even one keyed by input id', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '1': { '3': 'Ada' } }),
    (error) => {
      assert.match(error.message, /field 1 \(name\).*1\.3.*an object/);
      assert.doesNotMatch(error.message, /takes a single value/);
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

// --- the other compound types: each reads only its inputs ---

test('consent: GF reads input N.1 only, so a "1" or true under the parent is refused too', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(() => client.createEntry({ form_id: 175, '11': '1' }), /field 11 \(consent\).*11\.1/);
  await assert.rejects(() => client.createEntry({ form_id: 175, '11': true }), /field 11 \(consent\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('chainedselect: scalar, array and object under the parent are all refused', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(() => client.createEntry({ form_id: 175, '13': 'Ford' }), /field 13 \(chainedselect\).*13\.1.*13\.2/);
  await assert.rejects(() => client.createEntry({ form_id: 175, '13': ['Ford', 'Focus'] }), /field 13 \(chainedselect\)/);
  await assert.rejects(() => client.createEntry({ form_id: 175, '13': { '1': 'Ford' } }), /field 13 \(chainedselect\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('creditcard: the parent key is refused, and only the inputs GF stores (12.1, 12.4) are offered', async () => {
  const { client, requests } = makeClient(routes());
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '12': '4111' }),
    (error) => {
      assert.match(error.message, /field 12 \(creditcard\)/);
      assert.ok(error.message.includes('12.1') && error.message.includes('12.4'));
      assert.ok(!error.message.includes('12.2') && !error.message.includes('12.5'), 'GF stores only .1 and .4');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

// --- negative controls: what must still go through ---

test('create still sends a scalar under a time field (registry: string, single, though it has inputs)', async () => {
  const { client, requests } = makeClient(routes());
  await client.createEntry({ form_id: 175, '5': '14:30' });
  assert.strictEqual(requests.find((r) => r.method === 'POST' && r.path === '/entries').body['5'], '14:30');
});

test('create still sends the input spellings of name and address', async () => {
  const { client, requests } = makeClient(routes());
  await client.createEntry({ form_id: 175, '1.3': 'Ada', '1.6': 'Lovelace', '10.1': '1 Main St', '10.3': 'Leverett' });
  const body = requests.find((r) => r.method === 'POST' && r.path === '/entries').body;
  assert.strictEqual(body['1.3'], 'Ada');
  assert.strictEqual(body['10.3'], 'Leverett');
});

test('"" and null under a compound key still pass, as they do for a checkbox', async () => {
  const { client, requests } = makeClient(routes());
  await client.createEntry({ form_id: 175, '1': '', '10': null, '2': 'x' });
  assert.strictEqual(writes(requests).length, 1);
});

test('a name field that lists no inputs is not refused: GF stores such a field under its own key', async () => {
  const { client, requests } = makeClient(routes());
  await client.createEntry({ form_id: 175, '14': 'Ada Lovelace' });
  assert.strictEqual(writes(requests).length, 1);
});

test('a text field still refuses an array and still takes a scalar', async () => {
  const { client } = makeClient(routes());
  await assert.rejects(() => client.createEntry({ form_id: 175, '2': ['a'] }), /field 2 \(text\) takes a single value/);
  await client.createEntry({ form_id: 175, '2': 'a' });
});
