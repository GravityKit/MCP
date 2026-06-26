/**
 * Forms Endpoint Tests for Gravity MCP
 * Tests all 6 forms management tools with happy path, edge cases, and failure modes
 */

import GravityFormsClient from '../src/gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment,
  generateMockForm,
  generateId,
  generateString
} from './helpers.js';

const suite = new TestRunner('Forms Endpoint Tests');

let client;
let mockHttpClient;
let testEnv;

suite.beforeEach(() => {
  testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();

  // Create client with mocked HTTP client
  client = new GravityFormsClient(testEnv);
  client.httpClient = mockHttpClient;
  client.allowDelete = true; // Enable delete for testing

  // Mock successful initialization
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
});

// =================================
// LIST FORMS TESTS
// =================================

suite.test('List Forms: Should list all forms as object keyed by ID', async () => {
  // The /forms endpoint returns all forms as an object keyed by form ID
  const mockFormsResponse = {
    "1": { id: "1", title: "Form 1", entries: "10" },
    "2": { id: "2", title: "Form 2", entries: "5" }
  };

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(mockFormsResponse));

  const result = await client.listForms();

  TestAssert.equal(typeof result.forms, 'object');
  TestAssert.equal(result.forms["1"].id, "1");
  TestAssert.equal(result.forms["2"].title, "Form 2");
});


suite.test('List Forms: Should handle empty results', async () => {
  // When no forms exist, returns empty object
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({}));

  const result = await client.listForms();

  TestAssert.equal(typeof result.forms, 'object');
  TestAssert.equal(Object.keys(result.forms).length, 0);
});

suite.test('List Forms: Should support include parameter for specific forms', async () => {
  // When using 'include' parameter, returns full form details for specified IDs
  const mockForm = generateMockForm({ id: 5, title: 'Included Form' });
  const mockResponse = {
    "5": mockForm
  };

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(mockResponse));

  const result = await client.listForms({ include: [5] });

  TestAssert.equal(result.forms["5"].id, 5);
  TestAssert.equal(result.forms["5"].title, 'Included Form');
  TestAssert.isNotNull(result.forms["5"].fields);
});

// =================================
// GET FORM TESTS
// =================================

suite.test('Get Form: Should get specific form by ID', async () => {
  const mockForm = generateMockForm({ id: 123 });

  mockHttpClient.setMockResponse('GET', '/forms/123', new MockResponse(mockForm));

  const result = await client.getForm({ id: 123 });

  TestAssert.equal(result.form.id, 123);
  TestAssert.equal(result.form.title, mockForm.title);
  TestAssert.equal(result.form.fields.length, 3);
  TestAssert.isTrue(result.form.is_active);
});

suite.test('Get Form: Should handle form with no fields', async () => {
  const emptyForm = generateMockForm({ id: 1, fields: [] });

  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(emptyForm));

  const result = await client.getForm({ id: 1 });

  TestAssert.equal(result.form.fields.length, 0);
});

suite.test('Get Form: Should handle large forms (100+ fields)', async () => {
  const fields = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    type: 'text',
    label: `Field ${i + 1}`
  }));

  const largeForm = generateMockForm({ id: 1, fields });

  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(largeForm));

  const result = await client.getForm({ id: 1 });

  TestAssert.equal(result.form.fields.length, 150);
});

suite.test('Get Form: Should handle non-existent form (404)', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/999', new MockResponse(
    { message: 'Form not found' },
    404
  ));

  await TestAssert.throwsAsync(
    () => client.getForm({ id: 999 }),
    'not found',
    'Should handle 404 error'
  );
});

suite.test('Get Form: Should validate form ID', async () => {
  await TestAssert.throwsAsync(
    () => client.getForm({ id: 'invalid' }),
    'must be a positive integer',
    'Should validate ID format'
  );
});

// =================================
// CREATE FORM TESTS
// =================================

suite.test('Create Form: Should create new form with fields', async () => {
  const newForm = generateMockForm({ id: 5 });

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse(newForm));

  const result = await client.createForm({
    title: 'New Test Form',
    description: 'Test description',
    fields: newForm.fields
  });

  TestAssert.equal(result.form.id, 5);
});

suite.test('Create Form: Should require title', async () => {
  await TestAssert.throwsAsync(
    () => client.createForm({ description: 'No title' }),
    'title is required',
    'Should require form title'
  );
});

suite.test('Create Form: Should create form with complex conditional logic', async () => {
  const complexForm = {
    title: 'Complex Form',
    fields: [
      {
        id: 1,
        type: 'radio',
        label: 'Choice',
        choices: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' }
        ]
      },
      {
        id: 2,
        type: 'text',
        label: 'Conditional Field',
        conditionalLogic: {
          actionType: 'show',
          logicType: 'all',
          rules: [{
            fieldId: 1,
            operator: 'is',
            value: 'a'
          }]
        }
      }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({
    ...complexForm,
    id: 10
  }));

  const result = await client.createForm(complexForm);

  TestAssert.equal(result.form.fields[1].conditionalLogic.rules[0].fieldId, 1);
});

