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
 *   a checkbox made through the API has choices and no inputs.
 *
 * Assertions read the wire through the recorded requests.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { FieldManager } from '../src/field-operations/field-manager.js';
import FieldAwareValidator from '../src/config/field-validation.js';
import { fieldRegistry, generateCheckboxInputs, reconcileCheckboxInputs } from '../src/field-definitions/field-registry.js';

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

// --- bug 5: checkbox inputs ---

test('generateCheckboxInputs numbers inputs as the form editor does and skips multiples of ten', () => {
  const inputs = generateCheckboxInputs({ id: 4, type: 'checkbox', choices: CHOICES('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k') });
  assert.deepStrictEqual(inputs.slice(0, 2), [{ id: '4.1', label: 'a', name: '' }, { id: '4.2', label: 'b', name: '' }]);
  assert.deepStrictEqual(inputs.map((i) => i.id).slice(8), ['4.9', '4.11', '4.12']);
});

test('generateCheckboxInputs leaves other types, choiceless fields and persistent-choice types alone', () => {
  assert.strictEqual(generateCheckboxInputs({ id: 1, type: 'radio', choices: CHOICES('a') }), null);
  assert.strictEqual(generateCheckboxInputs({ id: 1, type: 'checkbox', choices: [] }), null);
  assert.strictEqual(generateCheckboxInputs({ id: 1, type: 'checkbox' }), null);
  // multi_choice and image_choice key inputs by a per-choice `key`, which is not ours to invent.
  assert.strictEqual(generateCheckboxInputs({ id: 1, type: 'multi_choice', inputType: 'checkbox', choices: CHOICES('a') }), null);
});

test('generateCheckboxInputs reads inputType: an option, quiz or survey field set to checkbox', () => {
  for (const type of ['option', 'quiz', 'poll', 'survey']) {
    const inputs = generateCheckboxInputs({ id: 3, type, inputType: 'checkbox', choices: CHOICES('a', 'b') });
    assert.deepStrictEqual(inputs.map((i) => i.id), ['3.1', '3.2'], type);
  }
});

const postedForm = (requests) => requests.find((r) => r.method === 'POST' && r.path === '/forms').body;

test('gf_create_form gives a new checkbox its inputs', async () => {
  const { client, requests } = makeClient({ 'POST /forms': (b) => ({ ...b, id: 1 }) });
  await client.createForm({ title: 'T', fields: [{ id: 1, type: 'checkbox', label: 'C', choices: CHOICES('p', 'q') }] });
  assert.deepStrictEqual(postedForm(requests).fields[0].inputs, [{ id: '1.1', label: 'p', name: '' }, { id: '1.2', label: 'q', name: '' }]);
});

test('gf_create_form keeps inputs the caller supplied, and leaves a radio without any', async () => {
  const supplied = [{ id: '1.1', label: 'p' }, { id: '1.3', label: 'q' }];
  const { client, requests } = makeClient({ 'POST /forms': (b) => ({ ...b, id: 1 }) });
  await client.createForm({
    title: 'T',
    fields: [
      { id: 1, type: 'checkbox', label: 'C', choices: CHOICES('p', 'q'), inputs: supplied },
      { id: 2, type: 'radio', label: 'R', choices: CHOICES('a', 'b') }
    ]
  });
  const fields = postedForm(requests).fields;
  assert.deepStrictEqual(fields[0].inputs, supplied);
  assert.strictEqual(fields[1].inputs, undefined);
});

test('gf_update_form gives inputs to a checkbox the call adds and leaves a stored one alone', async () => {
  const stored = { id: 1, type: 'checkbox', label: 'Old', choices: CHOICES('p', 'q'), inputs: [] };
  const { client, requests } = makeClient({
    'GET /forms/9': { id: 9, title: 'T', fields: [stored] },
    'PUT /forms/9': (b) => b
  });
  await client.updateForm({
    id: 9,
    fields: [stored, { id: 2, type: 'checkbox', label: 'New', choices: CHOICES('x', 'y') }]
  });
  const fields = requests.find((r) => r.method === 'PUT').body.fields;
  assert.deepStrictEqual(fields[0].inputs, [], 'a stored field round-trips: its inputs decide where saved values are read');
  assert.deepStrictEqual(fields[1].inputs.map((i) => i.id), ['2.1', '2.2']);
});

