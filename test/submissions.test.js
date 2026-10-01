/**
 * Submissions and Notifications Tests for Gravity MCP
 * Tests form submission workflow, validation, and notifications
 */

import GravityFormsClient from '../src/gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment
} from './helpers.js';

const suite = new TestRunner('Submissions and Notifications Tests');

let client;
let mockHttpClient;
let testEnv;

suite.beforeEach(() => {
  testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();

  client = new GravityFormsClient(testEnv);
  client.httpClient = mockHttpClient;

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
});

// =================================
// SUBMIT FORM DATA TESTS
// =================================

suite.test('Submit Form: Should submit form successfully', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    entry_id: 500,
    confirmation_message: '<p>Thank you for your submission!</p>',
    validation_messages: {}
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'John Doe',
    input_2: 'john@example.com',
    input_3: 'This is my message'
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 500);
  TestAssert.includes(result.confirmation_message, 'Thank you');
});

suite.test('Submit Form: Should handle validation errors', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      '1': 'Name is required',
      '2': 'Please enter a valid email address'
    }
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_3: 'Only message provided'
  });

  TestAssert.isFalse(result.success);
  TestAssert.equal(result.validation_messages['1'], 'Name is required');
});

suite.test('Submit Form: sends input_N values and no field_values', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    entry_id: 600
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'Jane Smith',
    input_2: 'jane@example.com'
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 600);

  const body = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(body.input_1, 'Jane Smith');
  TestAssert.equal(body.field_values, undefined, 'field_values must never ride to GF');
});

suite.test('Submit Form: rejects a field_values OBJECT', async () => {
  // GF 400s an object here (rest_is_array); refuse it up front.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, field_values: { '1': 'x' } }),
    'field_values',
    'object field_values must be rejected'
  );
});

suite.test('Submit Form: rejects a field_values JSON STRING (a serialized object)', async () => {
  // A serialized object satisfies GF's declared ['string','array'] type, so the
  // object guard above does not see it. GF reads it as a query string with no
  // pairs: the submission succeeds having populated nothing.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: '{"1": "Ada"}' }),
    'field_values',
    'a JSON-string field_values must be rejected'
  );
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: '["Ada"]' }),
    'field_values',
    'a serialized array must be rejected too'
  );
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: '  {"1": "Ada"}' }),
    'field_values',
    'leading whitespace must not hide a serialized object'
  );
});

suite.test('Submit Form: refuses a plain query string and an array field_values too', async () => {
  // Every shape is inert on GF's API path, so a query string is refused like the
  // JSON shapes above instead of being accepted and ignored. Nothing is sent.
  const before = mockHttpClient.getRequests().length;
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: 'p1=a&p2=b' }),
    'does nothing',
    'a query-string field_values must be refused'
  );
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: 'tags[]=a&tags[]=b' }),
    'input_N',
    'the refusal points at input_N keys'
  );
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: ['a'] }),
    'does nothing',
    'an array field_values must be refused'
  );
  TestAssert.equal(mockHttpClient.getRequests().length, before, 'no request may be sent');
});

suite.test('Submit Form: rejects a submission carrying no input_N key', async () => {
  // GF answers an empty submission by naming whichever field is required, not
  // the missing values.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1 }),
    'no field values were given',
    'a submission with no field values must be rejected'
  );
  // Page navigation keys are not field values.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, source_page_number: 1, target_page_number: 2 }),
    'no field values were given',
    'page numbers alone are not a submission'
  );
});

suite.test('Validate Submission / Validate Form: still accept a submission with no input_N key', async () => {
  // Checking what a form does with nothing is what these tools are for.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false, validation_messages: { '1': 'This field is required.' }, page_number: 1
  }, 400));
  const viaSubmission = await client.validateSubmission({ form_id: 1 });
  TestAssert.isFalse(viaSubmission.valid, 'gf_validate_submission must reach GF with no values');
  TestAssert.equal(viaSubmission.validation_messages['1'], 'This field is required.');
  const viaForm = await client.validateForm({ form_id: 1 });
  TestAssert.isFalse(viaForm.valid, 'gf_validate_form must reach GF with no values');
  TestAssert.equal(mockHttpClient.getRequests().filter(r => r.method === 'POST').length, 2,
    'both empty validations must be sent');
});

