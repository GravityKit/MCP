/**
 * Submissions and Notifications Tests for Gravity MCP
 * Tests form submission workflow, validation, and notifications
 */

import GravityFormsClient from '../gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment,
  generateMockEntry
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
    field_values: {
      utm_source: 'google',
      utm_campaign: 'summer2024',
      referrer: 'https://example.com'
    }
  });

  TestAssert.isTrue(result.success);
  TestAssert.equal(result.entry_id, 600);
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

suite.test('Validate Submission: Should validate without processing', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: true,
    validation_messages: {}
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_1: 'John Doe',
    input_2: 'john@example.com'
  });

  TestAssert.isTrue(result.valid);
});

suite.test('Validate Submission: Should return field-specific errors', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      '2': 'Email is invalid',
      '3': 'Message must be at least 10 characters'
    },
    field_errors: [
      { field_id: '2', message: 'Email is invalid' },
      { field_id: '3', message: 'Message must be at least 10 characters' }
    ]
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_1: 'John',
    input_2: 'not-an-email',
    input_3: 'Short'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.lengthOf(result.field_errors, 2);
  TestAssert.equal(result.field_errors[0].field_id, '2');
});

suite.test('Validate Submission: Should validate required fields', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      '1': 'This field is required',
      '2': 'This field is required'
    }
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_3: 'Only optional field filled'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.equal(result.validation_messages['1'], 'This field is required');
});

suite.test('Validate Submission: Should validate field formats', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions', new MockResponse({
    is_valid: false,
    validation_messages: {
      '4': 'Please enter a valid phone number',
      '5': 'Please enter a valid URL',
      '6': 'Please enter a valid date'
    }
  }));

  const result = await client.validateSubmission({
    form_id: 1,
    input_4: '123',
    input_5: 'not-a-url',
    input_6: 'invalid-date'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.includes(result.validation_messages['4'], 'phone');
  TestAssert.includes(result.validation_messages['5'], 'URL');
  TestAssert.includes(result.validation_messages['6'], 'date');
});

// =================================
// SEND NOTIFICATIONS TESTS
// =================================

suite.test('Send Notifications: Should send all notifications for entry', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse({
    notifications_sent: ['admin_notification', 'user_notification']
  }));

  const result = await client.sendNotifications({
    entry_id: 100
  });

  TestAssert.isTrue(result.sent);
  TestAssert.lengthOf(result.notifications_sent, 2);
});

suite.test('Send Notifications: Should send specific notifications', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse({
    notifications_sent: ['admin_notification']
  }));

  const result = await client.sendNotifications({
    entry_id: 100,
    notification_ids: ['admin_notification']
  });

  TestAssert.isTrue(result.sent);
  TestAssert.lengthOf(result.notifications_sent, 1);
  TestAssert.equal(result.notifications_sent[0], 'admin_notification');
});

suite.test('Send Notifications: Should handle multiple notification IDs', async () => {
  mockHttpClient.setMockResponse('POST', '/entries/100/notifications', new MockResponse({
    notifications_sent: ['notification_1', 'notification_2', 'notification_3']
  }));

  const result = await client.sendNotifications({
    entry_id: 100,
    notification_ids: ['notification_1', 'notification_2', 'notification_3']
  });

  TestAssert.isTrue(result.sent);
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