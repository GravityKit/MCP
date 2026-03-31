/**
 * Field Validation Test Suite
 * 
 * Comprehensive tests for field-aware validation using
 * the field registry to ensure 100% valid structure.
 */

import { FieldAwareValidator } from '../config/field-validation.js';
import { 
  fieldRegistry,
  getFieldDefinition,
  isCompoundField,
  isArrayField,
  detectFieldVariant
} from '../field-definitions/field-registry.js';

// Test runner
let passedTests = 0;
let failedTests = 0;
const errors = [];

function test(description, fn) {
  try {
    fn();
    passedTests++;
    console.log(`✅ ${description}`);
  } catch (error) {
    failedTests++;
    errors.push({ test: description, error: error.message });
    console.log(`❌ ${description}`);
    console.log(`   Error: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Objects not equal:\nActual: ${JSON.stringify(actual)}\nExpected: ${JSON.stringify(expected)}`);
  }
}

console.log('🧪 Starting Field Validation Tests...\n');

// Test 1: Field Registry Loading
test('Field registry contains all major field types', () => {
  assert(fieldRegistry.text, 'Text field should exist');
  assert(fieldRegistry.email, 'Email field should exist');
  assert(fieldRegistry.address, 'Address field should exist');
  assert(fieldRegistry.fileupload, 'File upload field should exist');
  assert(fieldRegistry.checkbox, 'Checkbox field should exist');
  
  const fieldCount = Object.keys(fieldRegistry).length;
  assert(fieldCount >= 40, `Should have 40+ field types, got ${fieldCount}`);
});

// Test 2: Field Type Detection
test('Correctly identifies compound fields', () => {
  assert(isCompoundField('address'), 'Address should be compound');
  assert(isCompoundField('name'), 'Name should be compound');
  assert(isCompoundField('creditcard'), 'Credit card should be compound');
  assert(!isCompoundField('text'), 'Text should not be compound');
  assert(!isCompoundField('email'), 'Email should not be compound');
});

test('Correctly identifies array fields', () => {
  assert(isArrayField('checkbox'), 'Checkbox should be array');
  assert(isArrayField('multiselect'), 'Multiselect should be array');
  assert(isArrayField('list'), 'List should be array');
  assert(!isArrayField('text'), 'Text should not be array');
  assert(!isArrayField('radio'), 'Radio should not be array');
});

// Test 3: Field Variant Detection
test('Detects field variants correctly', () => {
  const passwordField = {
    type: 'text',
    enablePasswordInput: true
  };
  assertEqual(detectFieldVariant(passwordField), 'password', 'Should detect password variant');

  const normalTextField = {
    type: 'text'
  };
  assertEqual(detectFieldVariant(normalTextField), 'default', 'Should detect default variant');

  const multiFileField = {
    type: 'fileupload',
    multipleFiles: true
  };
  assertEqual(detectFieldVariant(multiFileField), 'multiple', 'Should detect multiple files variant');
});

// Test 4: Form Field Validation
test('Validates basic form fields', () => {
  const fields = [
    {
      id: '1',
      type: 'text',
      label: 'Name'
    },
    {
      id: '2',
      type: 'email',
      label: 'Email',
      isRequired: true
    }
  ];

  const validated = FieldAwareValidator.validateFormFields(fields);
  assertEqual(validated.length, 2, 'Should validate 2 fields');
  // _meta and _variant are stripped before returning (internal only)
  assert(!validated[0]._meta, 'Internal metadata should be stripped');
  assert(!validated[0]._variant, 'Internal variant should be stripped');
  assertEqual(validated[0].type, 'text', 'Field type preserved');
  assertEqual(validated[0].label, 'Name', 'Field label preserved');
});

test('Rejects invalid field configurations', () => {
  const invalidFields = [
    {
      // Missing type
      id: '1',
      label: 'Test'
    }
  ];

  try {
    FieldAwareValidator.validateFormFields(invalidFields);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error.message.includes('Field must have a type'), 'Should reject field without type');
  }
});

test('Validates choice fields', () => {
  const radioField = {
    id: '1',
    type: 'radio',
    label: 'Choose One',
    choices: [
      { text: 'Option 1', value: 'opt1' },
      { text: 'Option 2', value: 'opt2' }
    ]
  };

  const validation = FieldAwareValidator.validateField(radioField);
  assert(validation.isValid, 'Should validate radio field with choices');
});