suite.test('Submit Form: a field_values JSON string is refused before the empty-submission check', async () => {
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, field_values: '{"1": "Ada"}' }),
    'field_values',
    'the field_values mistake must be named, not the missing input_N keys'
  );
});

suite.test('Submit Form: accepts the form id under either name', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 8, confirmation_message: 'ok'
  }));
  const viaId = await client.submitFormData({ id: 1, input_1: 'x' });
  TestAssert.equal(viaId.entry_id, 8, 'id must work where form_id is documented');
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.isFalse('id' in sent, 'the alias must not reach GF as a stray body key');
  await TestAssert.throwsAsync(
    () => client.submitFormData({ id: 5, form_id: 9, input_1: 'x' }),
    'disagree',
    'two different ids must be rejected rather than silently picking one'
  );
});

suite.test('Submit Form: the same id under both names is one id, however it is spelled', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 8, confirmation_message: 'ok'
  }));
  const asNumberAndString = await client.submitFormData({ id: '1', form_id: 1, input_1: 'x' });
  TestAssert.equal(asNumberAndString.entry_id, 8, '"1" and 1 are the same id');
  const withLeadingZero = await client.submitFormData({ id: '01', form_id: 1, input_1: 'x' });
  TestAssert.equal(withLeadingZero.entry_id, 8, '"01" and 1 are the same id');
  await TestAssert.throwsAsync(
    () => client.submitFormData({ id: 0, form_id: 1, input_1: 'x' }),
    'positive integer',
    'an invalid alias is reported as invalid, not as a disagreement'
  );
});

suite.test('Submit Form: keeps a multiselect value an array', async () => {
  // Multiselect and checkbox values go to GF as an array: once joined, a comma
  // inside a value ("Atlanta, GA") is indistinguishable from a separator.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 9, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, input_3: ['Atlanta, GA', 'Austin, TX'] });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.deepEqual(sent.input_3, ['Atlanta, GA', 'Austin, TX'],
    'an array value must reach GF as an array');
});

suite.test('Submit Form: sends a formatted phone object as the JSON string GF decodes', async () => {
  // GF decodes a "formatted" phone only from a JSON string; an object arrives as
  // a PHP array and fails validation.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 10, confirmation_message: 'ok'
  }));
  const phone = { country: 'us', national: '(555) 123-4567', formatted: '+1 555 123 4567', e164: '+15551234567' };
  await client.submitFormData({ form_id: 1, input_4: phone });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(typeof sent.input_4, 'string', 'an object value must reach GF as a string');
  TestAssert.deepEqual(JSON.parse(sent.input_4), phone, 'the string must decode to the object given');
});

suite.test('Submit Form: stringifies scalars inside an array and keeps nested arrays', async () => {
  // A list field is an array of rows; a row of several columns is itself an array.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 10, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, input_3: [1, true, ['a', 'b']] });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.deepEqual(sent.input_3, ['1', 'true', ['a', 'b']], 'array entries are coerced the way top-level scalars are');
});

suite.test('Submit Form: sends null as an empty value, not the text "null"', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 10, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, input_1: null, input_3: [null, 'x'] });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(sent.input_1, '', 'a null scalar is an empty value');
  TestAssert.deepEqual(sent.input_3, ['', 'x'], 'a null array entry is an empty value');
});

suite.test('Submit Form: still stringifies scalar values', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 11, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, input_1: 42, input_2: true });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(sent.input_1, '42', 'a number must still be coerced to a string');
  TestAssert.equal(sent.input_2, 'true', 'a boolean must still be coerced to a string');
});

