/**
 * Validation Tests for Gravity MCP
 * Tests input validation for all tools and edge cases
 */

import GravityFormsClient from '../gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment
} from './helpers.js';

const suite = new TestRunner('Input Validation Tests');

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
// REQUIRED PARAMETER VALIDATION
// =================================

suite.test('Required Parameters: Forms endpoints', async () => {
  // gf_get_form requires id
  await TestAssert.throwsAsync(
    () => client.getForm({}),
    'id is required',
    'getForm should require id'
  );

  // gf_update_form requires id
  await TestAssert.throwsAsync(
    () => client.updateForm({ title: 'Test' }),
    'id is required',
    'updateForm should require id'
  );

  // gf_delete_form requires id
  client.allowDelete = true;
  await TestAssert.throwsAsync(
    () => client.deleteForm({}),
    'id is required',
    'deleteForm should require id'
  );

  // gf_create_form requires title
  await TestAssert.throwsAsync(
    () => client.createForm({ fields: [] }),
    'title is required',
    'createForm should require title'
  );
});

suite.test('Required Parameters: Entries endpoints', async () => {
  // gf_get_entry requires id
  await TestAssert.throwsAsync(
    () => client.getEntry({}),
    'id is required',
    'getEntry should require id'
  );

  // gf_create_entry requires form_id
  await TestAssert.throwsAsync(
    () => client.createEntry({ '1': 'value' }),
    'form_id is required',
    'createEntry should require form_id'
  );

  // gf_update_entry requires id
  await TestAssert.throwsAsync(
    () => client.updateEntry({ '1': 'value' }),
    'id is required',
    'updateEntry should require id'
  );

  // gf_delete_entry requires id
  client.allowDelete = true;
  await TestAssert.throwsAsync(
    () => client.deleteEntry({}),
    'id is required',
    'deleteEntry should require id'
  );
});

suite.test('Required Parameters: Feeds endpoints', async () => {
  // gf_get_feed requires id
  await TestAssert.throwsAsync(
    () => client.getFeed({}),
    'id is required',
    'getFeed should require id'
  );

  // gf_create_feed requires addon_slug, form_id, and meta
  await TestAssert.throwsAsync(
    () => client.createFeed({ form_id: 1, meta: {} }),
    'addon_slug is required',
    'createFeed should require addon_slug'
  );

  await TestAssert.throwsAsync(
    () => client.createFeed({ addon_slug: 'test', meta: {} }),
    'form_id is required',
    'createFeed should require form_id'
  );

  await TestAssert.throwsAsync(
    () => client.createFeed({ addon_slug: 'test', form_id: 1 }),
    'meta is required',
    'createFeed should require meta'
  );

  // gf_list_form_feeds requires form_id
  await TestAssert.throwsAsync(
    () => client.listFormFeeds({}),
    'form_id is required',
    'listFormFeeds should require form_id'
  );
});

suite.test('Required Parameters: Submissions', async () => {
  // gf_submit_form_data requires form_id
  await TestAssert.throwsAsync(
    () => client.submitFormData({ input_1: 'value' }),
    'form_id is required',
    'submitFormData should require form_id'
  );

  // gf_validate_submission requires form_id
  await TestAssert.throwsAsync(
    () => client.validateSubmission({ input_1: 'value' }),
    'form_id is required',
    'validateSubmission should require form_id'
  );
});

suite.test('Required Parameters: Notifications', async () => {
  // gf_send_notifications requires entry_id
  await TestAssert.throwsAsync(
    () => client.sendNotifications({}),
    'entry_id is required',
    'sendNotifications should require entry_id'
  );
});

suite.test('Required Parameters: Utilities', async () => {
  // gf_get_field_filters requires form_id
  await TestAssert.throwsAsync(
    () => client.getFieldFilters({}),
    'form_id is required',
    'getFieldFilters should require form_id'
  );

  // gf_get_results requires form_id
  await TestAssert.throwsAsync(
    () => client.getResults({}),
    'form_id is required',
    'getResults should require form_id'
  );
});

// =================================
// TYPE VALIDATION
// =================================

