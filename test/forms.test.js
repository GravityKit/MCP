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

suite.test('Get Form: accepts the form id as form_id, the name the submission tools use', async () => {
  const mockForm = generateMockForm({ id: 7 });
  mockHttpClient.setMockResponse('GET', '/forms/7', new MockResponse(mockForm));

  const result = await client.getForm({ form_id: 7 });

  TestAssert.equal(result.form.id, 7);
  TestAssert.isTrue(mockHttpClient.hasRequest('GET', '/forms/7'), 'form_id must resolve to the same route as id');
  await TestAssert.throwsAsync(
    () => client.getForm({ id: 7, form_id: 8 }),
    'disagree',
    'two different ids must be rejected rather than silently picking one'
  );
  await TestAssert.throwsAsync(
    () => client.getForm({}),
    'id is required',
    'the error must still name the documented parameter'
  );
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

// A multiselect created with no storageType stores its values comma-joined, and
// GF_Field_MultiSelect::to_array() splits on every comma
// (class-gf-field-multiselect.php:417) — so a submitted "Atlanta, GA" is read back
// as two values. The form editor writes 'json' on every multiselect (js.php:818).

suite.test('Create Form: Should give a new multiselect json storage', async () => {
  const form = {
    title: 'Cities Form',
    fields: [
      {
        id: 1,
        type: 'multiselect',
        label: 'Cities',
        choices: [
          { text: 'Atlanta, GA', value: 'Atlanta, GA' },
          { text: 'Austin, TX', value: 'Austin, TX' }
        ]
      }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ ...form, id: 50 }));
  mockHttpClient.clearRequests();

  await client.createForm(form);

  const postReq = mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/forms');
  TestAssert.exists(postReq, 'expected a POST /forms request');
  TestAssert.equal(postReq.config.data.fields[0].storageType, 'json', 'multiselect must be created with json storage');
});

suite.test('Create Form: Should read inputType for the storage mode, and leave other types alone', async () => {
  // GF_Fields::create() instantiates by inputType, so post_category set to
  // multiselect is a GF_Field_MultiSelect. A select is not, and must stay unset.
  const form = {
    title: 'Post Form',
    fields: [
      { id: 1, type: 'post_category', label: 'Category', inputType: 'multiselect', choices: [{ text: 'News', value: 'News' }] },
      { id: 2, type: 'select', label: 'Pick one', choices: [{ text: 'A', value: 'A' }] }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ ...form, id: 51 }));
  mockHttpClient.clearRequests();

  await client.createForm(form);

  const postReq = mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/forms');
  TestAssert.equal(postReq.config.data.fields[0].storageType, 'json', 'inputType multiselect must get json storage');
  TestAssert.equal(postReq.config.data.fields[1].storageType, undefined, 'a select must keep storageType unset');
});

suite.test('Create Form: Should keep an explicit legacy storageType on a multiselect', async () => {
  // '' is how a caller matches a field whose stored values are already comma-joined.
  const form = {
    title: 'Legacy Form',
    fields: [
      { id: 1, type: 'multiselect', label: 'Cities', storageType: '', choices: [{ text: 'A', value: 'A' }] }
    ]
  };

  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ ...form, id: 52 }));
  mockHttpClient.clearRequests();

  await client.createForm(form);

  const postReq = mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/forms');
  TestAssert.equal(postReq.config.data.fields[0].storageType, '', 'an explicit legacy storageType must survive');
});

// A notification with no `event` never fires: GFAPI::send_notifications skips any
// notification whose event differs from the one requested (api.php:2566), and an
// absent event is '' — never 'form_submission'. The form editor writes
// 'form_submission' on every notification (class-gf-form-crud-handler.php:403);
// GFAPI::add_form and update_form write nothing.

const postedForm = () => mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/forms').config.data;
const putForm = (id) => mockHttpClient.getRequests().find((r) => r.method === 'PUT' && r.path === `/forms/${id}`).config.data;