suite.test('Submit Form: accepts GF abilities dot notation for sub-inputs', async () => {
  // GF's abilities layer documents sub-inputs as input_5.3; GFAPI::submit_form,
  // which the REST endpoint calls, reads only input_5_3 (its docblock:
  // $input_values['input_2_6']).
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 12, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, 'input_5.3': 'Ada', 'input_5.6': 'Lovelace' });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(sent.input_5_3, 'Ada', 'dot notation must be normalized to underscore');
  TestAssert.equal(sent.input_5_6, 'Lovelace', 'every dotted sub-input must be normalized');
  TestAssert.isFalse('input_5.3' in sent, 'the dotted key must not also be sent');
});

suite.test('Submit Form: both spellings of one sub-input must agree', async () => {
  // GF keeps whichever spelling it sees last, so a contradiction is refused
  // here. The same value under both is one value.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, 'input_5.3': 'Ada', input_5_3: 'Grace' }),
    'disagree',
    'two values for one input must not be resolved by key order'
  );
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_5_3: 'Grace', 'input_5.3': 'Ada' }),
    'disagree',
    'the refusal must not depend on which spelling comes first'
  );
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 12, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, 'input_5.3': 'Ada', input_5_3: 'Ada' });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(sent.input_5_3, 'Ada', 'agreeing spellings collapse to the underscore key');
  TestAssert.isFalse('input_5.3' in sent, 'the dotted spelling must not also be sent');
});

suite.test('Submit Form: id alias, dot notation and an array value in one call', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 13, confirmation_message: 'ok'
  }));
  const result = await client.submitFormData({ id: 1, 'input_5.3': 'Ada', input_3: ['Atlanta, GA', 'Austin, TX'] });
  TestAssert.equal(result.entry_id, 13, 'the call must reach /forms/1/submissions');
  const req = mockHttpClient.getRequests().find(r => r.method === 'POST');
  TestAssert.equal(req.path, '/forms/1/submissions');
  TestAssert.deepEqual(Object.keys(req.config.data).sort(), ['input_3', 'input_5_3'],
    'the body carries exactly the normalized inputs: no id, no form_id, no dotted key');
  TestAssert.deepEqual(req.config.data.input_3, ['Atlanta, GA', 'Austin, TX']);
});

// --- input_N keys must name a field on the form ---
//
// GF merges the body into $_POST and reads the keys it knows (api.php hydrate_post),
// so an input_99 on a form with no field 99 is read by nothing: the submission
// validates and the value is gone. Non-input_ keys (gform_save, state_N, …) are real
// controls and pass through; input_3_other is not a field input and is not checked.

const INPUT_FORM = {
  id: 1,
  fields: [
    { id: 1, type: 'text' },
    { id: 3, type: 'text' },
    {
      id: 5,
      type: 'checkbox',
      choices: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }],
      inputs: [{ id: '5.1', label: 'A' }, { id: '5.2', label: 'B' }]
    },
    { id: 9, type: 'repeater', fields: [{ id: 10, type: 'text' }] }
  ]
};

const formFetches = () => mockHttpClient.getRequests().filter(r => r.method === 'GET' && r.path === '/forms/1');
const submissionPosts = () => mockHttpClient.getRequests().filter(r => r.method === 'POST');

function mockInputForm() {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(INPUT_FORM));
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({ is_valid: true, entry_id: 70 }));
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({ is_valid: true }));
}

suite.test('Input keys: input_99 on a form with no field 99 is refused by all three tools, and nothing is POSTed', async () => {
  for (const method of ['submitFormData', 'validateSubmission', 'validateForm']) {
    mockHttpClient.clearRequests();
    mockInputForm();
    await TestAssert.throwsAsync(
      () => client[method]({ form_id: 1, input_1: 'Ada', input_99: 'ghost' }),
      'field 99 does not exist on form 1',
      `${method} must refuse a value for a field the form does not have`
    );
    TestAssert.equal(submissionPosts().length, 0, `${method} must not POST after a refusal`);
  }
});