suite.test('Type Validation: Numeric IDs', async () => {
  // Form ID should be numeric
  await TestAssert.throwsAsync(
    () => client.getForm({ id: 'not-a-number' }),
    'must be a positive integer',
    'Form ID should be numeric'
  );

  // Entry ID should be numeric
  await TestAssert.throwsAsync(
    () => client.getEntry({ id: 'not-a-number' }),
    'must be a positive integer',
    'Entry ID should be numeric'
  );

  // Feed ID should be numeric
  await TestAssert.throwsAsync(
    () => client.getFeed({ id: 'not-a-number' }),
    'must be a positive integer',
    'Feed ID should be numeric'
  );
});

suite.test('Type Validation: Booleans', async () => {
  // Force parameter should be boolean
  client.allowDelete = true;
  await TestAssert.throwsAsync(
    () => client.deleteForm({ id: 1, force: 'yes' }),
    'must be a boolean',
    'Force parameter should be boolean'
  );

  // Active parameter should be boolean
  await TestAssert.throwsAsync(
    () => client.listForms({ active: 'true' }),
    'must be a boolean',
    'Active parameter should be boolean'
  );
});

suite.test('Type Validation: Arrays', async () => {
  // Include parameter should be array
  await TestAssert.throwsAsync(
    () => client.listForms({ include: '1,2,3' }),
    'must be an array',
    'Include parameter should be array'
  );

  // Exclude parameter should be array
  await TestAssert.throwsAsync(
    () => client.listForms({ exclude: '4,5,6' }),
    'must be an array',
    'Exclude parameter should be array'
  );

  // Form fields should be array
  await TestAssert.throwsAsync(
    () => client.createForm({ title: 'Test', fields: 'not-an-array' }),
    'must be an array',
    'Fields parameter should be array'
  );
});

suite.test('Type Validation: Objects', async () => {
  // Search parameter should be object
  await TestAssert.throwsAsync(
    () => client.listEntries({ search: 'invalid' }),
    'must be an object',
    'Search parameter should be object'
  );

  // Feed meta should be object
  await TestAssert.throwsAsync(
    () => client.createFeed({
      addon_slug: 'test',
      form_id: 1,
      meta: 'not-an-object'
    }),
    'must be an object',
    'Meta parameter should be object'
  );
});

// =================================
// ENUM VALIDATION
// =================================

suite.test('Enum Validation: Status values', async () => {
  // Form status values
  await TestAssert.throwsAsync(
    () => client.listForms({ status: 'invalid-status' }),
    'must be one of',
    'Status should validate against enum'
  );

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));

  // Valid status values should work
  await client.listForms({ status: 'active' });
  await client.listForms({ status: 'inactive' });
  await client.listForms({ status: 'trash' });
});

suite.test('Enum Validation: Search operators', async () => {
  // Invalid operator
  await TestAssert.throwsAsync(
    () => client.listEntries({
      search: {
        field_filters: [{
          key: '1',
          value: 'test',
          operator: 'INVALID'
        }]
      }
    }),
    'Invalid operator',
    'Should validate search operators'
  );

  // Valid operators
  const validOperators = [
    '=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>',
    'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<='
  ];

  for (const operator of validOperators) {
    mockHttpClient.setMockResponse('GET', '/entries', new MockResponse([]));
    await client.listEntries({
      search: {
        field_filters: [{
          key: '1',
          value: 'test',
          operator: operator
        }]
      }
    });
  }
});

suite.test('Enum Validation: Search mode', async () => {
  // Invalid search mode
  await TestAssert.throwsAsync(
    () => client.listEntries({
      search: {
        mode: 'invalid-mode',
        field_filters: []
      }
    }),
    'must be one of',
    'Should validate search mode'
  );

  // Valid search modes
  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse([]));
  await client.listEntries({
    search: {
      mode: 'any',
      field_filters: []
    }
  });

  await client.listEntries({
    search: {
      mode: 'all',
      field_filters: []
    }
  });
});

// =================================
// RANGE VALIDATION
// =================================

