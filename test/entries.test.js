/**
 * Entries Endpoint Tests for Gravity MCP
 * Tests all 6 entries management tools with comprehensive coverage
 */

import GravityFormsClient from '../src/gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment,
  generateMockEntry,
  generateFieldFilter,
  generateSearchParams,
  generatePagingParams,
  generateSortingParams
} from './helpers.js';

const suite = new TestRunner('Entries Endpoint Tests');

let client;
let mockHttpClient;
let testEnv;

suite.beforeEach(() => {
  testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();

  client = new GravityFormsClient(testEnv);
  client.httpClient = mockHttpClient;
  client.allowDelete = true;

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
});

// =================================
// LIST ENTRIES TESTS
// =================================

suite.test('List Entries: Should list all entries with pagination', async () => {
  const mockEntries = [
    generateMockEntry(1, { id: 101 }),
    generateMockEntry(1, { id: 102 })
  ];

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: mockEntries,
    total_count: 2
  }));

  const result = await client.listEntries();

  TestAssert.lengthOf(result.entries, 2);
  TestAssert.equal(result.entries[0].id, 101);
  TestAssert.equal(result.total_count, 2);
});

suite.test('List Entries: Should filter by form IDs', async () => {
  const formEntries = [
    generateMockEntry(5, { id: 1 }),
    generateMockEntry(5, { id: 2 })
  ];

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: formEntries
  }));

  const result = await client.listEntries({ form_ids: [5] });

  TestAssert.lengthOf(result.entries, 2);
  TestAssert.equal(result.entries[0].form_id, 5);
});

suite.test('List Entries: Should filter by status', async () => {
  const activeEntries = [
    generateMockEntry(1, { id: 1, status: 'active' })
  ];

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: activeEntries
  }));

  const result = await client.listEntries({ status: 'active' });

  TestAssert.lengthOf(result.entries, 1);
  TestAssert.equal(result.entries[0].status, 'active');
});

suite.test('List Entries: Should handle complex search with field filters', async () => {
  const filters = [
    generateFieldFilter('1', 'John', 'CONTAINS'),
    generateFieldFilter('date_created', '2024-01-01', '>=')
  ];

  const search = generateSearchParams(filters, 'all');

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: [generateMockEntry()]
  }));

  const result = await client.listEntries({ search });

  TestAssert.lengthOf(result.entries, 1);
});

suite.test('List Entries: Should handle sorting', async () => {
  const sorting = generateSortingParams('date_created', 'desc');

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: [generateMockEntry()]
  }));

  const result = await client.listEntries({ sorting });

  TestAssert.lengthOf(result.entries, 1);
});

suite.test('List Entries: Should handle paging parameters', async () => {
  const paging = generatePagingParams(50, 2);

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: []
  }));

  const result = await client.listEntries({ paging });

  const request = mockHttpClient.getRequests()[0];
  TestAssert.includes(JSON.stringify(request.config.params), 'page_size');
});

suite.test('List Entries: Should validate search operators', async () => {
  const invalidSearch = {
    field_filters: [{
      key: '1',
      value: 'test',
      operator: 'INVALID_OP'
    }]
  };

  await TestAssert.throwsAsync(
    () => client.listEntries({ search: invalidSearch }),
    'Invalid operator',
    'Should validate search operators'
  );
});

// =================================
// GET ENTRY TESTS
// =================================

suite.test('Get Entry: Should get specific entry by ID', async () => {
  const mockEntry = generateMockEntry(1, { id: 123 });

  mockHttpClient.setMockResponse('GET', '/entries/123', new MockResponse(mockEntry));

  const result = await client.getEntry({ id: 123 });

  TestAssert.equal(result.entry.id, 123);
  TestAssert.equal(result.entry.form_id, 1);
  TestAssert.equal(result.entry.status, 'active');
});

suite.test('Get Entry: Should handle entry with file uploads', async () => {
  const entryWithFiles = generateMockEntry(1, {
    id: 1,
    '5': 'https://example.com/uploads/file1.pdf',
    '6': JSON.stringify([
      'https://example.com/uploads/file2.jpg',
      'https://example.com/uploads/file3.png'
    ])
  });

  mockHttpClient.setMockResponse('GET', '/entries/1', new MockResponse(entryWithFiles));

  const result = await client.getEntry({ id: 1 });

  TestAssert.includes(result.entry['5'], 'file1.pdf');
});