suite.test('Create Form: Should give a notification with no event the form_submission event', async () => {
  const notifications = {
    n1: { id: 'n1', isActive: true, name: 'Admin', to: 'a@example.com', subject: 'Hi', message: '{all_fields}' }
  };
  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ id: 60, title: 'T' }));
  mockHttpClient.clearRequests();

  await client.createForm({ title: 'T', fields: [{ id: 1, type: 'text', label: 'Name' }], notifications });

  TestAssert.equal(postedForm().notifications.n1.event, 'form_submission', 'an event-less notification must be created with the submission event');
  TestAssert.equal(postedForm().notifications.n1.to, 'a@example.com', 'the rest of the notification is untouched');
});

suite.test('Create Form: Should keep an explicit notification event, and default only the ones without', async () => {
  const notifications = {
    n1: { id: 'n1', event: 'form_saved', to: 'a@example.com' },
    n2: { id: 'n2', to: 'b@example.com' },
    n3: { id: 'n3', event: null, to: 'c@example.com' }
  };
  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ id: 61, title: 'T' }));
  mockHttpClient.clearRequests();

  await client.createForm({ title: 'T', fields: [{ id: 1, type: 'text', label: 'Name' }], notifications });

  const sent = postedForm().notifications;
  TestAssert.equal(sent.n1.event, 'form_saved', 'an explicit event must survive');
  TestAssert.equal(sent.n2.event, 'form_submission');
  TestAssert.equal(sent.n3.event, 'form_submission', 'null is no event');
});

suite.test('Create Form: Should not mutate the notifications object the caller passed', async () => {
  const notifications = { n1: { id: 'n1', to: 'a@example.com' } };
  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ id: 62, title: 'T' }));

  await client.createForm({ title: 'T', fields: [{ id: 1, type: 'text', label: 'Name' }], notifications });

  TestAssert.equal(notifications.n1.event, undefined, 'the caller object must be left alone');
});

suite.test('Create Form: Should leave confirmations, button and a form with no notifications as sent', async () => {
  // GF's default confirmation carries no event (forms_model.php:7104) and the
  // editor stores it as '', so a confirmation needs no default. A missing button
  // is filled on read (forms_model.php:1082).
  const confirmations = { c1: { id: 'c1', name: 'Thanks', type: 'message', message: 'Thanks' } };
  mockHttpClient.setMockResponse('POST', '/forms', new MockResponse({ id: 63, title: 'T' }));
  mockHttpClient.clearRequests();

  await client.createForm({ title: 'T', fields: [{ id: 1, type: 'text', label: 'Name' }], confirmations });

  const sent = postedForm();
  TestAssert.deepEqual(sent.confirmations, confirmations, 'confirmations must be sent as given');
  TestAssert.equal(sent.notifications, undefined, 'no notifications key is invented');
  TestAssert.equal(sent.button, undefined, 'no button is invented');
});

suite.test('Update Form: Should default the event on a notification the call adds, not on a stored one', async () => {
  // Flipping a stored notification's event changes when it fires on a live form,
  // so a stored one round-trips untouched — the rule storageType follows.
  const existingForm = generateMockForm({
    id: 70,
    title: 'Live',
    fields: [{ id: 1, type: 'text', label: 'Name' }],
    notifications: { old1: { id: 'old1', to: 'old@example.com' } }
  });
  mockHttpClient.setMockResponse('GET', '/forms/70', new MockResponse(existingForm));
  mockHttpClient.setMockResponse('PUT', '/forms/70', new MockResponse(existingForm));
  mockHttpClient.clearRequests();

  await client.updateForm({
    id: 70,
    notifications: {
      old1: { id: 'old1', to: 'old@example.com' },
      new1: { id: 'new1', to: 'new@example.com' }
    }
  });

  const sent = putForm(70).notifications;
  TestAssert.equal(sent.old1.event, undefined, 'a stored notification must not be rewritten');
  TestAssert.equal(sent.new1.event, 'form_submission', 'an added notification gets the submission event');
});