suite.test('Input keys: the refusal says what Gravity Forms does with the key, per tool', async () => {
  mockInputForm();
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', input_99: 'x' }),
    'nothing would be stored for it'
  );
  await TestAssert.throwsAsync(
    () => client.validateSubmission({ form_id: 1, input_1: 'x', input_99: 'x' }),
    'nothing would be validated for it'
  );
  await TestAssert.throwsAsync(
    () => client.validateForm({ form_id: 1, input_1: 'x', input_99: 'x' }),
    'nothing would be validated for it'
  );
});

suite.test('Input keys: a sub-input the field does not list is refused, in either spelling', async () => {
  for (const key of ['input_5_9', 'input_5.9']) {
    mockInputForm();
    await TestAssert.throwsAsync(
      () => client.submitFormData({ form_id: 1, [key]: 'A' }),
      'input 5.9 does not exist on field 5',
      `${key} names no input of the checkbox`
    );
  }
});

suite.test('Input keys: input_1 and input_5_1 (a listed checkbox input) are accepted and sent', async () => {
  mockInputForm();
  await client.submitFormData({ form_id: 1, input_1: 'Ada', input_5_1: 'A', 'input_5.2': 'B' });
  const sent = submissionPosts()[0].config.data;
  TestAssert.equal(sent.input_1, 'Ada');
  TestAssert.equal(sent.input_5_1, 'A');
  TestAssert.equal(sent.input_5_2, 'B');
});

suite.test('Input keys: a field nested in a repeater counts as a field of the form', async () => {
  mockInputForm();
  await client.submitFormData({ form_id: 1, input_10: ['x'] });
  TestAssert.equal(submissionPosts().length, 1, 'a repeater child is a real field and must not be refused');
});

suite.test('Input keys: input_3_other alone triggers no form fetch and is not refused', async () => {
  mockInputForm();
  await client.submitFormData({ form_id: 1, input_3_other: 'Something else' });
  TestAssert.equal(formFetches().length, 0, 'a key that is not a field input needs no form');
  TestAssert.equal(submissionPosts()[0].config.data.input_3_other, 'Something else');
});

suite.test('Input keys: input_3_other beside a checked key passes through untouched', async () => {
  mockInputForm();
  await client.submitFormData({ form_id: 1, input_1: 'Ada', input_3_other: 'x', gform_save: true });
  const sent = submissionPosts()[0].config.data;
  TestAssert.equal(sent.input_3_other, 'x');
  TestAssert.equal(sent.gform_save, true, 'non-input_ controls are not restricted');
});

suite.test('Input keys: the form is fetched at most once per call, however many keys', async () => {
  for (const method of ['submitFormData', 'validateSubmission', 'validateForm']) {
    mockHttpClient.clearRequests();
    mockInputForm();
    await client[method]({ form_id: 1, input_1: 'a', input_3: 'b', input_5_1: 'A', input_5_2: 'B' });
    TestAssert.equal(formFetches().length, 1, `${method} must read the form once`);
  }
});

suite.test('Input keys: a form that returns no fields cannot be checked, so the call goes through', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse({ id: 1 }));
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({ is_valid: true, entry_id: 71 }));
  const result = await client.submitFormData({ form_id: 1, input_99: 'x' });
  TestAssert.equal(result.entry_id, 71);
});

suite.test('Submit Form: Should handle multi-page form submission', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    page_number: 2,
    source_page_number: 1,
    is_last_page: false,
    confirmation_message: ''
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'Page 1 data',
    source_page_number: 1,
    target_page_number: 2
  });

  // Multi-page progression doesn't complete submission
  TestAssert.isTrue(result.success);
  TestAssert.isNull(result.entry_id || null);
});

suite.test('Submit Form: Should handle file upload fields', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    entry_id: 700,
    uploaded_files: {
      'input_5': 'https://example.com/uploads/file.pdf'
    }
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'John',
    input_5: 'file.pdf' // File upload field
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 700);
});

suite.test('Submit Form: Should handle conditional logic', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    entry_id: 800,
    evaluated_conditional_logic: {
      '3': { is_visible: false },
      '4': { is_visible: true }
    }
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'trigger_value',
    input_4: 'Conditional field shown'
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 800);
});