suite.test('Get Entry: Should handle entry with payment fields', async () => {
  const paymentEntry = generateMockEntry(1, {
    id: 1,
    payment_status: 'Paid',
    payment_amount: '99.99',
    payment_date: '2024-01-15',
    transaction_id: 'TXN123456'
  });

  mockHttpClient.setMockResponse('GET', '/entries/1', new MockResponse(paymentEntry));

  const result = await client.getEntry({ id: 1 });

  TestAssert.equal(result.entry.payment_status, 'Paid');
  TestAssert.equal(result.entry.payment_amount, '99.99');
});

suite.test('Get Entry: Should handle non-existent entry (404)', async () => {
  mockHttpClient.setMockResponse('GET', '/entries/999', new MockResponse(
    { message: 'Entry not found' },
    404
  ));

  await TestAssert.throwsAsync(
    () => client.getEntry({ id: 999 }),
    'not found',
    'Should handle 404 error'
  );
});

// =================================
// CREATE ENTRY TESTS
// =================================

suite.test('Create Entry: Should create new entry with field values', async () => {
  const newEntry = generateMockEntry(1, { id: 500 });

  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse(newEntry));

  const result = await client.createEntry({
    form_id: 1,
    '1': 'Jane Doe',
    '2': 'jane@example.com',
    '3': 'Test message',
    created_by: 1
  });

  TestAssert.equal(result.entry.id, 500);
});

suite.test('Create Entry: Should require form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.createEntry({ '1': 'Test' }),
    'form_id',
    'Should require form_id'
  );
});

suite.test('Create Entry: Should validate field values', async () => {
  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse(
    { message: 'Field validation failed', field_errors: ['Email is invalid'] },
    400
  ));

  await TestAssert.throwsAsync(
    () => client.createEntry({
      form_id: 1,
      '2': 'invalid-email'
    }),
    'validation',
    'Should handle validation errors'
  );
});

suite.test('Create Entry: Should handle complex field types', async () => {
  const complexEntry = {
    form_id: 1,
    '1.3': 'First Name',
    '1.6': 'Last Name',
    '2': ['choice1', 'choice2'],
    '3': JSON.stringify({ street: '123 Main St', city: 'Anytown' }),
    '4': '2024-01-15',
    created_by: 1
  };

  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse({
    ...complexEntry,
    id: 600
  }));

  const result = await client.createEntry(complexEntry);

  TestAssert.equal(result.entry['1.3'], 'First Name');
});

// =================================
// UPDATE ENTRY TESTS
// =================================

suite.test('Update Entry: Should update existing entry', async () => {
  // First mock the GET request to fetch existing entry
  const existingEntry = generateMockEntry(1, {
    id: 100,
    '1': 'Original Name',
    '2': 'original@email.com',
    '3': 'Original Address',
    status: 'active'
  });

  mockHttpClient.setMockResponse('GET', '/entries/100', new MockResponse(existingEntry));

  // Then mock the PUT request with the merged data
  const updatedEntry = generateMockEntry(1, {
    id: 100,
    '1': 'Updated Name',
    '2': 'original@email.com',  // Preserved
    '3': 'Original Address',     // Preserved
    status: 'spam'
  });

  mockHttpClient.setMockResponse('PUT', '/entries/100', new MockResponse(updatedEntry));

  const result = await client.updateEntry({
    id: 100,
    '1': 'Updated Name',
    status: 'spam'
  });

  TestAssert.equal(result.entry['1'], 'Updated Name');
});

suite.test('Update Entry: Should preserve all field data when updating single field', async () => {
  // Mock existing entry with multiple fields
  const existingEntry = {
    id: 23,
    form_id: 9,
    '1': 'John Doe',
    '2': 'john@example.com',
    '3': '25',
    date_created: '2025-09-09 22:00:29',
    date_updated: '2025-09-09 22:00:29',
    is_starred: '0',
    is_read: '0',
    status: 'active'
  };

  mockHttpClient.setMockResponse('GET', '/entries/23', new MockResponse(existingEntry));

  // Expected merged data (all fields preserved, only is_starred updated)
  const expectedMergedData = {
    ...existingEntry,
    is_starred: '1'
  };

  mockHttpClient.setMockResponse('PUT', '/entries/23', new MockResponse(expectedMergedData));

  // Update only the is_starred field
  const result = await client.updateEntry({
    id: 23,
    is_starred: '1'
  });

  // Verify the PUT request was made with ALL data
  const putRequest = mockHttpClient.getRequests().find(r => r.method === 'PUT');
  TestAssert.exists(putRequest, 'PUT request should be made');
  TestAssert.equal(putRequest.config.data['1'], 'John Doe', 'Field 1 should be preserved');
  TestAssert.equal(putRequest.config.data['2'], 'john@example.com', 'Field 2 should be preserved');
  TestAssert.equal(putRequest.config.data['3'], '25', 'Field 3 should be preserved');
  TestAssert.equal(putRequest.config.data.is_starred, '1', 'is_starred should be updated');

  TestAssert.equal(result.entry['1'], 'John Doe', 'Original field data preserved in response');
  TestAssert.equal(result.entry.is_starred, '1', 'Updated field changed in response');
});

