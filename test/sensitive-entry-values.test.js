/**
 * The entries API stores card data and passwords as given; a submission does not.
 *
 * Read from Gravity Forms 3.1.2 source (forms_model.php, includes/api.php, class-gf-field-creditcard.php,
 * class-gf-field-password.php), not executed against a site:
 *   - GF_Field_CreditCard::get_value_save_input() keeps the last four digits of .1 and pads the rest with X;
 *     GF_Field_Password::get_value_save_input() returns '' (unless gform_encrypt_password is on).
 *   - Its only callers are GFFormsModel::save_input() -> queue_save_input_value() and
 *     get_prepared_input_value(), reached from save_lead() (a submission or the entry editor).
 *   - GFAPI::add_entry() and update_entry() call GFAPI::queue_batch_field_operation(), which reads
 *     $entry[$input_id] and hands it to GFFormsModel::queue_batch_field_operation() unchanged. For a
 *     creditcard it loops $field->inputs (all five), not get_entry_inputs() (.1 and .4), so .2, .3 and
 *     .5 are stored too.
 * The tools therefore refuse these writes on the entry path only. The submission path is exempt:
 * it reaches save_input and masks.
 *
 * Every number below is a run of one repeated digit, never a real card or a documented test number.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';

const FAKE_NUMBER = '1111111111111111';
const FAKE_SPACED = '1111 1111 1111 1111';

const FORM = {
  id: 175,
  fields: [
    { id: 2, type: 'text', label: 'Text' },
    {
      id: 12,
      type: 'creditcard',
      label: 'Card',
      inputs: [
        { id: '12.1', label: 'Number' },
        { id: '12.2_month', label: 'Month' },
        { id: '12.2_year', label: 'Year' },
        { id: '12.3', label: 'Security' },
        { id: '12.4', label: 'Type' },
        { id: '12.5', label: 'Name' }
      ]
    },
    { id: 15, type: 'password', label: 'Password' }
  ]
};

function makeClient() {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass'
  });
  const requests = [];
  const routes = {
    'GET /forms/175': FORM,
    'GET /entries/9': { id: 9, form_id: 175, '2': 'x' },
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'PUT /entries/9': (b) => ({ ...b, id: 9 }),
    'POST /forms/175/submissions': { is_valid: true, entry_id: 33 },
    'POST /forms/175/submissions/validation': { is_valid: true }
  };
  const answer = (method) => async (path, data) => {
    requests.push({ method, path, body: method === 'GET' ? undefined : data });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    return { data: typeof route === 'function' ? route(data) : route };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  return { client, requests };
}
const writes = (requests) => requests.filter((r) => r.method !== 'GET');

// --- a full card number is refused, on create and update ---

test('create refuses a full card number under the card number input, and sends nothing', async () => {
  const { client, requests } = makeClient();
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '12.1': FAKE_NUMBER }),
    (error) => {
      assert.match(error.message, /12\.1/);
      assert.match(error.message, /unmasked/);
      assert.match(error.message, /only masks .*submitted/i);
      assert.match(error.message, /gf_submit_form_data/);
      assert.match(error.message, /last four/);
      assert.ok(!error.message.includes(FAKE_NUMBER), 'the refusal never repeats the number it was given');
      return true;
    }
  );
  assert.strictEqual(writes(requests).length, 0);
});

test('create refuses a spaced number, a number sent as a JSON number, and the underscore spelling', async () => {
  for (const data of [{ '12.1': FAKE_SPACED }, { '12.1': Number(FAKE_NUMBER) }, { '12_1': FAKE_NUMBER }]) {
    const { client, requests } = makeClient();
    await assert.rejects(() => client.createEntry({ form_id: 175, ...data }), /unmasked/);
    assert.strictEqual(writes(requests).length, 0);
  }
});

test('update refuses a full card number, and sends no PUT', async () => {
  const { client, requests } = makeClient();
  await assert.rejects(() => client.updateEntry({ id: 9, '12.1': FAKE_NUMBER }), /unmasked/);
  assert.strictEqual(writes(requests).length, 0);
});

// --- an already-masked value is allowed; the test is a whitelist, not a digit count ---

test('create accepts values that are a mask plus at most four trailing digits, and empty', async () => {
  for (const value of ['XXXXXXXXXXXX1111', 'XXXX-XXXX-XXXX-1111', '************1111', 'xxxxxxxxxxxx1111', '1111', 'XXXXXXXXXXXXXXXX', '', null]) {
    const { client, requests } = makeClient();
    await client.createEntry({ form_id: 175, '12.1': value });
    assert.strictEqual(writes(requests).length, 1, `accepted ${JSON.stringify(value)}`);
  }
});

test('create refuses values that only look masked', async () => {
  const tricks = [
    'XXXXXXXX11111111',        // eight trailing digits
    '1111XXXXXXXX1111',        // digits at the front
    'XXXX1111XXXX1111',        // digits in the middle
    '１１１１１１１１', // full-width digits, not ASCII
    'XXXXXXXXXXXX11111',       // five trailing digits
    'XXXXXXXXXXXXone1',        // letters that are not the mask
    ' 1111111111111111'        // leading space
  ];
  for (const value of tricks) {
    const { client, requests } = makeClient();
    await assert.rejects(() => client.createEntry({ form_id: 175, '12.1': value }), /unmasked|mask/, `refused ${JSON.stringify(value)}`);
    assert.strictEqual(writes(requests).length, 0);
  }
});

// --- the other inputs: GFAPI stores them, a submission never does ---

test('create refuses a security code, expiration and cardholder name', async () => {
  for (const key of ['12.3', '12.2_month', '12.2_year', '12.5']) {
    const { client, requests } = makeClient();
    await assert.rejects(
      () => client.createEntry({ form_id: 175, '2': 'x', [key]: '000' }),
      (error) => {
        assert.match(error.message, new RegExp(key.replace('.', '\\.')));
        assert.match(error.message, /never stores|does not store/i);
        return true;
      },
      key
    );
    assert.strictEqual(writes(requests).length, 0);
  }
});

test('create accepts an empty value for those inputs, and the card type under .4', async () => {
  const { client, requests } = makeClient();
  await client.createEntry({ form_id: 175, '12.3': '', '12.5': null, '12.4': 'Visa' });
  assert.strictEqual(writes(requests).length, 1);
});

test('one refusal lists every offending input', async () => {
  const { client } = makeClient();
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '12.1': FAKE_NUMBER, '12.3': '000' }),
    (error) => /12\.1/.test(error.message) && /12\.3/.test(error.message)
  );
});

// --- passwords ---

test('create and update refuse a non-empty password value; empty passes', async () => {
  const { client, requests } = makeClient();
  await assert.rejects(
    () => client.createEntry({ form_id: 175, '15': 'hunter2-not-real' }),
    (error) => {
      assert.match(error.message, /field 15 \(password\)/);
      assert.match(error.message, /plain text/);
      assert.ok(!error.message.includes('hunter2-not-real'));
      return true;
    }
  );
  await assert.rejects(() => client.updateEntry({ id: 9, '15': 'hunter2-not-real' }), /field 15 \(password\)/);
  assert.strictEqual(writes(requests).length, 0);
  await client.createEntry({ form_id: 175, '15': '' });
  assert.strictEqual(writes(requests).length, 1);
});

// --- not over-reaching ---

test('a long digit string in an ordinary field is untouched', async () => {
  const { client, requests } = makeClient();
  await client.createEntry({ form_id: 175, '2': FAKE_NUMBER });
  assert.strictEqual(writes(requests).length, 1);
});

test('the submission tools still pass a full number: a submission masks it in GF', async () => {
  const { client, requests } = makeClient();
  await client.submitFormData({ form_id: 175, input_12_1: FAKE_NUMBER, input_12_3: '000', input_15: 'hunter2-not-real' });
  await client.validateSubmission({ form_id: 175, input_12_1: FAKE_NUMBER });
  await client.validateForm({ form_id: 175, input_12_1: FAKE_NUMBER });
  const posts = writes(requests);
  assert.strictEqual(posts.length, 3);
  assert.strictEqual(posts[0].body.input_12_1, FAKE_NUMBER, 'sent as given');
});