test('Validates conditional logic', () => {
  const fieldWithLogic = {
    id: '1',
    type: 'text',
    label: 'Conditional Field',
    conditionalLogic: {
      actionType: 'show',
      logicType: 'all',
      rules: [
        {
          fieldId: '2',
          operator: 'is',
          value: 'yes'
        }
      ]
    }
  };

  const validation = FieldAwareValidator.validateField(fieldWithLogic);
  assert(validation.isValid, 'Should validate conditional logic');
});

// Test 5: Entry Data Validation
test('Validates entry data against form', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '1',
        type: 'text',
        label: 'Name',
        isRequired: true
      },
      {
        id: '2',
        type: 'email',
        label: 'Email'
      }
    ]
  };

  const entryData = {
    '1': 'John Doe',
    '2': 'john@example.com'
  };

  const validated = FieldAwareValidator.validateEntryData(entryData, form);
  assert(validated['1'] === 'John Doe', 'Should preserve text value');
  assert(validated['2'] === 'john@example.com', 'Should preserve email value');
});

test('Validates required fields in entries', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '1',
        type: 'text',
        label: 'Required Field',
        isRequired: true
      }
    ]
  };

  const entryData = {
    '1': '' // Empty required field
  };

  try {
    FieldAwareValidator.validateEntryData(entryData, form);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error.message.includes('is required'), 'Should reject empty required field');
  }
});

test('Validates email format', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '1',
        type: 'email',
        label: 'Email'
      }
    ]
  };

  const invalidEntry = {
    '1': 'not-an-email'
  };

  try {
    FieldAwareValidator.validateEntryData(invalidEntry, form);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error.message.includes('Invalid email'), 'Should reject invalid email');
  }
});

// Test 6: Compound Field Handling
test('Handles compound field data correctly', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '3',
        type: 'address',
        label: 'Address'
      }
    ]
  };

  const entryData = {
    '3.1': '123 Main St',
    '3.2': 'Apt 4',
    '3.3': 'New York',
    '3.4': 'NY',
    '3.5': '10001',
    '3.6': 'United States'
  };

  const validated = FieldAwareValidator.validateEntryData(entryData, form);
  assert(validated['3.1'] === '123 Main St', 'Should preserve street address');
  assert(validated['3.3'] === 'New York', 'Should preserve city');
});

test('Extracts compound field values', () => {
  const field = {
    id: '3',
    type: 'address'
  };

  const entryData = {
    '3.1': '123 Main St',
    '3.3': 'New York',
    '3.4': 'NY'
  };

  const definition = getFieldDefinition('address');
  const value = FieldAwareValidator.getFieldValue(entryData, field, definition);
  
  assert(value.street === '123 Main St', 'Should extract street');
  assert(value.city === 'New York', 'Should extract city');
  assert(value.state === 'NY', 'Should extract state');
});

// Test 7: Array Field Handling
test('Handles checkbox array data', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '4',
        type: 'checkbox',
        label: 'Options',
        choices: [
          { text: 'Option 1', value: 'opt1' },
          { text: 'Option 2', value: 'opt2' },
          { text: 'Option 3', value: 'opt3' }
        ]
      }
    ]
  };

  const entryData = {
    '4.1': 'opt1',
    '4.2': 'opt3'
  };

  const field = form.fields[0];
  const definition = getFieldDefinition('checkbox');
  const value = FieldAwareValidator.getFieldValue(entryData, field, definition);
  
  assert(Array.isArray(value), 'Should return array for checkbox');
  assertEqual(value.length, 2, 'Should have 2 selected values');
  assert(value.includes('opt1'), 'Should include first selection');
  assert(value.includes('opt3'), 'Should include second selection');
});