suite.test('Update Entry: Should preserve metadata when updating fields', async () => {
  const entry = generateMockEntry(1, {
    id: 1,
    date_created: '2024-01-01T00:00:00Z',
    created_by: 1
  });

  mockHttpClient.setMockResponse('PUT', '/entries/1', new MockResponse(entry));

  const result = await client.updateEntry({
    id: 1,
    '1': 'New Value'
  });

  TestAssert.equal(result.entry.date_created, '2024-01-01T00:00:00Z');
  TestAssert.equal(result.entry.created_by, 1);
});

suite.test('Update Entry: Should validate entry status', async () => {
  await TestAssert.throwsAsync(
    () => client.updateEntry({
      id: 1,
      status: 'invalid_status'
    }),
    'Invalid status',
    'Should validate status values'
  );
});

// =================================
// DELETE ENTRY TESTS
// =================================

suite.test('Delete Entry: Should trash entry by default', async () => {
  mockHttpClient.setMockResponse('DELETE', '/entries/1', new MockResponse({}));

  const result = await client.deleteEntry({ id: 1 });

  TestAssert.isTrue(result.deleted);
  TestAssert.isFalse(result.permanently);
});

suite.test('Delete Entry: Should permanently delete with force=true', async () => {
  mockHttpClient.setMockResponse('DELETE', '/entries/1', new MockResponse({}));

  const result = await client.deleteEntry({ id: 1, force: true });

  TestAssert.isTrue(result.deleted);
  TestAssert.isTrue(result.permanently);
});

suite.test('Delete Entry: Should require ALLOW_DELETE=true', async () => {
  client.allowDelete = false;

  await TestAssert.throwsAsync(
    () => client.deleteEntry({ id: 1 }),
    'Delete operations are disabled',
    'Should check delete permission'
  );
});

// =================================
// EDGE CASES AND FAILURE MODES
// =================================

suite.test('Edge Case: Should handle large datasets (1000+ entries)', async () => {
  const largeDataset = Array.from({ length: 1000 }, (_, i) =>
    generateMockEntry(1, { id: i + 1 })
  );

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: largeDataset,
    total_count: 1000
  }));

  const result = await client.listEntries({ paging: { page_size: 200 } });

  TestAssert.equal(result.total_count, 1000);
});

suite.test('Edge Case: Should handle date boundary searches', async () => {
  const search = {
    field_filters: [
      { key: 'date_created', value: '2024-01-01T00:00:00Z', operator: '>=' },
      { key: 'date_created', value: '2024-12-31T23:59:59Z', operator: '<=' }
    ]
  };

  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({
    entries: []
  }));

  const result = await client.listEntries({ search });

  TestAssert.isNotNull(result.entries);
});

suite.test('Edge Case: Should handle multi-page form entries', async () => {
  const multiPageEntry = generateMockEntry(1, {
    id: 1,
    page_number: 3,
    resume_token: 'abc123def456'
  });

  mockHttpClient.setMockResponse('GET', '/entries/1', new MockResponse(multiPageEntry));

  const result = await client.getEntry({ id: 1 });

  TestAssert.equal(result.entry.page_number, 3);
  TestAssert.equal(result.entry.resume_token, 'abc123def456');
});

suite.test('Failure Mode: Should handle permission errors', async () => {
  mockHttpClient.setMockResponse('GET', '/entries/1', new MockResponse(
    { message: 'You do not have permission to view this entry' },
    403
  ));

  await TestAssert.throwsAsync(
    () => client.getEntry({ id: 1 }),
    'permission',
    'Should handle permission errors'
  );
});

suite.test('Failure Mode: Should handle database errors', async () => {
  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse(
    { message: 'Database connection failed' },
    500
  ));

  await TestAssert.throwsAsync(
    () => client.createEntry({ form_id: 1 }),
    'Server error',
    'Should handle database errors'
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