test('gf_add_field gives a new checkbox its inputs and keeps supplied ones', async () => {
  const api = {
    getForm: async () => ({ form: { id: 1, title: 'T', fields: [{ id: 1, type: 'text', label: 'Name' }] } }),
    replaceForm: async (formId, form) => ({ form }),
    allowDelete: true
  };
  const manager = new FieldManager(api, fieldRegistry, new FieldAwareValidator());

  const generated = await manager.addField(1, 'checkbox', { label: 'C', choices: CHOICES('p', 'q') });
  assert.deepStrictEqual(generated.field.inputs, [
    { id: `${generated.field.id}.1`, label: 'p', name: '' },
    { id: `${generated.field.id}.2`, label: 'q', name: '' }
  ]);

  const supplied = await manager.addField(1, 'checkbox', { label: 'C', choices: CHOICES('p', 'q'), inputs: [{ id: '5.1', label: 'p' }, { id: '5.3', label: 'q' }] });
  assert.deepStrictEqual(supplied.field.inputs.map((i) => i.id), [`${supplied.field.id}.1`, `${supplied.field.id}.3`]);
});

test('gf_update_form accepts a stored checkbox sent back with an inputs list, the repair the entry error names', async () => {
  const stored = { id: 1, type: 'checkbox', label: 'Old', choices: CHOICES('p', 'q'), inputs: [] };
  const repaired = { ...stored, inputs: [{ id: '1.1', label: 'p', name: '' }, { id: '1.2', label: 'q', name: '' }] };
  const { client, requests } = makeClient({
    'GET /forms/9': { id: 9, title: 'T', fields: [stored] },
    'PUT /forms/9': (b) => b
  });
  await client.updateForm({ id: 9, fields: [repaired] });
  assert.deepStrictEqual(requests.find((r) => r.method === 'PUT').body.fields[0].inputs, repaired.inputs);
});


// --- a scalar under a checkbox's own key: GF reads a checkbox only from its inputs ---
// Field 7 has non-empty inputs AND choices and resolves to checkbox; field 2 (radio) has
// choices and no inputs. A guard keyed off "has choices" refuses the radio too, so the
// radio control below is what proves the checkbox check is on the resolved type.

