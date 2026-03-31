/**
 * Array Value Normalization Tests
 * Tests that array values in entry data are correctly normalized
 * to match Gravity Forms storage patterns per field type:
 *   - Checkbox (any parent type): dot-notation sub-inputs
 *   - Multiselect: comma-separated string (REST API v2 format)
 *   - Radio/Dropdown: single value (first element)
 *
 * Covers: createEntry, updateEntry, value matching, edge cases,
 * option/quiz/survey/poll checkbox variants, multiselect, radio fallback.
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

const suite = new TestRunner('Checkbox Expansion Tests');

let client;
let mockHttpClient;

// Reusable form with a checkbox field
const CHECKBOX_FORM = {
  id: 1,
  title: 'Checkbox Test Form',
  fields: [
    { id: 1, type: 'text', label: 'Name' },
    {
      id: 2,
      type: 'checkbox',
      label: 'Colors',
      inputs: [
        { id: '2.1', label: 'Red' },
        { id: '2.2', label: 'Green' },
        { id: '2.3', label: 'Blue' }
      ],
      choices: [
        { text: 'Red', value: 'red' },
        { text: 'Green', value: 'green' },
        { text: 'Blue', value: 'blue' }
      ]
    },
    { id: 3, type: 'email', label: 'Email' }
  ]
};

// Form with multiple checkbox fields
const MULTI_CHECKBOX_FORM = {
  id: 2,
  title: 'Multi Checkbox Form',
  fields: [
    {
      id: 1,
      type: 'checkbox',
      label: 'Fruits',
      inputs: [
        { id: '1.1', label: 'Apple' },
        { id: '1.2', label: 'Banana' },
        { id: '1.3', label: 'Cherry' }
      ],
      choices: [
        { text: 'Apple', value: 'apple' },
        { text: 'Banana', value: 'banana' },
        { text: 'Cherry', value: 'cherry' }
      ]
    },
    {
      id: 2,
      type: 'checkbox',
      label: 'Sizes',
      inputs: [
        { id: '2.1', label: 'Small' },
        { id: '2.2', label: 'Medium' },
        { id: '2.3', label: 'Large' }
      ],
      choices: [
        { text: 'Small', value: 'sm' },
        { text: 'Medium', value: 'md' },
        { text: 'Large', value: 'lg' }
      ]
    }
  ]
};

// Form where choice text differs from value
const TEXT_VALUE_FORM = {
  id: 3,
  title: 'Text/Value Mismatch Form',
  fields: [
    {
      id: 1,
      type: 'checkbox',
      label: 'Plans',
      inputs: [
        { id: '1.1', label: 'Basic Plan' },
        { id: '1.2', label: 'Pro Plan' },
        { id: '1.3', label: 'Enterprise Plan' }
      ],
      choices: [
        { text: 'Basic Plan', value: 'basic' },
        { text: 'Pro Plan', value: 'pro' },
        { text: 'Enterprise Plan', value: 'enterprise' }
      ]
    }
  ]
};

// Form with hidden input (e.g., "Select All")
const HIDDEN_INPUT_FORM = {
  id: 4,
  title: 'Hidden Input Form',
  fields: [
    {
      id: 1,
      type: 'checkbox',
      label: 'Options',
      inputs: [
        { id: '1.1', label: 'Select All', isHidden: true },
        { id: '1.2', label: 'Option A' },
        { id: '1.3', label: 'Option B' }
      ],
      choices: [
        { text: 'Option A', value: 'a' },
        { text: 'Option B', value: 'b' }
      ]
    }
  ]
};

suite.beforeEach(() => {
  const testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();
  client = new GravityFormsClient(testEnv);
  client.httpClient = mockHttpClient;
  client.allowDelete = true;
});

// =================================
// _normalizeArrayValues UNIT TESTS
// =================================

suite.test('Expand: matches values to correct sub-input IDs', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['red', 'blue'] },
    1
  );

  TestAssert.equal(result['2.1'], 'red', 'Red should map to 2.1');
  TestAssert.equal(result['2.2'], '', 'Green should be cleared');
  TestAssert.equal(result['2.3'], 'blue', 'Blue should map to 2.3');
  TestAssert.equal(result['2'], undefined, 'Original array key should be removed');
});

suite.test('Expand: matches by choice text when value does not match', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/3', new MockResponse(TEXT_VALUE_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 3, '1': ['Pro Plan', 'Enterprise Plan'] },
    3
  );

  TestAssert.equal(result['1.1'], '', 'Basic should be cleared');
  TestAssert.equal(result['1.2'], 'pro', 'Pro Plan text should match and store the value');
  TestAssert.equal(result['1.3'], 'enterprise', 'Enterprise Plan text should match and store the value');
});

suite.test('Expand: prefers value match over text match', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/3', new MockResponse(TEXT_VALUE_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 3, '1': ['basic', 'pro'] },
    3
  );

  TestAssert.equal(result['1.1'], 'basic', 'Should match by value');
  TestAssert.equal(result['1.2'], 'pro', 'Should match by value');
  TestAssert.equal(result['1.3'], '', 'Enterprise should be cleared');
});

suite.test('Expand: skips unmatched values', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['red', 'nonexistent', 'blue'] },
    1
  );

  TestAssert.equal(result['2.1'], 'red', 'Red should map');
  TestAssert.equal(result['2.2'], '', 'Green cleared');
  TestAssert.equal(result['2.3'], 'blue', 'Blue should map');
});

suite.test('Expand: clears all sub-inputs when empty array provided', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': [] },
    1
  );

  TestAssert.equal(result['2.1'], '', 'Should be cleared');
  TestAssert.equal(result['2.2'], '', 'Should be cleared');
  TestAssert.equal(result['2.3'], '', 'Should be cleared');
  TestAssert.equal(result['2'], undefined, 'Original key removed');
});

suite.test('Expand: does not fetch form when no array values', async () => {
  const result = await client._normalizeArrayValues(
    { form_id: 1, '1': 'John', '3': 'john@test.com' },
    1
  );

  // No form fetch should have happened
  const formRequests = mockHttpClient.requests.filter(r => r.path.startsWith('/forms/'));
  TestAssert.equal(formRequests.length, 0, 'Should not fetch form when no arrays');
  TestAssert.equal(result['1'], 'John', 'Non-array values untouched');
});

suite.test('Expand: preserves non-array values alongside expansion', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '1': 'John', '2': ['green'], '3': 'john@test.com' },
    1
  );

  TestAssert.equal(result['1'], 'John', 'Text field untouched');
  TestAssert.equal(result['3'], 'john@test.com', 'Email field untouched');
  TestAssert.equal(result['2.1'], '', 'Red cleared');
  TestAssert.equal(result['2.2'], 'green', 'Green selected');
  TestAssert.equal(result['2.3'], '', 'Blue cleared');
});

suite.test('Expand: handles multiple checkbox fields', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/2', new MockResponse(MULTI_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 2, '1': ['apple', 'cherry'], '2': ['lg'] },
    2
  );

  TestAssert.equal(result['1.1'], 'apple');
  TestAssert.equal(result['1.2'], '', 'Banana cleared');
  TestAssert.equal(result['1.3'], 'cherry');
  TestAssert.equal(result['2.1'], '', 'Small cleared');
  TestAssert.equal(result['2.2'], '', 'Medium cleared');
  TestAssert.equal(result['2.3'], 'lg');
});

suite.test('Expand: skips hidden inputs', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/4', new MockResponse(HIDDEN_INPUT_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 4, '1': ['a'] },
    4
  );

  TestAssert.equal(result['1.1'], undefined, 'Hidden input should not be set');
  TestAssert.equal(result['1.2'], 'a', 'Option A should map to 1.2');
  TestAssert.equal(result['1.3'], '', 'Option B cleared');
});

suite.test('Expand: leaves array for non-checkbox field (no inputs/choices)', async () => {
  const formWithList = {
    id: 5,
    fields: [
      { id: 1, type: 'list', label: 'Items' } // list field has no inputs/choices
    ]
  };
  mockHttpClient.setMockResponse('GET', '/forms/5', new MockResponse(formWithList));

  const result = await client._normalizeArrayValues(
    { form_id: 5, '1': ['item1', 'item2'] },
    5
  );

  // Array left intact because field has no inputs/choices
  TestAssert.equal(Array.isArray(result['1']), true, 'Should leave array for non-checkbox');
  TestAssert.equal(result['1'][0], 'item1');
});

suite.test('Expand: single value array works', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['green'] },
    1
  );

  TestAssert.equal(result['2.1'], '', 'Red cleared');
  TestAssert.equal(result['2.2'], 'green');
  TestAssert.equal(result['2.3'], '', 'Blue cleared');
});

suite.test('Expand: all choices selected', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['red', 'green', 'blue'] },
    1
  );

  TestAssert.equal(result['2.1'], 'red');
  TestAssert.equal(result['2.2'], 'green');
  TestAssert.equal(result['2.3'], 'blue');
});

// =================================
// CREATE ENTRY INTEGRATION
// =================================

suite.test('createEntry: expands checkbox arrays', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));
  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse({
    id: 100, form_id: 1, '1': 'John', '2.1': 'red', '2.2': '', '2.3': 'blue'
  }));

  const result = await client.createEntry({
    form_id: 1,
    '1': 'John',
    '2': ['red', 'blue']
  });

  // Verify the POST was made with expanded values
  const postRequest = mockHttpClient.requests.find(r => r.method === 'POST' && r.path === '/entries');
  const postedData = postRequest.config.data;
  TestAssert.equal(postedData['2.1'], 'red', 'POST data should have expanded 2.1');
  TestAssert.equal(postedData['2.2'], '', 'POST data should have cleared 2.2');
  TestAssert.equal(postedData['2.3'], 'blue', 'POST data should have expanded 2.3');
  TestAssert.equal(postedData['2'], undefined, 'POST data should not have original array key');
  TestAssert.equal(postedData['1'], 'John', 'Non-checkbox fields preserved');
});

suite.test('createEntry: no expansion when no arrays', async () => {
  mockHttpClient.setMockResponse('POST', '/entries', new MockResponse({
    id: 101, form_id: 1, '1': 'Jane', '2.1': 'red'
  }));

  await client.createEntry({
    form_id: 1,
    '1': 'Jane',
    '2.1': 'red'
  });

  // Should NOT have fetched the form
  const formRequests = mockHttpClient.requests.filter(r => r.path === '/forms/1');
  TestAssert.equal(formRequests.length, 0, 'Should skip form fetch when no arrays');
});

// =================================
// UPDATE ENTRY INTEGRATION
// =================================

suite.test('updateEntry: expands checkbox arrays and clears stale values', async () => {
  const existingEntry = generateMockEntry(1, {
    id: 50,
    form_id: 1,
    '1': 'John',
    '2.1': 'red',
    '2.2': 'green',
    '2.3': 'blue',
    '3': 'john@test.com'
  });

  mockHttpClient.setMockResponse('GET', '/entries/50', new MockResponse(existingEntry));
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));
  mockHttpClient.setMockResponse('PUT', '/entries/50', new MockResponse({
    ...existingEntry, '2.1': '', '2.2': 'green', '2.3': ''
  }));

  await client.updateEntry({
    id: 50,
    '2': ['green']
  });

  const putRequest = mockHttpClient.requests.find(r => r.method === 'PUT' && r.path === '/entries/50');
  const putData = putRequest.config.data;

  TestAssert.equal(putData['2.1'], '', 'Red should be cleared');
  TestAssert.equal(putData['2.2'], 'green', 'Green should be set');
  TestAssert.equal(putData['2.3'], '', 'Blue should be cleared');
  TestAssert.equal(putData['1'], 'John', 'Name preserved from existing');
  TestAssert.equal(putData['3'], 'john@test.com', 'Email preserved from existing');
});

suite.test('updateEntry: does not touch checkbox when not in update', async () => {
  const existingEntry = generateMockEntry(1, {
    id: 51,
    form_id: 1,
    '1': 'John',
    '2.1': 'red',
    '2.2': '',
    '2.3': 'blue'
  });

  mockHttpClient.setMockResponse('GET', '/entries/51', new MockResponse(existingEntry));
  mockHttpClient.setMockResponse('PUT', '/entries/51', new MockResponse({
    ...existingEntry, '1': 'Jane'
  }));

  await client.updateEntry({
    id: 51,
    '1': 'Jane'
  });

  const putRequest = mockHttpClient.requests.find(r => r.method === 'PUT' && r.path === '/entries/51');
  const putData = putRequest.config.data;

  TestAssert.equal(putData['1'], 'Jane', 'Name updated');
  TestAssert.equal(putData['2.1'], 'red', 'Checkbox 2.1 preserved');
  TestAssert.equal(putData['2.3'], 'blue', 'Checkbox 2.3 preserved');

  // Should NOT have fetched the form (no arrays in update)
  const formRequests = mockHttpClient.requests.filter(r => r.path === '/forms/1');
  TestAssert.equal(formRequests.length, 0, 'Should skip form fetch');
});

suite.test('updateEntry: clears all checkboxes with empty array', async () => {
  const existingEntry = generateMockEntry(1, {
    id: 52,
    form_id: 1,
    '2.1': 'red',
    '2.2': 'green',
    '2.3': 'blue'
  });

  mockHttpClient.setMockResponse('GET', '/entries/52', new MockResponse(existingEntry));
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));
  mockHttpClient.setMockResponse('PUT', '/entries/52', new MockResponse(existingEntry));

  await client.updateEntry({
    id: 52,
    '2': []
  });

  const putRequest = mockHttpClient.requests.find(r => r.method === 'PUT' && r.path === '/entries/52');
  const putData = putRequest.config.data;

  TestAssert.equal(putData['2.1'], '', 'All cleared');
  TestAssert.equal(putData['2.2'], '', 'All cleared');
  TestAssert.equal(putData['2.3'], '', 'All cleared');
});

// =================================
// VALUE MATCHING EDGE CASES
// =================================

suite.test('Expand: mixed value and text matching in same array', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/3', new MockResponse(TEXT_VALUE_FORM));

  // 'basic' matches by value, 'Enterprise Plan' matches by text
  const result = await client._normalizeArrayValues(
    { form_id: 3, '1': ['basic', 'Enterprise Plan'] },
    3
  );

  TestAssert.equal(result['1.1'], 'basic', 'Matched by value');
  TestAssert.equal(result['1.2'], '', 'Pro cleared');
  TestAssert.equal(result['1.3'], 'enterprise', 'Matched by text, stored as value');
});

suite.test('Expand: duplicate values in array only set once', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['red', 'red'] },
    1
  );

  TestAssert.equal(result['2.1'], 'red');
  TestAssert.equal(result['2.2'], '', 'Only one sub-input set despite duplicate');
  TestAssert.equal(result['2.3'], '');
});

suite.test('Expand: all values unmatched leaves field cleared', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1', new MockResponse(CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 1, '2': ['purple', 'orange'] },
    1
  );

  TestAssert.equal(result['2.1'], '', 'All cleared when nothing matches');
  TestAssert.equal(result['2.2'], '');
  TestAssert.equal(result['2.3'], '');
});

// =================================
// MULTISELECT NORMALIZATION
// =================================

const MULTISELECT_FORM = {
  id: 10,
  fields: [
    {
      id: 1,
      type: 'multiselect',
      label: 'Tags',
      choices: [
        { text: 'Tag 1', value: 'tag1' },
        { text: 'Tag 2', value: 'tag2' },
        { text: 'Tag 3', value: 'tag3' }
      ]
      // No inputs array — multiselect doesn't have sub-inputs
    }
  ]
};

suite.test('Multiselect: array becomes comma-separated', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/10', new MockResponse(MULTISELECT_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 10, '1': ['tag1', 'tag3'] },
    10
  );

  TestAssert.equal(result['1'], 'tag1,tag3', 'Should be comma-separated');
  TestAssert.equal(typeof result['1'], 'string', 'Should be a string, not array');
});

suite.test('Multiselect: empty array becomes empty string', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/10', new MockResponse(MULTISELECT_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 10, '1': [] },
    10
  );

  TestAssert.equal(result['1'], '', 'Empty array should be empty string');
});

suite.test('Multiselect: single value array becomes single value string', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/10', new MockResponse(MULTISELECT_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 10, '1': ['tag2'] },
    10
  );

  TestAssert.equal(result['1'], 'tag2');
});

// =================================
// RADIO / DROPDOWN NORMALIZATION
// =================================

const RADIO_FORM = {
  id: 11,
  fields: [
    {
      id: 1,
      type: 'radio',
      label: 'Color',
      choices: [
        { text: 'Red', value: 'red' },
        { text: 'Blue', value: 'blue' }
      ]
      // No inputs array
    }
  ]
};

const DROPDOWN_FORM = {
  id: 12,
  fields: [
    {
      id: 1,
      type: 'select',
      label: 'Size',
      choices: [
        { text: 'Small', value: 'sm' },
        { text: 'Large', value: 'lg' }
      ]
    }
  ]
};

suite.test('Radio: array takes first element', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/11', new MockResponse(RADIO_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 11, '1': ['red', 'blue'] },
    11
  );

  TestAssert.equal(result['1'], 'red', 'Should take first element');
  TestAssert.equal(typeof result['1'], 'string');
});

suite.test('Dropdown: array takes first element', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/12', new MockResponse(DROPDOWN_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 12, '1': ['lg', 'sm'] },
    12
  );

  TestAssert.equal(result['1'], 'lg', 'Should take first element');
});

suite.test('Radio: empty array becomes empty string', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/11', new MockResponse(RADIO_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 11, '1': [] },
    11
  );

  TestAssert.equal(result['1'], '', 'Empty array should become empty string');
});

// =================================
// OPTION FIELD (inputType=checkbox)
// =================================

const OPTION_CHECKBOX_FORM = {
  id: 13,
  fields: [
    {
      id: 1,
      type: 'option',
      inputType: 'checkbox',
      label: 'Toppings',
      inputs: [
        { id: '1.1', label: 'Cheese' },
        { id: '1.2', label: 'Pepperoni' },
        { id: '1.3', label: 'Mushrooms' }
      ],
      choices: [
        { text: 'Cheese', value: 'cheese|1.50' },
        { text: 'Pepperoni', value: 'pepperoni|2.00' },
        { text: 'Mushrooms', value: 'mushrooms|1.00' }
      ]
    }
  ]
};

suite.test('Option(checkbox): expands to sub-inputs via inputType', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/13', new MockResponse(OPTION_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 13, '1': ['cheese|1.50', 'mushrooms|1.00'] },
    13
  );

  TestAssert.equal(result['1.1'], 'cheese|1.50', 'Cheese maps to 1.1');
  TestAssert.equal(result['1.2'], '', 'Pepperoni cleared');
  TestAssert.equal(result['1.3'], 'mushrooms|1.00', 'Mushrooms maps to 1.3');
});

suite.test('Option(checkbox): text matching works', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/13', new MockResponse(OPTION_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 13, '1': ['Cheese', 'Pepperoni'] },
    13
  );

  TestAssert.equal(result['1.1'], 'cheese|1.50', 'Matched by text, stored as value');
  TestAssert.equal(result['1.2'], 'pepperoni|2.00', 'Matched by text');
  TestAssert.equal(result['1.3'], '', 'Mushrooms cleared');
});

// =================================
// POST CATEGORY (inputType=multiselect)
// =================================

const POST_CAT_MULTISELECT_FORM = {
  id: 14,
  fields: [
    {
      id: 1,
      type: 'post_category',
      inputType: 'multiselect',
      label: 'Categories',
      choices: [
        { text: 'News', value: 'News:5' },
        { text: 'Tech', value: 'Tech:12' }
      ]
    }
  ]
};

suite.test('Post Category(multiselect): array becomes comma-separated', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/14', new MockResponse(POST_CAT_MULTISELECT_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 14, '1': ['News:5', 'Tech:12'] },
    14
  );

  TestAssert.equal(result['1'], 'News:5,Tech:12');
});

// =================================
// QUIZ / SURVEY / POLL CHECKBOX VARIANTS
// =================================

const QUIZ_CHECKBOX_FORM = {
  id: 15,
  fields: [
    {
      id: 1,
      type: 'quiz',
      inputType: 'checkbox',
      label: 'Select correct answers',
      inputs: [
        { id: '1.1', label: 'Answer A' },
        { id: '1.2', label: 'Answer B' },
        { id: '1.3', label: 'Answer C' }
      ],
      choices: [
        { text: 'Answer A', value: 'gquiz11' },
        { text: 'Answer B', value: 'gquiz12' },
        { text: 'Answer C', value: 'gquiz13' }
      ]
    }
  ]
};

suite.test('Quiz(checkbox): expands to sub-inputs', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/15', new MockResponse(QUIZ_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 15, '1': ['gquiz11', 'gquiz13'] },
    15
  );

  TestAssert.equal(result['1.1'], 'gquiz11');
  TestAssert.equal(result['1.2'], '', 'B cleared');
  TestAssert.equal(result['1.3'], 'gquiz13');
});

suite.test('Quiz(checkbox): text matching works', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/15', new MockResponse(QUIZ_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 15, '1': ['Answer A', 'Answer C'] },
    15
  );

  TestAssert.equal(result['1.1'], 'gquiz11', 'Matched by text, stored as value');
  TestAssert.equal(result['1.3'], 'gquiz13');
});

const SURVEY_CHECKBOX_FORM = {
  id: 16,
  fields: [
    {
      id: 1,
      type: 'survey',
      inputType: 'checkbox',
      label: 'Select all that apply',
      inputs: [
        { id: '1.1', label: 'Opt A' },
        { id: '1.2', label: 'Opt B' }
      ],
      choices: [
        { text: 'Opt A', value: 'gsurvey11' },
        { text: 'Opt B', value: 'gsurvey12' }
      ]
    }
  ]
};

suite.test('Survey(checkbox): expands to sub-inputs', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/16', new MockResponse(SURVEY_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 16, '1': ['gsurvey11'] },
    16
  );

  TestAssert.equal(result['1.1'], 'gsurvey11');
  TestAssert.equal(result['1.2'], '', 'B cleared');
});

const POLL_CHECKBOX_FORM = {
  id: 17,
  fields: [
    {
      id: 1,
      type: 'poll',
      inputType: 'checkbox',
      label: 'Vote for all you support',
      inputs: [
        { id: '1.1', label: 'Candidate A' },
        { id: '1.2', label: 'Candidate B' },
        { id: '1.3', label: 'Candidate C' }
      ],
      choices: [
        { text: 'Candidate A', value: 'gpoll1' },
        { text: 'Candidate B', value: 'gpoll2' },
        { text: 'Candidate C', value: 'gpoll3' }
      ]
    }
  ]
};

suite.test('Poll(checkbox): expands to sub-inputs', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/17', new MockResponse(POLL_CHECKBOX_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 17, '1': ['gpoll1', 'gpoll3'] },
    17
  );

  TestAssert.equal(result['1.1'], 'gpoll1');
  TestAssert.equal(result['1.2'], '', 'B cleared');
  TestAssert.equal(result['1.3'], 'gpoll3');
});

// =================================
// CUSTOM MULTI-VALUE FIELDS (entry_tags, etc.)
// =================================

const ENTRY_TAGS_FORM = {
  id: 18,
  fields: [
    {
      id: 1,
      type: 'entry_tags',
      label: 'Tags',
      // Inherits from GF_Field_MultiSelect: has choices, no inputs
      choices: [
        { text: 'Important', value: 'important' },
        { text: 'Follow-up', value: 'follow-up' },
        { text: 'Resolved', value: 'resolved' }
      ]
    }
  ]
};

suite.test('Entry Tags: array becomes comma-separated (multiselect inheritance)', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/18', new MockResponse(ENTRY_TAGS_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 18, '1': ['important', 'resolved'] },
    18
  );

  TestAssert.equal(result['1'], 'important,resolved', 'Should be comma-separated');
});

suite.test('Entry Tags: single tag becomes single string', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/18', new MockResponse(ENTRY_TAGS_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 18, '1': ['follow-up'] },
    18
  );

  TestAssert.equal(result['1'], 'follow-up');
});

// =================================
// LIST FIELD (passthrough)
// =================================

const LIST_SINGLE_FORM = {
  id: 19,
  fields: [
    { id: 1, type: 'list', label: 'Items', enableColumns: false }
  ]
};

const LIST_MULTI_FORM = {
  id: 21,
  fields: [
    { id: 1, type: 'list', label: 'Items', enableColumns: true,
      choices: [{ text: 'Name', value: 'Name' }, { text: 'Qty', value: 'Qty' }]
    }
  ]
};

suite.test('List(single-col): array passes through unchanged', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/19', new MockResponse(LIST_SINGLE_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 19, '1': ['apple', 'banana'] },
    19
  );

  TestAssert.equal(Array.isArray(result['1']), true, 'Should remain an array');
  TestAssert.equal(result['1'][0], 'apple');
  TestAssert.equal(result['1'][1], 'banana');
});

suite.test('List(multi-col): array-of-objects passes through unchanged', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/21', new MockResponse(LIST_MULTI_FORM));

  const input = [{ Name: 'Widget', Qty: '5' }, { Name: 'Gadget', Qty: '2' }];
  const result = await client._normalizeArrayValues(
    { form_id: 21, '1': input },
    21
  );

  TestAssert.equal(Array.isArray(result['1']), true, 'Should remain an array');
  TestAssert.equal(result['1'][0].Name, 'Widget');
  TestAssert.equal(result['1'][1].Qty, '2');
});

// =================================
// MIXED FIELD TYPES IN ONE FORM
// =================================

const MIXED_FORM = {
  id: 20,
  fields: [
    { id: 1, type: 'text', label: 'Name' },
    {
      id: 2, type: 'checkbox', label: 'Colors',
      inputs: [{ id: '2.1', label: 'Red' }, { id: '2.2', label: 'Blue' }],
      choices: [{ text: 'Red', value: 'red' }, { text: 'Blue', value: 'blue' }]
    },
    {
      id: 3, type: 'multiselect', label: 'Tags',
      choices: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }]
    },
    {
      id: 4, type: 'radio', label: 'Pick',
      choices: [{ text: 'X', value: 'x' }, { text: 'Y', value: 'y' }]
    }
  ]
};

suite.test('Mixed form: each field type normalized correctly', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/20', new MockResponse(MIXED_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 20, '1': 'John', '2': ['red'], '3': ['a', 'b'], '4': ['x'] },
    20
  );

  TestAssert.equal(result['1'], 'John', 'Text untouched');
  TestAssert.equal(result['2.1'], 'red', 'Checkbox expanded');
  TestAssert.equal(result['2.2'], '', 'Checkbox cleared');
  TestAssert.equal(result['2'], undefined, 'Checkbox key removed');
  TestAssert.equal(result['3'], 'a,b', 'Multiselect comma-separated');
  TestAssert.equal(result['4'], 'x', 'Radio takes first');
});

// =================================
// HTML-ENCODED CHOICE TEXT
// =================================

const HTML_ENCODED_FORM = {
  id: 30,
  fields: [
    {
      id: 1, type: 'checkbox', label: 'Items',
      // GF HTML-encodes choice text when stored
      inputs: [{ id: '1.1', label: 'Charts &amp; Graphs' }, { id: '1.2', label: 'Import &amp; Export' }, { id: '1.3', label: 'Plain' }],
      choices: [
        { text: 'Charts &amp; Graphs', value: 'charts' },
        { text: 'Import &amp; Export', value: 'import_export' },
        { text: 'Plain', value: 'plain' }
      ]
    }
  ]
};

suite.test('HTML-encoded: matches decoded text with &amp;', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/30', new MockResponse(HTML_ENCODED_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 30, '1': ['Charts & Graphs', 'Import & Export'] },
    30
  );

  TestAssert.equal(result['1.1'], 'charts', '& matches &amp; in text');
  TestAssert.equal(result['1.2'], 'import_export', '& matches &amp;');
  TestAssert.equal(result['1.3'], '', 'Plain cleared');
});

suite.test('HTML-encoded: exact encoded text also matches', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/30', new MockResponse(HTML_ENCODED_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 30, '1': ['Charts &amp; Graphs'] },
    30
  );

  TestAssert.equal(result['1.1'], 'charts', 'Exact encoded text matches too');
});

suite.test('HTML-encoded: value match still preferred over text', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/30', new MockResponse(HTML_ENCODED_FORM));

  const result = await client._normalizeArrayValues(
    { form_id: 30, '1': ['charts', 'import_export'] },
    30
  );

  TestAssert.equal(result['1.1'], 'charts', 'Value match works');
  TestAssert.equal(result['1.2'], 'import_export', 'Value match works');
});

// Run all tests
suite.run();