suite.test('Range Validation: Entries Pagination', async () => {
  // Entries endpoint supports pagination (unlike forms)
  // Test with entries endpoint which actually uses paging parameters
  await TestAssert.throwsAsync(
    () => client.listEntries({ paging: { page_size: 0 } }),
    'must be at least 1',
    'Page size should be positive'
  );

  await TestAssert.throwsAsync(
    () => client.listEntries({ paging: { page_size: 201 } }),
    'cannot exceed 200',
    'Page size should have upper limit for entries'
  );
});

suite.test('Range Validation: String lengths', async () => {
  // Form title minimum length
  await TestAssert.throwsAsync(
    () => client.createForm({ title: '' }),
    'cannot be empty',
    'Form title cannot be empty'
  );

  // Form title maximum length
  const veryLongTitle = 'a'.repeat(256);
  await TestAssert.throwsAsync(
    () => client.createForm({ title: veryLongTitle }),
    'too long',
    'Form title should have maximum length'
  );
});

// =================================
// FORMAT VALIDATION
// =================================

suite.test('Format Validation: Email addresses', async () => {
  // Invalid email format in notification
  await TestAssert.throwsAsync(
    () => client.sendNotifications({
      entry_id: 1,
      to: 'not-an-email'
    }),
    'valid email',
    'Should validate email format'
  );

  // Valid email should work
  mockHttpClient.setMockResponse('POST', '/entries/1/notifications',
    new MockResponse({ notifications_sent: [] })
  );

  await client.sendNotifications({
    entry_id: 1,
    to: 'test@example.com'
  });
});

suite.test('Format Validation: URLs', async () => {
  // Invalid URL format
  await TestAssert.throwsAsync(
    () => client.createForm({
      title: 'Test',
      confirmations: {
        conf_1: {
          type: 'redirect',
          url: 'not-a-url'
        }
      }
    }),
    'valid URL',
    'Should validate URL format'
  );

  // Valid URL should work
  mockHttpClient.setMockResponse('POST', '/forms',
    new MockResponse({ id: 1, title: 'Test' })
  );

  await client.createForm({
    title: 'Test',
    confirmations: {
      conf_1: {
        type: 'redirect',
        url: 'https://example.com'
      }
    }
  });
});

suite.test('Format Validation: Date formats', async () => {
  // Invalid date format
  await TestAssert.throwsAsync(
    () => client.listEntries({
      search: {
        start_date: 'invalid-date'
      }
    }),
    'ISO 8601',
    'Should validate date format'
  );

  // Valid ISO 8601 date should work
  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse([]));

  await client.listEntries({
    search: {
      start_date: '2024-01-01T00:00:00Z'
    }
  });
});

// =================================
// PERMISSION VALIDATION
// =================================

suite.test('Permission Validation: Delete operations', async () => {
  // Delete operations should be disabled by default
  client.allowDelete = false;

  await TestAssert.throwsAsync(
    () => client.deleteForm({ id: 1 }),
    'Delete operations are disabled',
    'Should block delete when disabled'
  );

  await TestAssert.throwsAsync(
    () => client.deleteEntry({ id: 1 }),
    'Delete operations are disabled',
    'Should block entry delete when disabled'
  );

  await TestAssert.throwsAsync(
    () => client.deleteFeed({ id: 1 }),
    'Delete operations are disabled',
    'Should block feed delete when disabled'
  );

  // Enable delete operations
  client.allowDelete = true;

  mockHttpClient.setMockResponse('DELETE', '/forms/1', new MockResponse({}));
  await client.deleteForm({ id: 1 });

  mockHttpClient.setMockResponse('DELETE', '/entries/1', new MockResponse({}));
  await client.deleteEntry({ id: 1 });

  mockHttpClient.setMockResponse('DELETE', '/feeds/1', new MockResponse({}));
  await client.deleteFeed({ id: 1 });
});

// =================================
// SPECIAL CHARACTER HANDLING
// =================================

suite.test('Special Characters: Unicode handling', async () => {
  // Unicode in form title
  mockHttpClient.setMockResponse('POST', '/forms',
    new MockResponse({ id: 1, title: 'Test 🚀 Form' })
  );

  const result = await client.createForm({
    title: 'Test 🚀 Form',
    description: 'Includes emoji 😀 and special chars: é, ñ, ü'
  });

  TestAssert.equal(result.form.title, 'Test 🚀 Form');
});