suite.test('Submit Form: Should require form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.submitFormData({ input_1: 'Test' }),
    'form_id is required',
    'Should require form_id'
  );
});

// =================================
// VALIDATE SUBMISSION TESTS
// =================================

suite.test('Validate Submission: posts to the dedicated /validation route (never the submit route)', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: true,
    validation_messages: {},
    page_number: 0
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_1: 'John Doe',
    input_2: 'john@example.com'
  });

  // The crux of the P0: GF ignores a body validation_only flag and a POST to
  // /submissions REALLY submits. Validation must hit /submissions/validation.
  const req = mockHttpClient.getRequests().find(r => r.method === 'POST');
  TestAssert.equal(req.path, '/forms/1/submissions/validation');
  TestAssert.isFalse('validation_only' in (req.config.data || {}), 'must not send a validation_only flag');
  TestAssert.isTrue(result.valid);
});

suite.test('Validate Submission: surfaces validation_messages + page_number, not a phantom field_errors', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false,
    validation_messages: {
      '2': 'Email is invalid',
      '3': 'Message must be at least 10 characters'
    },
    page_number: 1
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_2: 'not-an-email',
    input_3: 'Short'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.equal(result.validation_messages['2'], 'Email is invalid');
  TestAssert.equal(result.page_number, 1);
  TestAssert.isFalse('field_errors' in result, 'GF never returns field_errors — do not expose a dead field');
});

suite.test('Validate Submission: required-field failures come back in validation_messages', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false,
    validation_messages: { '1': 'This field is required' },
    page_number: 1
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_3: 'Only optional field filled'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.equal(result.validation_messages['1'], 'This field is required');
});

suite.test('Validate Submission: format failures come back in validation_messages', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false,
    validation_messages: {
      '4': 'Please enter a valid phone number',
      '5': 'Please enter a valid URL'
    },
    page_number: 1
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_4: '123',
    input_5: 'not-a-url'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.includes(result.validation_messages['4'], 'phone');
  TestAssert.includes(result.validation_messages['5'], 'URL');
});

// gf_validate_form is the sibling of gf_validate_submission and must behave the
// same way: validate WITHOUT creating an entry. It previously POSTed
// {validation_only:true} to /submissions — a flag GF ignores — so it really
// submitted (created an entry + fired notifications/feeds). It must use the
// dedicated /submissions/validation route and return GF's 400 invalid body.
suite.test('Validate Form: posts to the dedicated /validation route, never the submit route (no entry created)', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: true,
    validation_messages: {},
    page_number: 0
  }));

  const result = await client.validateForm({ form_id: 1, input_1: 'John Doe' });

  const req = mockHttpClient.getRequests().find(r => r.method === 'POST');
  TestAssert.equal(req.path, '/forms/1/submissions/validation');
  TestAssert.isFalse('validation_only' in (req.config.data || {}), 'must not send a validation_only flag');
  TestAssert.isTrue(result.valid);
});

suite.test('Validate Form: returns validation_messages on an invalid (400) submission instead of throwing', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false,
    validation_messages: { '1': 'This field is required.' },
    page_number: 1
  }, 400));

  const result = await client.validateForm({ form_id: 1, input_2: 'x' });

  TestAssert.isFalse(result.valid);
  TestAssert.equal(result.validation_messages['1'], 'This field is required.');
});

// =================================
// SEND NOTIFICATIONS TESTS
// =================================

suite.test('Send Notifications: no ids → send all-by-event; reads GF bare-array response', async () => {
  // GF returns a bare array of sent notification ids.
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse(
    ['admin_notification', 'user_notification']
  ));

  const result = await client.sendNotifications({ entry_id: 100 });

  const req = mockHttpClient.getRequests().find(r => r.method === 'POST');
  TestAssert.isFalse('notification_ids' in (req.config.data || {}), 'GF does not read notification_ids');
  TestAssert.isTrue(result.sent);
  TestAssert.lengthOf(result.notifications_sent, 2);
});

