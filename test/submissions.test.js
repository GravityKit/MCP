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

suite.test('Submit Form: Should include field values', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    entry_id: 600
  }));

  const result = await client.submitFormData({
    form_id: 1,
    input_1: 'Jane Smith',
    input_2: 'jane@example.com',
    // Submission values are the input_N keys above. field_values is GF
    // dynamic-population data — a query string (or array), not an object.
    field_values: 'utm_source=google&utm_campaign=summer2024'
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 600);

  // Valid shape reaches the wire: input_N values + the field_values string.
  const body = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(body.input_1, 'Jane Smith');
  TestAssert.equal(body.field_values, 'utm_source=google&utm_campaign=summer2024');
});

suite.test('Submit Form: rejects a field_values OBJECT (GF wants a string/array)', async () => {
  // Invalid shape — GF declares field_values as ['string','array'] and 400s an
  // object. The client must reject it up front rather than send a 400-bound body.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, field_values: { '1': 'x' } }),
    'field_values',
    'object field_values must be rejected'
  );
});

suite.test('Submit Form: rejects a field_values JSON STRING (a serialized object)', async () => {
  // The object guard above only catches an object that arrives as an object. A
  // client that serializes its arguments hands the same mistake over as a JSON
  // string, which satisfies GF's declared ['string','array'] type, reads as a
  // query string with no pairs, and populates nothing — so the submission
  // succeeds with every value silently dropped. Cost of it going unguarded: a
  // real submission that stored only the fields GF itself complained about.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1, input_1: 'x', field_values: '{"1": "Ada"}' }),
    'field_values',
    'a JSON-string field_values must be rejected'
  );
});

suite.test('Submit Form: still accepts a real query string and array field_values', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 7, confirmation_message: 'ok'
  }));
  const viaString = await client.submitFormData({ form_id: 1, input_1: 'x', field_values: 'p1=a&p2=b' });
  TestAssert.equal(viaString.entry_id, 7, 'query-string field_values must still work');
  const viaArray = await client.submitFormData({ form_id: 1, input_1: 'x', field_values: ['a'] });
  TestAssert.equal(viaArray.entry_id, 7, 'array field_values must still work');
});

suite.test('Submit Form: rejects a submission carrying no input_N key', async () => {
  // Submitting nothing returns GF's required-field message for whichever field
  // happens to be required, which reads as one bad field rather than as none of
  // the values arriving.
  await TestAssert.throwsAsync(
    () => client.submitFormData({ form_id: 1 }),
    'input_N',
    'a submission with no field values must be rejected'
  );
});

suite.test('Submit Form: accepts the form id under either name', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 8, confirmation_message: 'ok'
  }));
  const viaId = await client.submitFormData({ id: 1, input_1: 'x' });
  TestAssert.equal(viaId.entry_id, 8, 'id must work where form_id is documented');
  await TestAssert.throwsAsync(
    () => client.submitFormData({ id: 5, form_id: 9, input_1: 'x' }),
    'disagree',
    'two different ids must be rejected rather than silently picking one'
  );
});

suite.test('Submit Form: keeps a multiselect value an array', async () => {
  // GF's own guidance: multiselect and checkbox values go as an array, never a
  // comma-separated string, because a value containing a comma ("Atlanta, GA")
  // is then indistinguishable from the separator. String()-coercing the whole
  // value flattened exactly that away.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 9, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, input_3: ['Atlanta, GA', 'Austin, TX'] });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.deepEqual(sent.input_3, ['Atlanta, GA', 'Austin, TX'],
    'an array value must reach GF as an array');
});

suite.test('Submit Form: keeps a formatted phone value an object', async () => {
  // A GF 3.0 "formatted" phone is an object of country/national/formatted/e164
  // and must be submitted as one. String() turned it into "[object Object]".
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 10, confirmation_message: 'ok'
  }));
  const phone = { country: 'us', national: '(555) 123-4567', formatted: '+1 555 123 4567', e164: '+15551234567' };
  await client.submitFormData({ form_id: 1, input_4: phone });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.deepEqual(sent.input_4, phone, 'an object value must reach GF as an object');
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
  // which the REST endpoint calls, wants input_5_3 (its own docblock says
  // $input_values['input_2_6']). Passing the dot form through unchanged loses
  // the value with nothing reported, so accept either spelling.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true, entry_id: 12, confirmation_message: 'ok'
  }));
  await client.submitFormData({ form_id: 1, 'input_5.3': 'Ada', 'input_5.6': 'Lovelace' });
  const sent = mockHttpClient.getRequests().find(r => r.method === 'POST').config.data;
  TestAssert.equal(sent.input_5_3, 'Ada', 'dot notation must be normalized to underscore');
  TestAssert.equal(sent.input_5_6, 'Lovelace', 'every dotted sub-input must be normalized');
  TestAssert.isFalse('input_5.3' in sent, 'the dotted key must not also be sent');
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