// Test 8: File Upload Variants
test('Handles file upload variants', () => {
  const singleFileField = {
    id: '5',
    type: 'fileupload',
    label: 'Single File',
    multipleFiles: false
  };

  const multiFileField = {
    id: '6',
    type: 'fileupload',
    label: 'Multiple Files',
    multipleFiles: true
  };

  assertEqual(detectFieldVariant(singleFileField), 'single', 'Should detect single file variant');
  assertEqual(detectFieldVariant(multiFileField), 'multiple', 'Should detect multiple files variant');

  // Validate multiple file JSON storage
  const form = {
    id: '1',
    fields: [multiFileField]
  };

  const validEntry = {
    '6': JSON.stringify(['file1.pdf', 'file2.jpg'])
  };

  const validated = FieldAwareValidator.validateEntryData(validEntry, form);
  assert(validated['6'], 'Should accept valid JSON array for multiple files');
});

// Test 9: Submission Processing
test('Processes form submission data', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '1',
        type: 'text',
        label: 'Name'
      },
      {
        id: '2',
        type: 'email',
        label: 'Email'
      }
    ]
  };

  const submissionData = {
    'input_1': 'John Doe',
    'input_2': 'john@example.com'
  };

  const processed = FieldAwareValidator.processSubmissionData(submissionData, form);
  assertEqual(processed['1'], 'John Doe', 'Should process text field');
  assertEqual(processed['2'], 'john@example.com', 'Should process email field');
  assert(processed.form_id === '1', 'Should include form ID');
  assert(processed.status === 'active', 'Should set active status');
});

test('Processes compound field submission', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '3',
        type: 'name',
        label: 'Full Name'
      }
    ]
  };

  const submissionData = {
    'input_3_2': 'John',    // First name
    'input_3_6': 'Doe'      // Last name
  };

  const processed = FieldAwareValidator.processSubmissionData(submissionData, form);
  assertEqual(processed['3.2'], 'John', 'Should process first name');
  assertEqual(processed['3.6'], 'Doe', 'Should process last name');
});

test('Processes checkbox submission', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '4',
        type: 'checkbox',
        label: 'Options',
        choices: [
          { text: 'A', value: 'a' },
          { text: 'B', value: 'b' },
          { text: 'C', value: 'c' }
        ]
      }
    ]
  };

  const submissionData = {
    'input_4_1': 'a',
    'input_4_2': 'c'  // Changed from input_4_3 to input_4_2 for sequential numbering
  };

  const processed = FieldAwareValidator.processSubmissionData(submissionData, form);
  assertEqual(processed['4.1'], 'a', 'Should process first checkbox');
  assertEqual(processed['4.2'], 'c', 'Should process second checkbox');
});

// Test 10: Unknown Field Types
test('Handles unknown field types gracefully', () => {
  const fields = [
    {
      id: '1',
      type: 'custom_field_type',
      label: 'Custom Field'
    }
  ];

  const validated = FieldAwareValidator.validateFormFields(fields);
  assertEqual(validated.length, 1, 'Should allow unknown field types');
  assert(validated[0]._unknown === true, 'Should mark as unknown');
});

// Test 11: Validation Summary
test('Generates validation summary', () => {
  const form = {
    id: '1',
    fields: [
      {
        id: '1',
        type: 'text',
        label: 'Text',
        isRequired: true
      },
      {
        id: '2',
        type: 'address',
        label: 'Address',
        conditionalLogic: {
          actionType: 'show',
          logicType: 'all',
          rules: []
        }
      },
      {
        id: '3',
        type: 'checkbox',
        label: 'Options',
        choices: []
      },
      {
        id: '4',
        type: 'unknown_type',
        label: 'Unknown'
      }
    ]
  };

  const summary = FieldAwareValidator.getValidationSummary(form);
  assertEqual(summary.totalFields, 4, 'Should count total fields');
  assertEqual(summary.requiredFields, 1, 'Should count required fields');
  assertEqual(summary.conditionalFields, 1, 'Should count conditional fields');
  assertEqual(summary.compoundFields, 1, 'Should count compound fields');
  assertEqual(summary.arrayFields, 1, 'Should count array fields');
  assert(summary.unknownTypes.includes('unknown_type'), 'Should track unknown types');
});

// Print test results
console.log('\n' + '='.repeat(50));
console.log('📊 Test Results:');
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log('\n❌ Failed Tests:');
  errors.forEach(({ test, error }) => {
    console.log(`  - ${test}: ${error}`);
  });
  process.exit(1);
} else {
  console.log('\n🎉 All field validation tests passed!');
  process.exit(0);
}