suite.test('Special Characters: HTML encoding', async () => {
  // HTML entities should be handled properly
  mockHttpClient.setMockResponse('POST', '/entries',
    new MockResponse({ id: 1 })
  );

  const result = await client.createEntry({
    form_id: 1,
    '1': '<script>alert("XSS")</script>',
    '2': 'Normal & special < > characters'
  });

  TestAssert.equal(result.entry.id, 1);
});

// =================================
// ADDON SLUG VALIDATION
// =================================

suite.test('Addon Slug Validation: Format requirements', async () => {
  // Invalid addon slug format
  await TestAssert.throwsAsync(
    () => client.listFeeds({ addon: 'Invalid Addon!' }),
    'valid slug format',
    'Should validate addon slug format'
  );

  // Valid addon slugs
  const validSlugs = [
    'gravityformsmailchimp',
    'gravityformsstripe',
    'gravityformspaypal',
    'gravityformsauthorizenet',
    'gravityformszapier'
  ];

  for (const slug of validSlugs) {
    mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse([]));
    await client.listFeeds({ addon: slug });
  }
});

// =================================
// COMPLEX VALIDATION SCENARIOS
// =================================

suite.test('Complex Validation: Multi-field dependencies', async () => {
  // Search requires field_filters when specified
  await TestAssert.throwsAsync(
    () => client.listEntries({
      search: {
        mode: 'all'
        // Missing field_filters
      }
    }),
    'field_filters',
    'Search should require field_filters'
  );

  // Field filters require all properties
  await TestAssert.throwsAsync(
    () => client.listEntries({
      search: {
        field_filters: [{
          key: '1'
          // Missing value and operator
        }]
      }
    }),
    'value',
    'Field filter should require value'
  );
});

suite.test('Complex Validation: Conditional logic validation', async () => {
  // Invalid conditional logic structure
  await TestAssert.throwsAsync(
    () => client.createFeed({
      addon_slug: 'test',
      form_id: 1,
      meta: {
        conditionalLogic: {
          enabled: true
          // Missing rules
        }
      }
    }),
    'rules',
    'Conditional logic should require rules'
  );

  // Valid conditional logic
  mockHttpClient.setMockResponse('POST', '/feeds',
    new MockResponse({ id: 1 })
  );

  await client.createFeed({
    addon_slug: 'test',
    form_id: 1,
    meta: {
      conditionalLogic: {
        enabled: true,
        actionType: 'show',
        rules: [{
          fieldId: '1',
          operator: 'is',
          value: 'test'
        }]
      }
    }
  });
});

// =================================
// EDGE CASE VALIDATION
// =================================

suite.test('Edge Cases: Empty arrays and objects', async () => {
  // Empty arrays should be allowed where valid
  mockHttpClient.setMockResponse('POST', '/forms',
    new MockResponse({ id: 1 })
  );

  await client.createForm({
    title: 'Test',
    fields: [] // Empty fields array is valid
  });

  // Empty objects should be allowed for meta
  mockHttpClient.setMockResponse('POST', '/feeds',
    new MockResponse({ id: 1 })
  );

  await client.createFeed({
    addon_slug: 'test',
    form_id: 1,
    meta: {} // Empty meta is valid
  });
});

suite.test('Edge Cases: Null vs undefined handling', async () => {
  // Undefined optional parameters should be ignored
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));

  await client.listForms({
    page: undefined,
    per_page: undefined
  });

  // Null values should be validated
  await TestAssert.throwsAsync(
    () => client.getForm({ id: null }),
    'required',
    'Null should not satisfy required parameter'
  );
});

suite.test('Edge Cases: Whitespace in strings', async () => {
  // Whitespace-only strings should be invalid for required fields
  await TestAssert.throwsAsync(
    () => client.createForm({ title: '   ' }),
    'cannot be empty',
    'Whitespace-only title should be invalid'
  );

  // Leading/trailing whitespace should be trimmed
  mockHttpClient.setMockResponse('POST', '/forms',
    new MockResponse({ id: 1, title: 'Test Form' })
  );

  const result = await client.createForm({
    title: '  Test Form  '
  });

  TestAssert.equal(result.form.title, 'Test Form');
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  suite.run().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}

export default suite;