/**
 * Integration tests for field operations with real API calls
 * Tests the complete flow from MCP tool calls to API interactions
 */

import { fieldOperationHandlers, createFieldOperations } from '../src/field-operations/index.js';
import { testConfig, TestFormManager } from '../src/config/test-config.js';
import GravityFormsClient from '../src/gravity-forms-client.js';
import fieldRegistry from '../src/field-definitions/field-registry.js';
import FieldAwareValidator from '../src/config/field-validation.js';

console.log('🧪 Field Operations Integration Tests\n');

// Skip tests if no credentials
if (!process.env.TEST_GF_CONSUMER_KEY || !process.env.TEST_GF_CONSUMER_SECRET) {
  console.log('⚠️ Skipping integration tests - missing test credentials');
  console.log('Set TEST_GF_CONSUMER_KEY and TEST_GF_CONSUMER_SECRET to run tests');
  process.exit(0);
}

let apiClient;
let testFormManager;
let fieldOperations;
let testForm;

/**
 * Setup test environment
 */
async function setup() {
  try {
    // Initialize API client with test configuration
    apiClient = new GravityFormsClient({
      GRAVITY_FORMS_CONSUMER_KEY: process.env.TEST_GF_CONSUMER_KEY,
      GRAVITY_FORMS_CONSUMER_SECRET: process.env.TEST_GF_CONSUMER_SECRET,
      GRAVITY_FORMS_BASE_URL: process.env.TEST_GF_URL || 'http://localhost:10003'
    });

    const validation = await apiClient.initialize();
    if (!validation.available) {
      throw new Error('Test API not available: ' + validation.error);
    }

    // Create test form manager
    testFormManager = new TestFormManager(apiClient, testConfig);

    // Exercise the REAL field-operations layer (FieldManager plus the dependency
    // and position engines), not a hand-rolled reimplementation. A local mock
    // drifts from production behavior; createFieldOperations is exactly what
    // src/index.js wires up, so this test catches real regressions.
    const validator = new FieldAwareValidator();
    fieldOperations = createFieldOperations(apiClient, fieldRegistry, validator);

    console.log('✅ Test environment initialized');
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

/**
 * Create test form
 */
async function createTestForm() {
  try {
    testForm = await testFormManager.createTestForm('FieldOpsIntegration', [
      {
        id: 1,
        type: 'text',
        label: 'Name',
        isRequired: true
      },
      {
        id: 2,
        type: 'email',
        label: 'Email'
      }
    ]);

    console.log(`✅ Created test form: ${testForm.id}`);
    return testForm;
  } catch (error) {
    console.error('❌ Failed to create test form:', error.message);
    throw error;
  }
}

/**
 * Test gf_add_field tool
 */
async function testAddField() {
  console.log('\n🔧 Testing gf_add_field...');

  try {
    const result = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'textarea',
      properties: {
        label: 'Comments',
        placeholder: 'Enter your comments here',
        isRequired: false
      },
      position: {
        mode: 'append'
      }
    }, fieldOperations);

    if (result.success) {
      console.log(`  ✅ Added field: ${result.field.label} (ID: ${result.field.id})`);
      console.log(`  📍 Position: ${result.position.index}`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      return false;
    }

    // Verify field was actually added
    const updatedForm = await apiClient.getForm(testForm.id);
    const addedField = updatedForm.fields.find(f => f.label === 'Comments');

    if (addedField) {
      console.log('  ✅ Field verified in form');
      return true;
    } else {
      console.log('  ❌ Field not found in form');
      return false;
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Test gf_update_field tool
 */
async function testUpdateField() {
  console.log('\n🔧 Testing gf_update_field...');

  try {
    // Get current form to find a field to update
    const form = await apiClient.getForm(testForm.id);
    const fieldToUpdate = form.fields.find(f => f.label === 'Email');

    if (!fieldToUpdate) {
      console.log('  ❌ No field to update found');
      return false;
    }

    const result = await fieldOperationHandlers.gf_update_field({
      form_id: testForm.id,
      field_id: fieldToUpdate.id,
      properties: {
        label: 'Email Address',
        isRequired: true,
        placeholder: 'your@email.com'
      }
    }, fieldOperations);

    if (result.success) {
      console.log(`  ✅ Updated field: ${result.field.label}`);
      console.log(`  📝 Changes: ${Object.keys(result.changes.after).length} properties`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      return false;
    }

    // Verify changes
    const updatedForm = await apiClient.getForm(testForm.id);
    const updatedField = updatedForm.fields.find(f => f.id == fieldToUpdate.id);

    if (updatedField && updatedField.label === 'Email Address') {
      console.log('  ✅ Update verified in form');
      return true;
    } else {
      console.log('  ❌ Update not found in form');
      return false;
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Test gf_list_field_types tool
 */
async function testListFieldTypes() {
  console.log('\n🔧 Testing gf_list_field_types...');

  try {
    // gf_list_field_types returns { field_types, total } (or { error }) — no
    // success/categories envelope.
    const result = await fieldOperationHandlers.gf_list_field_types({
      category: 'standard'
    }, fieldOperations);

    if (result.error) {
      console.log(`  ❌ Failed: ${result.error}`);
      return false;
    }

    console.log(`  ✅ Listed ${result.total} field types`);

    // Check for expected field types
    const hasText = result.field_types.some(f => f.type === 'text');
    const hasEmail = result.field_types.some(f => f.type === 'email');

    if (hasText && hasEmail) {
      console.log('  ✅ Expected field types found');
      return true;
    } else {
      console.log('  ❌ Missing expected field types');
      return false;
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Test gf_delete_field tool
 */
async function testDeleteField() {
  console.log('\n🔧 Testing gf_delete_field...');

  try {
    // Get current form to find a field to delete
    const form = await apiClient.getForm(testForm.id);
    const fieldToDelete = form.fields.find(f => f.label === 'Comments');

    if (!fieldToDelete) {
      console.log('  ❌ No field to delete found');
      return false;
    }

    const result = await fieldOperationHandlers.gf_delete_field({
      form_id: testForm.id,
      field_id: fieldToDelete.id,
      force: true
    }, fieldOperations);

    if (result.success) {
      console.log(`  ✅ Deleted field: ${result.deleted_field.label}`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      return false;
    }

    // Verify field was deleted
    const updatedForm = await apiClient.getForm(testForm.id);
    const deletedField = updatedForm.fields.find(f => f.id == fieldToDelete.id);

    if (!deletedField) {
      console.log('  ✅ Deletion verified in form');
      return true;
    } else {
      console.log('  ❌ Field still exists in form');
      return false;
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Cleanup test resources
 */
async function cleanup() {
  try {
    if (testFormManager && testForm) {
      await testFormManager.deleteTestForm(testForm.id);
      console.log('\n🧹 Test form cleaned up');
    }
  } catch (error) {
    console.log('\n⚠️ Cleanup warning:', error.message);
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('🚀 Starting Field Operations Integration Tests\n');

  await setup();
  await createTestForm();

  const results = [];

  // Run all tests
  results.push(await testAddField());
  results.push(await testUpdateField());
  results.push(await testListFieldTypes());
  results.push(await testDeleteField());

  await cleanup();

  // Report results
  const passed = results.filter(r => r).length;
  const total = results.length;

  console.log('\n📊 Integration Test Results:');
  console.log(`  ✅ Passed: ${passed}/${total}`);
  console.log(`  ❌ Failed: ${total - passed}/${total}`);

  if (passed === total) {
    console.log('\n🎉 All integration tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️ Some integration tests failed');
    process.exit(1);
  }
}

// Handle cleanup on exit
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Run tests
runTests().catch(error => {
  console.error('\n💥 Test runner error:', error);
  cleanup().finally(() => process.exit(1));
});