suite.test('Update Form: Should keep an explicit event a caller sets on a stored notification', async () => {
  const existingForm = generateMockForm({
    id: 71,
    title: 'Live',
    fields: [{ id: 1, type: 'text', label: 'Name' }],
    notifications: { old1: { id: 'old1', to: 'old@example.com' } }
  });
  mockHttpClient.setMockResponse('GET', '/forms/71', new MockResponse(existingForm));
  mockHttpClient.setMockResponse('PUT', '/forms/71', new MockResponse(existingForm));
  mockHttpClient.clearRequests();

  await client.updateForm({ id: 71, notifications: { old1: { id: 'old1', to: 'old@example.com', event: 'form_submission' } } });

  TestAssert.equal(putForm(71).notifications.old1.event, 'form_submission', 'repairing a stored notification by naming its event works');
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

suite.test('Update Form: Should give json storage to a multiselect the update ADDS', async () => {
  const existingForm = {
    id: 7,
    title: 'Roster',
    fields: [{ id: 1, type: 'text', label: 'Name' }]
  };

  mockHttpClient.setMockResponse('GET', '/forms/7', new MockResponse(existingForm));
  mockHttpClient.setMockResponse('PUT', '/forms/7', new MockResponse(existingForm));
  mockHttpClient.clearRequests();

  await client.updateForm({
    id: 7,
    fields: [
      { id: 1, type: 'text', label: 'Name' },
      { id: 2, type: 'multiselect', label: 'Cities', choices: [{ text: 'Atlanta, GA', value: 'Atlanta, GA' }] }
    ]
  });

  const putReq = mockHttpClient.getRequests().find((r) => r.method === 'PUT');
  TestAssert.exists(putReq, 'expected a PUT /forms/7 request');
  TestAssert.equal(putReq.config.data.fields[1].storageType, 'json', 'the added multiselect must get json storage');
});

suite.test('Update Form: Should leave a stored multiselect\'s storage mode alone', async () => {
  // A field already on the form round-trips untouched: its storageType decides how
  // GF reads the values already saved under it (class-gf-query.php:360 picks
  // GF_Query_JSON_Literal off storageType), so flipping it strands those entries.
  const existingForm = {
    id: 8,
    title: 'Legacy Roster',
    fields: [{ id: 1, type: 'multiselect', label: 'Cities', choices: [{ text: 'A', value: 'A' }] }]
  };

  mockHttpClient.setMockResponse('GET', '/forms/8', new MockResponse(existingForm));
  mockHttpClient.setMockResponse('PUT', '/forms/8', new MockResponse(existingForm));
  mockHttpClient.clearRequests();

  await client.updateForm({
    id: 8,
    fields: [{ id: 1, type: 'multiselect', label: 'Cities renamed', choices: [{ text: 'A', value: 'A' }] }]
  });

  const putReq = mockHttpClient.getRequests().find((r) => r.method === 'PUT');
  TestAssert.equal(putReq.config.data.fields[0].storageType, undefined, 'a stored field keeps its storage mode');
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

suite.test('Delete Form: accepts the form id as form_id', async () => {
  mockHttpClient.setMockResponse('DELETE', '/forms/7', new MockResponse({}));

  const result = await client.deleteForm({ form_id: 7, force: true });

  TestAssert.isTrue(result.deleted);
  TestAssert.equal(result.form_id, 7);
  TestAssert.isTrue(mockHttpClient.hasRequest('DELETE', '/forms/7'), 'form_id must resolve to the same route as id');
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

suite.test('Update Form: accepts the form id under either name', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/5', new MockResponse({ id: 5, title: 'Before', fields: [] }));
  mockHttpClient.setMockResponse('PUT', '/forms/5', new MockResponse({ id: 5, title: 'Renamed' }));
  const viaFormId = await client.updateForm({ form_id: 5, title: 'Renamed' });
  TestAssert.equal(viaFormId.form.id, 5, 'form_id must work where id is documented');
  const sent = mockHttpClient.getRequests().find(r => r.method === 'PUT').config.data;
  TestAssert.isFalse('form_id' in sent, 'only the normalized id may be sent');
  await TestAssert.throwsAsync(
    () => client.updateForm({ id: 5, form_id: 9, title: 'Renamed' }),
    'disagree',
    'two different ids must be rejected'
  );
});

export default suite;