suite.test('Create Form: Should handle multi-page forms', async () => {
  const multiPageForm = {
    title: 'Multi-Page Form',
    fields: [
      { id: 1, type: 'text', label: 'Page 1 Field' },
      { id: 2, type: 'page', label: 'Page Break' },
      { id: 3, type: 'text', label: 'Page 2 Field' }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({
    ...multiPageForm,
    id: 20
  }));

  const result = await client.createForm(multiPageForm);

  TestAssert.equal(result.form.fields.length, 3);
});

suite.test('Create Form: Should handle unicode and special characters', async () => {
  const unicodeForm = {
    title: 'フォーム 测试 🚀',
    description: 'Special chars: <>&"\'',
    fields: [
      { id: 1, type: 'text', label: '名前' }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({
    ...unicodeForm,
    id: 30
  }));

  const result = await client.createForm(unicodeForm);

  TestAssert.equal(result.form.title, unicodeForm.title);
});

suite.test('Create Form: Should accept an unknown field type without leaking _unknown to the API', async () => {
  const customForm = {
    title: 'Custom Field Form',
    fields: [
      { id: 1, type: 'custom_field_type', label: 'Custom Field' }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({
    ...customForm,
    id: 40,
    fields: [
      { id: 1, type: 'custom_field_type', label: 'Custom Field' }
    ]
  }));

  mockHttpClient.clearRequests();
  const result = await client.createForm(customForm);

  // Unknown types are tolerated (no throw) and round-trip back to the caller.
  TestAssert.equal(result.form.fields[0].type, 'custom_field_type');

  // The validated payload actually POSTed must not carry the internal _unknown flag.
  const postReq = mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/forms');
  TestAssert.exists(postReq, 'expected a POST /forms request');
  TestAssert.isFalse('_unknown' in postReq.config.data.fields[0], 'must not POST the internal _unknown flag');
});

// =================================
// UPDATE FORM TESTS
// =================================

suite.test('Update Form: Should update existing form', async () => {
  // First mock the GET request to fetch existing form
  const existingForm = generateMockForm({
    id: 1,
    title: 'Original Title',
    description: 'Original Description',
    fields: [
      { id: 1, type: 'text', label: 'Name' },
      { id: 2, type: 'email', label: 'Email' }
    ],
    is_active: true
  });

  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(existingForm));

  // Then mock the PUT request with merged data
  const updatedForm = generateMockForm({
    id: 1,
    title: 'Updated Title',
    description: 'Original Description',  // Preserved
    fields: existingForm.fields,          // Preserved
    is_active: true                       // Preserved
  });

  mockHttpClient.setMockResponse('PUT', '/forms/1', new MockResponse(updatedForm));

  const result = await client.updateForm({
    id: 1,
    title: 'Updated Title'
  });

  TestAssert.equal(result.form.title, 'Updated Title');
});

suite.test('Update Form: Should preserve all form data when updating single property', async () => {
  // Mock a complete form with all properties
  const existingForm = {
    id: 3,
    title: 'Third Grade Student Registration',
    description: 'Please complete this form to register your child for third grade.',
    is_active: true,
    fields: [
      {
        type: 'name',
        id: 1,
        label: 'Student Name',
        isRequired: true
      },
      {
        type: 'email',
        id: 2,
        label: 'Parent Email Address',
        isRequired: true
      }
    ],
    button: {
      type: 'text',
      text: 'Submit Registration'
    },
    notifications: {
      '5f7c31b2e5a23': {
        id: '5f7c31b2e5a23',
        name: 'Admin Notification',
        to: '{admin_email}'
      }
    },
    confirmations: {
      '5f7c31b2e5a24': {
        id: '5f7c31b2e5a24',
        name: 'Default Confirmation',
        message: 'Thank you for registering'
      }
    }
  };

  mockHttpClient.setMockResponse('GET', '/forms/3', new MockResponse(existingForm));

  // Expected merged data (all properties preserved, only is_active updated)
  const expectedMergedData = {
    ...existingForm,
    is_active: false
  };

  mockHttpClient.setMockResponse('PUT', '/forms/3', new MockResponse(expectedMergedData));

  // Update only the is_active property
  const result = await client.updateForm({
    id: 3,
    is_active: false
  });

  // Verify the PUT request was made with ALL data
  const putRequest = mockHttpClient.getRequests().find(r => r.method === 'PUT');
  TestAssert.exists(putRequest, 'PUT request should be made');
  TestAssert.equal(putRequest.config.data.title, 'Third Grade Student Registration', 'Title should be preserved');
  TestAssert.equal(putRequest.config.data.description, existingForm.description, 'Description should be preserved');
  TestAssert.lengthOf(putRequest.config.data.fields, 2, 'All fields should be preserved');
  TestAssert.exists(putRequest.config.data.button, 'Button settings should be preserved');
  TestAssert.exists(putRequest.config.data.notifications, 'Notifications should be preserved');
  TestAssert.exists(putRequest.config.data.confirmations, 'Confirmations should be preserved');
  TestAssert.equal(putRequest.config.data.is_active, false, 'is_active should be updated');

  TestAssert.equal(result.form.is_active, false, 'Updated property changed');
});

suite.test('Update Form: Should validate form ID is required', async () => {
  await TestAssert.throwsAsync(
    () => client.updateForm({ title: 'No ID' }),
    'id',
    'Should require form ID'
  );
});

suite.test('Update Form: Should handle permission errors (403)', async () => {
  mockHttpClient.setMockResponse('PUT', '/forms/1', new MockResponse(
    { message: 'Insufficient permissions' },
    403
  ));

  await TestAssert.throwsAsync(
    () => client.updateForm({ id: 1, title: 'Test' }),
    'forbidden',
    'Should handle permission errors'
  );
});

// =================================
// DELETE FORM TESTS
// =================================

suite.test('Delete Form: Should trash form by default', async () => {
  mockHttpClient.setMockResponse('DELETE', '/forms/1', new MockResponse({}));

  const result = await client.deleteForm({ id: 1 });

  TestAssert.isTrue(result.deleted);
  TestAssert.isFalse(result.permanently);
});

suite.test('Delete Form: Should permanently delete with force=true', async () => {
  mockHttpClient.setMockResponse('DELETE', '/forms/1', new MockResponse({}));

  const result = await client.deleteForm({ id: 1, force: true });

  TestAssert.isTrue(result.deleted);
  TestAssert.isTrue(result.permanently);
});

suite.test('Delete Form: Should require ALLOW_DELETE=true', async () => {
  client.allowDelete = false;

  await TestAssert.throwsAsync(
    () => client.deleteForm({ id: 1 }),
    'Delete operations are disabled',
    'Should check delete permission'
  );
});

suite.test('Delete Form: Should validate form ID', async () => {
  await TestAssert.throwsAsync(
    () => client.deleteForm({ id: -1 }),
    'positive integer',
    'Should validate form ID'
  );
});

// =================================
// VALIDATE FORM TESTS
// =================================

suite.test('Validate Form: Should validate form submission data', async () => {
  // validateForm validates WITHOUT creating an entry, so it must hit the
  // dedicated /submissions/validation route — not /submissions.
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: true,
    validation_messages: {}
  }));

  const result = await client.validateForm({
    form_id: 1,
    input_1: 'John Doe',
    input_2: 'john@example.com'
  });

  TestAssert.isTrue(result.valid);
});

