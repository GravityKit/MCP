/**
 * The shape a caller sends for a field must be the shape Gravity Forms reads.
 *
 * Measured on form 172 (text, radio, select, checkbox, multiselect), read back
 * with gf_get_entry:
 *   create  "5": ["m","n"]      -> ["\"m", "n\""]   (the MCP comma-joined it, then
 *                                  GF json_encoded the string; to_array() split it)
 *   create  "4": ["p","q"]      -> "p,q"            (checkbox had no inputs to expand to)
 *   create  "2": ["a","b"]      -> "a"              (radio kept the first, dropped the rest)
 *   submit  input_2: ["a","b"]  -> "2": "" plus "2_0", "2_1"  (GF's hydrate_post reads an
 *                                  array under a single-value input as repeater rows)
 *
 * Assertions read the wire through the recorded requests.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';

const CHOICES = (...values) => values.map((value) => ({ text: value, value }));

const FORM_172 = {
  id: 172,
  fields: [
    { id: 1, type: 'text', label: 'Text' },
    { id: 2, type: 'radio', label: 'Radio', choices: CHOICES('a', 'b') },
    { id: 3, type: 'select', label: 'Select', choices: CHOICES('x', 'y') },
    // The shape the API leaves behind: choices, and no inputs to hold them.
    { id: 4, type: 'checkbox', label: 'Checkbox', choices: CHOICES('p', 'q'), inputs: [] },
    { id: 5, type: 'multiselect', label: 'Multi', storageType: 'json', choices: CHOICES('m', 'n') },
    // A multiselect with no choices distinguishes "keyed off the type" from "keyed off choices".
    { id: 6, type: 'multiselect', label: 'Bare multi' },
    {
      id: 7,
      type: 'checkbox',
      label: 'Cities',
      choices: CHOICES('Atlanta, GA', 'Austin, TX', 'Boston'),
      inputs: [{ id: '7.1', label: 'Atlanta, GA' }, { id: '7.2', label: 'Austin, TX' }, { id: '7.3', label: 'Boston' }]
    },
    { id: 8, type: 'post_category', inputType: 'multiselect', label: 'Cats', choices: CHOICES('News:5', 'Tech:12') }
  ]
};

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
const entryRoutes = () => ({
  'GET /forms/172': FORM_172,
  'POST /entries': (b) => ({ ...b, id: 9 }),
  'GET /entries/9': { id: 9, form_id: 172 }
});
const sent = (requests) => requests.find((r) => r.method === 'POST' && r.path === '/entries').body;

// --- bug 1: a multiselect array reaches GF as an array ---

test('create sends a multiselect array as an array, so GF stores it by the field storageType', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '5': ['m', 'n'] });
  assert.deepStrictEqual(sent(requests)['5'], ['m', 'n']);
});

test('create sends the array whether or not the multiselect lists choices', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '6': ['m', 'n'] });
  assert.deepStrictEqual(sent(requests)['6'], ['m', 'n']);
});

test('create keeps a comma inside a multiselect value intact', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '5': ['Atlanta, GA', 'Austin, TX'] });
  assert.deepStrictEqual(sent(requests)['5'], ['Atlanta, GA', 'Austin, TX']);
});

test('create reads inputType: a post_category set to multiselect is a GF multiselect', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '8': ['News:5', 'Tech:12'] });
  assert.deepStrictEqual(sent(requests)['8'], ['News:5', 'Tech:12']);
});

test('create sends an empty multiselect array as an empty string', async () => {
  // GF skips an empty value before json-encoding it; an empty array would be stored raw.
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '5': [] });
  assert.strictEqual(sent(requests)['5'], '');
});

// --- bug 2: a checkbox array needs inputs to land in ---

test('create refuses a checkbox array when the field has no inputs, and writes nothing', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(
    () => client.createEntry({ form_id: 172, '4': ['p', 'q'] }),
    (error) => {
      assert.match(error.message, /field 4/);
      assert.match(error.message, /no inputs/);
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses a checkbox array when the field has no inputs key at all', async () => {
  const form = { ...FORM_172, fields: FORM_172.fields.map((f) => (f.id === 4 ? { id: 4, type: 'checkbox', choices: f.choices } : f)) };
  const { client, requests } = makeClient({ ...entryRoutes(), 'GET /forms/172': form });
  await assert.rejects(() => client.createEntry({ form_id: 172, '4': ['p'] }), /no inputs/);
  assert.strictEqual(writes(requests).length, 0);
});

test('create expands a checkbox array to its inputs and keeps commas inside values', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '7': ['Atlanta, GA', 'Boston'] });
  const body = sent(requests);
  assert.strictEqual(body['7.1'], 'Atlanta, GA');
  assert.strictEqual(body['7.2'], '');
  assert.strictEqual(body['7.3'], 'Boston');
  assert.strictEqual(body['7'], undefined);
});

test('create refuses a checkbox value that matches no choice instead of dropping it', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(
    () => client.createEntry({ form_id: 172, '7': ['Boston', 'Denver'] }),
    (error) => {
      assert.match(error.message, /Denver/);
      assert.match(error.message, /Atlanta, GA/, 'valid choices are listed');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

// --- bug 3: radio and select hold one value ---

test('create refuses an array for a radio, and writes nothing', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(() => client.createEntry({ form_id: 172, '2': ['a', 'b'] }), /field 2 \(radio\) takes a single value/);
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses an array for a select, and a one-element array too', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(() => client.createEntry({ form_id: 172, '3': ['x', 'y'] }), /field 3 \(select\) takes a single value/);
  await assert.rejects(() => client.createEntry({ form_id: 172, '3': ['x'] }), /field 3 \(select\) takes a single value/);
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses an array for a radio nested in another type via inputType', async () => {
  const form = { id: 172, fields: [{ id: 1, type: 'product', inputType: 'select', label: 'P', choices: CHOICES('a', 'b') }] };
  const { client } = makeClient({ ...entryRoutes(), 'GET /forms/172': form });
  await assert.rejects(() => client.createEntry({ form_id: 172, '1': ['a', 'b'] }), /takes a single value/);
});

test('create still takes a scalar for a radio and a select', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '2': 'a', '3': 'y' });
  assert.strictEqual(sent(requests)['2'], 'a');
  assert.strictEqual(sent(requests)['3'], 'y');
});

test('update refuses an array for a radio too', async () => {
  const { client, requests } = makeClient({
    'GET /forms/172': FORM_172,
    'GET /entries/9': { id: 9, form_id: 172, '2': 'a' },
    'PUT /entries/9': (b) => b
  });
  await assert.rejects(() => client.updateEntry({ id: 9, '2': ['a', 'b'] }), /field 2 \(radio\) takes a single value/);
  assert.strictEqual(writes(requests).length, 0);
});

// --- bug 4: the submission tools ---

const submitRoutes = () => ({
  'GET /forms/172': FORM_172,
  'POST /forms/172/submissions': { is_valid: true, entry_id: 33 },
  'POST /forms/172/submissions/validation': { is_valid: true }
});
const submitted = (requests, suffix = '') => requests.find((r) => r.method === 'POST' && r.path === `/forms/172/submissions${suffix}`).body;

test('submit refuses an array for a radio, so GF never turns it into 2_0 and 2_1', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(() => client.submitFormData({ form_id: 172, input_2: ['a', 'b'] }), /field 2 \(radio\) takes a single value/);
  assert.strictEqual(writes(requests).length, 0);
});

test('submit refuses an array for a select and for a text field', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(() => client.submitFormData({ form_id: 172, input_3: ['x', 'y'] }), /field 3 \(select\)/);
  await assert.rejects(() => client.submitFormData({ form_id: 172, input_1: ['a', 'b'] }), /field 1 \(text\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('submit passes a multiselect array through unchanged', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await client.submitFormData({ form_id: 172, input_5: ['m', 'n'] });
  assert.deepStrictEqual(submitted(requests).input_5, ['m', 'n']);
});

test('submit expands a checkbox array to the input_N_M keys GF reads', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await client.submitFormData({ form_id: 172, input_7: ['Atlanta, GA', 'Boston'] });
  const body = submitted(requests);
  assert.strictEqual(body.input_7_1, 'Atlanta, GA');
  assert.strictEqual(body.input_7_3, 'Boston');
  assert.strictEqual(body.input_7_2, undefined, 'an unchecked box is left out');
  assert.strictEqual(body.input_7, undefined);
});

test('submit refuses a checkbox array when the field has no inputs', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(() => client.submitFormData({ form_id: 172, input_4: ['p'] }), /field 4.*no inputs/);
  assert.strictEqual(writes(requests).length, 0);
});

test('submit refuses a checkbox array sent beside one of its own input keys', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(
    () => client.submitFormData({ form_id: 172, input_7: ['Boston'], input_7_1: 'Atlanta, GA' }),
    /input_7_1/
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('the validation tools apply the same rule as the submit tool', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(() => client.validateSubmission({ form_id: 172, input_2: ['a', 'b'] }), /field 2 \(radio\)/);
  await client.validateSubmission({ form_id: 172, input_7: ['Boston'] });
  assert.strictEqual(submitted(requests, '/validation').input_7_3, 'Boston');
});