test('create refuses a scalar under a checkbox key and names the input spelling and the array', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(
    () => client.createEntry({ form_id: 172, '7': 'Boston' }),
    (error) => {
      assert.match(error.message, /field 7 \(checkbox\)/);
      assert.match(error.message, /7\.1, 7\.2, 7\.3/);
      assert.match(error.message, /"7\.3": "Boston"/, 'names the input spelling');
      assert.match(error.message, /\["Boston"\]/, 'names the array spelling');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses a scalar under a checkbox that has no inputs, with the repair that error names', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await assert.rejects(() => client.createEntry({ form_id: 172, '4': 'p' }), /field 4.*no inputs/);
  assert.strictEqual(writes(requests).length, 0);
});

test('update refuses a scalar under a checkbox key', async () => {
  const { client, requests } = makeClient({
    'GET /forms/172': FORM_172,
    'GET /entries/9': { id: 9, form_id: 172 },
    'PUT /entries/9': (b) => b
  });
  await assert.rejects(() => client.updateEntry({ id: 9, '7': 'Boston' }), /field 7 \(checkbox\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('submit refuses a scalar under input_N of a checkbox, and the validation tool does too', async () => {
  const { client, requests } = makeClient(submitRoutes());
  await assert.rejects(() => client.submitFormData({ form_id: 172, input_7: 'Boston' }), /field 7 \(checkbox\)/);
  await assert.rejects(() => client.validateSubmission({ form_id: 172, input_7: 'Boston' }), /field 7 \(checkbox\)/);
  assert.strictEqual(writes(requests).length, 0);
});

test('a scalar under a checkbox is refused when the checkbox comes from inputType', async () => {
  // An option field set to checkbox: type is `option`, only inputType says checkbox.
  const form = { id: 50, fields: [{ id: 1, type: 'option', inputType: 'checkbox', label: 'O', choices: CHOICES('a', 'b'), inputs: [{ id: '1.1', label: 'a' }, { id: '1.2', label: 'b' }] }] };
  const { client } = makeClient({ 'GET /forms/50': form, 'POST /entries': (b) => ({ ...b, id: 1 }), 'GET /entries/1': { id: 1, form_id: 50 } });
  await assert.rejects(() => client.createEntry({ form_id: 50, '1': 'a' }), /field 1 \(checkbox\)/);
});

test('a checkbox still takes an input key, an array, and an empty value', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '7.3': 'Boston' });
  assert.strictEqual(sent(requests)['7.3'], 'Boston');
  await client.createEntry({ form_id: 172, '7': ['Boston'] });
  await client.createEntry({ form_id: 172, '7': '' });
});

test('a scalar for a radio, a select and a text field is still accepted', async () => {
  const { client, requests } = makeClient(entryRoutes());
  await client.createEntry({ form_id: 172, '1': 'Ada', '2': 'a', '3': 'x' });
  assert.deepStrictEqual([sent(requests)['1'], sent(requests)['2'], sent(requests)['3']], ['Ada', 'a', 'x']);
});

// --- changing a checkbox's choices: inputs follow, as the form editor does ---
// GF numbers a checkbox's inputs by choice position (the editor regenerates them from
// scratch, SetFieldCheckboxInputs; the renderer counts positions too,
// class-gf-field-checkbox.php:415). The fixture is a NON-persistent checkbox with inputs
// that line up with its choices, so a stale-inputs result is the thing under test.

const stale = () => ({ id: 4, type: 'checkbox', label: 'C', choices: CHOICES('r', 's'), inputs: [{ id: '4.1', label: 'r', name: '' }, { id: '4.2', label: 's', name: '' }] });

function managerFor(field, extra = []) {
  const form = { id: 1, title: 'T', fields: [field, ...extra] };
  const api = { getForm: async () => ({ form: JSON.parse(JSON.stringify(form)) }), replaceForm: async (formId, f) => ({ form: f }), allowDelete: true };
  return new FieldManager(api, fieldRegistry, new FieldAwareValidator());
}
const inputIds = (field) => field.inputs.map((i) => i.id);

test('gf_update_field gives an added choice its input (form 173: 3 choices, 2 inputs)', async () => {
  const result = await managerFor(stale()).updateField(1, 4, { choices: CHOICES('r', 's', 't') }, { force: true });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.2', '4.3']);
  assert.strictEqual(result.field.inputs[2].label, 't');
  assert.deepStrictEqual(result.warnings.inputs, [], 'appending moves nothing, so there is nothing to warn about');
});

test('gf_update_field skips a multiple of ten when a choice lands on position ten', async () => {
  const nine = { ...stale(), choices: CHOICES(...'abcdefghi'.split('')), inputs: generateCheckboxInputs({ id: 4, type: 'checkbox', choices: CHOICES(...'abcdefghi'.split('')) }) };
  const result = await managerFor(nine).updateField(1, 4, { choices: CHOICES(...'abcdefghij'.split('')) }, { force: true });
  assert.strictEqual(inputIds(result.field)[9], '4.11');
});

test('gf_update_field drops the input of a removed choice and warns that later choices moved', async () => {
  const three = { ...stale(), choices: CHOICES('r', 's', 't'), inputs: generateCheckboxInputs({ id: 4, type: 'checkbox', choices: CHOICES('r', 's', 't') }) };
  const result = await managerFor(three).updateField(1, 4, { choices: CHOICES('r', 't') }, { force: true });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.2']);
  const warning = result.warnings.inputs.join(' ');
  assert.match(warning, /"s"/, 'names the removed choice');
  assert.match(warning, /"t"/, 'names the choice that moved');
  assert.match(warning, /4\.2/);
});

test('gf_update_field warns about a reordered checkbox', async () => {
  const result = await managerFor(stale()).updateField(1, 4, { choices: CHOICES('s', 'r') }, { force: true });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.2']);
  assert.match(result.warnings.inputs.join(' '), /"r".*"s"|"s".*"r"/);
});

test('gf_update_field renaming a choice relabels its input without moving it or warning', async () => {
  const result = await managerFor(stale()).updateField(1, 4, { choices: [{ text: 'R!', value: 'r' }, { text: 'S', value: 's' }] }, { force: true });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.2']);
  assert.strictEqual(result.field.inputs[0].label, 'R!');
  assert.deepStrictEqual(result.warnings.inputs, []);
});

test('gf_update_field keeps inputs the same call supplies', async () => {
  const supplied = [{ id: '4.1', label: 'r' }, { id: '4.5', label: 's' }, { id: '4.7', label: 't' }];
  const result = await managerFor(stale()).updateField(1, 4, { choices: CHOICES('r', 's', 't'), inputs: supplied }, { force: true });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.5', '4.7']);
});

test('gf_update_field leaves inputs alone when the call does not touch choices', async () => {
  const gapped = { ...stale(), inputs: [{ id: '4.1', label: 'r' }, { id: '4.3', label: 's' }] };
  const result = await managerFor(gapped).updateField(1, 4, { label: 'Renamed' });
  assert.deepStrictEqual(inputIds(result.field), ['4.1', '4.3']);
});

test('gf_update_field leaves a radio, and a persistent-choice checkbox, without generated inputs', async () => {
  const radio = { id: 2, type: 'radio', label: 'R', choices: CHOICES('a') };
  const radioResult = await managerFor(radio).updateField(1, 2, { choices: CHOICES('a', 'b') }, { force: true });
  assert.strictEqual(radioResult.field.inputs, undefined);

  const keyed = { id: 3, type: 'image_choice', inputType: 'checkbox', label: 'I', choices: [{ text: 'a', value: 'a', key: 'ka' }], inputs: [{ id: '3.1', label: 'a', key: 'ka' }] };
  const keyedResult = await managerFor(keyed).updateField(1, 3, { choices: [{ text: 'a', value: 'a', key: 'ka' }, { text: 'b', value: 'b', key: 'kb' }] }, { force: true });
  assert.deepStrictEqual(inputIds(keyedResult.field), ['3.1'], 'inputs matched to choices by key are not renumbered');
});

test('gf_update_form regenerates a stored checkbox whose choices changed and warns', async () => {
  const three = CHOICES('r', 's', 't');
  const { client, requests } = makeClient({
    'GET /forms/9': { id: 9, title: 'T', fields: [stale()] },
    'PUT /forms/9': (b) => b
  });
  const result = await client.updateForm({ id: 9, fields: [{ ...stale(), choices: three }] });
  const put = requests.find((r) => r.method === 'PUT').body.fields[0];
  assert.deepStrictEqual(put.inputs.map((i) => i.id), ['4.1', '4.2', '4.3']);
  assert.strictEqual(result.warning, undefined, 'appending moves nothing');

  const removed = await makeClient({
    'GET /forms/9': { id: 9, title: 'T', fields: [{ ...stale(), choices: three, inputs: generateCheckboxInputs({ id: 4, type: 'checkbox', choices: three }) }] },
    'PUT /forms/9': (b) => b
  }).client.updateForm({ id: 9, fields: [{ ...stale(), choices: CHOICES('r', 't'), inputs: generateCheckboxInputs({ id: 4, type: 'checkbox', choices: three }) }] });
  assert.match(removed.warning, /field 4.*"s"/);
});

test('gf_update_form keeps a stored checkbox byte-for-byte when its choices did not change, or when it sends its own inputs', async () => {
  const gapped = { ...stale(), inputs: [{ id: '4.1', label: 'r' }, { id: '4.3', label: 's' }] };
  const { client, requests } = makeClient({ 'GET /forms/9': { id: 9, title: 'T', fields: [gapped] }, 'PUT /forms/9': (b) => b });
  await client.updateForm({ id: 9, fields: [gapped] });
  assert.deepStrictEqual(requests.find((r) => r.method === 'PUT').body.fields[0].inputs.map((i) => i.id), ['4.1', '4.3']);

  const own = [{ id: '4.1', label: 'r' }, { id: '4.2', label: 's' }, { id: '4.11', label: 't' }];
  const second = makeClient({ 'GET /forms/9': { id: 9, title: 'T', fields: [stale()] }, 'PUT /forms/9': (b) => b });
  await second.client.updateForm({ id: 9, fields: [{ ...stale(), choices: CHOICES('r', 's', 't'), inputs: own }] });
  assert.deepStrictEqual(second.requests.find((r) => r.method === 'PUT').body.fields[0].inputs.map((i) => i.id), ['4.1', '4.2', '4.11']);
});

test('reconcileCheckboxInputs reports nothing for a field that is not a checkbox', () => {
  const radio = { id: 2, type: 'radio', choices: CHOICES('a') };
  const { field, warning } = reconcileCheckboxInputs(radio, { ...radio, choices: CHOICES('a', 'b') });
  assert.strictEqual(field.inputs, undefined);
  assert.strictEqual(warning, null);
});