suite.test('Validate Form: Should return validation errors', async () => {
  mockHttpClient.setMockResponse('POST', '/forms/1/submissions/validation', new MockResponse({
    is_valid: false,
    validation_messages: {
      '2': 'Email is required',
      '3': 'Message must be at least 10 characters'
    }
  }));

  const result = await client.validateForm({
    form_id: 1,
    input_1: 'John'
  });

  TestAssert.isFalse(result.valid);
  TestAssert.equal(result.validation_messages['2'], 'Email is required');
});

suite.test('Validate Form: Should require form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.validateForm({ input_1: 'Test' }),
    'form_id is required',
    'Should require form_id'
  );
});

// =================================
// EDGE CASES AND FAILURE MODES
// =================================

suite.test('Edge Case: Should handle forms with all field types', async () => {
  const allFieldsForm = generateMockForm({
    id: 1,
    fields: [
      { id: 1, type: 'text', label: 'Text' },
      { id: 2, type: 'textarea', label: 'Textarea' },
      { id: 3, type: 'select', label: 'Select' },
      { id: 4, type: 'multiselect', label: 'Multi-Select' },
      { id: 5, type: 'number', label: 'Number' },
      { id: 6, type: 'checkbox', label: 'Checkbox' },
      { id: 7, type: 'radio', label: 'Radio' },
      { id: 8, type: 'hidden', label: 'Hidden' },
      { id: 9, type: 'html', label: 'HTML' },
      { id: 10, type: 'section', label: 'Section' },
      { id: 11, type: 'page', label: 'Page Break' },
      { id: 12, type: 'date', label: 'Date' },
      { id: 13, type: 'time', label: 'Time' },
      { id: 14, type: 'phone', label: 'Phone' },
      { id: 15, type: 'address', label: 'Address' },
      { id: 16, type: 'website', label: 'Website' },
      { id: 17, type: 'email', label: 'Email' },
      { id: 18, type: 'fileupload', label: 'File Upload' }
    ]
  });

  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(allFieldsForm));

  const result = await client.getForm({ id: 1 });

  TestAssert.equal(result.form.fields.length, 18);
  TestAssert.equal(result.form.fields[17].type, 'fileupload');
});

suite.test('Failure Mode: Should handle rate limiting', async () => {
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Rate limit exceeded' },
    429
  ));

  await TestAssert.throwsAsync(
    () => client.listForms(),
    'Rate limit',
    'Should handle rate limiting'
  );
});

suite.test('Failure Mode: Should handle server errors', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(
    { message: 'Internal server error' },
    500
  ));

  await TestAssert.throwsAsync(
    () => client.getForm({ id: 1 }),
    'Server error',
    'Should handle server errors'
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