suite.test('Send Notifications: specific ids go out as GF _notifications (comma string) query param', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse(['admin_notification']));

  const result = await client.sendNotifications({
    entry_id: 100,
    notification_ids: ['admin_notification', 'user_notification']
  });

  const params = mockHttpClient.getRequests().find(r => r.method === 'POST').config.params || {};
  TestAssert.equal(params._notifications, 'admin_notification,user_notification');
  TestAssert.isTrue(result.sent);
  TestAssert.lengthOf(result.notifications_sent, 1);
});

suite.test('Send Notifications: forwards the GF _event query param', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse([]));

  await client.sendNotifications({ entry_id: 100, event: 'form_save_email_requested' });

  const params = mockHttpClient.getRequests().find(r => r.method === 'POST').config.params || {};
  TestAssert.equal(params._event, 'form_save_email_requested');
});

suite.test('Send Notifications: multiple ids join into one comma string', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse(['n1', 'n2', 'n3']));

  const result = await client.sendNotifications({
    entry_id: 100,
    notification_ids: ['n1', 'n2', 'n3']
  });

  const params = mockHttpClient.getRequests().find(r => r.method === 'POST').config.params || {};
  TestAssert.equal(params._notifications, 'n1,n2,n3');
  TestAssert.lengthOf(result.notifications_sent, 3);
});

suite.test('Send Notifications: Should require entry_id', async () => {
  await TestAssert.throwsAsync(
    () => client.sendNotifications({}),
    'entry_id',
    'Should require entry_id'
  );
});

suite.test('Send Notifications: Should handle non-existent entry', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/999/notifications', new MockResponse(
    { message: 'Entry not found' },
    404
  ));

  await TestAssert.throwsAsync(
    () => client.sendNotifications({ entry_id: 999 }),
    'not found',
    'Should handle non-existent entry'
  );
});

// =================================
// EDGE CASES AND FAILURE MODES
// =================================

suite.test('Edge Case: Should handle spam detection', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      'honeypot': 'Spam detected'
    },
    is_spam: true
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'Spam content',
    gf_honeypot: 'filled' // Honeypot field filled
  });

  TestAssert.isFalse(result.success);
  TestAssert.includes(result.validation_messages.honeypot, 'Spam');
});

suite.test('Edge Case: Should handle CAPTCHA validation', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      'captcha': 'The reCAPTCHA was invalid'
    }
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'John',
    'g-recaptcha-response': 'invalid-token'
  });

  TestAssert.isFalse(result.success);
  TestAssert.includes(result.validation_messages.captcha, 'reCAPTCHA');
});

suite.test('Edge Case: Should handle save and continue', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    resume_token: 'abc123def456',
    resume_url: 'https://example.com/form?gf_token=abc123def456',
    saved: true
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'Partial data',
    save: true
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.resume_token, 'abc123def456');
});

suite.test('Failure Mode: Should handle payment validation errors', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      'creditcard': 'Credit card number is invalid',
      'payment': 'Payment failed: Card declined'
    }
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_cc: '4111111111111111',
    input_cvv: '123'
  });

  TestAssert.isFalse(result.success);
  TestAssert.includes(result.validation_messages.payment, 'declined');
});

suite.test('Failure Mode: Should handle notification sending failures', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse(
    {
      message: 'Failed to send notifications',
      errors: ['SMTP connection failed']
    },
    500
  ));

  await TestAssert.throwsAsync(
    () => client.sendNotifications({ entry_id: 100 }),
    'Server error',
    'Should handle notification failures'
  );
});

suite.test('Failure Mode: Should handle form not found', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/999/submissions', new MockResponse(
    { message: 'Form not found' },
    404
  ));

  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 999, input_1: 'Test' }),
    'not found',
    'Should handle form not found'
  );
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
suite.run().then(results => {
  process.exit(results.failed > 0 ? 1 : 0);
});

}

export default suite;