/**
 * End-to-End tests for complete field operations workflows
 * Tests real-world scenarios from user perspective
 */

import { fieldOperationHandlers } from '../src/field-operations/index.js';
import { testConfig, TestFormManager } from '../src/config/test-config.js';
import GravityFormsClient from '../src/gravity-forms-client.js';
import FieldAwareValidator from '../src/config/field-validation.js';

console.log('🎭 Field Operations E2E Test Scenarios\n');

// Skip tests if no credentials
if (!process.env.TEST_GF_CONSUMER_KEY || !process.env.TEST_GF_CONSUMER_SECRET) {
  console.log('⚠️ Skipping E2E tests - missing test credentials');
  console.log('Set TEST_GF_CONSUMER_KEY and TEST_GF_CONSUMER_SECRET to run tests');
  process.exit(0);
}

let apiClient;
let testFormManager;
let fieldOperations;
let testForm;

/**
 * Setup E2E test environment
 */
async function setupE2E() {
  try {
    // Initialize API client
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

    // Initialize full field operations system
    const validator = new FieldAwareValidator();
    fieldOperations = {
      fieldManager: {
        addField: async (formId, fieldType, properties, position) => {
          const form = await apiClient.getForm(formId);
          const nextId = Math.max(...form.fields.map(f => parseInt(f.id) || 0), 0) + 1;
          
          // Create field with proper structure
          const field = {
            id: nextId,
            type: fieldType,
            label: properties.label || `Field ${nextId}`,
            isRequired: properties.isRequired || false,
            ...properties
          };

          // Handle compound fields
          if (['address', 'name', 'creditcard'].includes(fieldType)) {
            field.inputs = generateSubInputs(field, fieldType);
          }

          form.fields.push(field);
          await apiClient.updateForm(form);

          return {
            success: true,
            field,
            form_id: formId,
            position: { index: form.fields.length - 1 }
          };
        },
        updateField: async (formId, fieldId, properties) => {
          const form = await apiClient.getForm(formId);
          const fieldIndex = form.fields.findIndex(f => f.id == fieldId);
          
          if (fieldIndex === -1) {
            throw new Error(`Field ${fieldId} not found`);
          }

          const originalField = { ...form.fields[fieldIndex] };
          form.fields[fieldIndex] = {
            ...originalField,
            ...properties,
            id: originalField.id
          };

          await apiClient.updateForm(form);

          return {
            success: true,
            field: form.fields[fieldIndex],
            changes: {
              before: originalField,
              after: form.fields[fieldIndex]
            },
            warnings: { dependencies: [] }
          };
        },
        deleteField: async (formId, fieldId, options = {}) => {
          const form = await apiClient.getForm(formId);
          const field = form.fields.find(f => f.id == fieldId);
          
          if (!field) {
            throw new Error(`Field ${fieldId} not found`);
          }

          form.fields = form.fields.filter(f => f.id != fieldId);
          await apiClient.updateForm(form);

          return {
            success: true,
            deleted_field: {
              id: field.id,
              type: field.type,
              label: field.label
            },
            dependencies: {},
            actions_taken: []
          };
        }
      },
      dependencyTracker: {
        scanFormDependencies: () => ({ conditionalLogic: [] }),
        hasBreakingDependencies: () => false
      },
      positionEngine: {
        calculatePosition: (fields, config) => fields.length
      },
      config: testConfig
    };

    console.log('✅ E2E test environment initialized');
  } catch (error) {
    console.error('❌ E2E setup failed:', error.message);
    process.exit(1);
  }
}

/**
 * Generate sub-inputs for compound fields
 */
function generateSubInputs(field, fieldType) {
  const inputs = [];
  
  if (fieldType === 'address') {
    const subInputs = [
      { suffix: '.1', label: 'Street Address' },
      { suffix: '.2', label: 'Address Line 2' },
      { suffix: '.3', label: 'City' },
      { suffix: '.4', label: 'State' },
      { suffix: '.5', label: 'ZIP Code' },
      { suffix: '.6', label: 'Country' }
    ];
    
    subInputs.forEach((input, index) => {
      inputs.push({
        id: field.id + input.suffix,
        label: input.label,
        name: `input_${field.id}_${index + 1}`
      });
    });
  }
  
  return inputs;
}

/**
 * Create initial test form for E2E scenarios
 */
async function createE2ETestForm() {
  try {
    testForm = await testFormManager.createTestForm('E2E_FieldOps', [
      {
        id: 1,
        type: 'text',
        label: 'Contact Name',
        isRequired: true
      },
      {
        id: 2,
        type: 'email',
        label: 'Email Address',
        isRequired: true
      }
    ]);

    console.log(`✅ Created E2E test form: ${testForm.id}\n`);
    return testForm;
  } catch (error) {
    console.error('❌ Failed to create E2E test form:', error.message);
    throw error;
  }
}

/**
 * E2E Scenario 1: Complete Contact Form Creation
 * Build a comprehensive contact form from scratch
 */
async function scenario1_CompleteContactForm() {
  console.log('🎭 Scenario 1: Complete Contact Form Creation');
  const results = [];

  try {
    // Step 1: Add company field
    console.log('  Step 1: Adding company field...');
    const companyResult = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'text',
      properties: {
        label: 'Company Name',
        placeholder: 'Enter your company name',
        size: 'large'
      },
      position: { mode: 'after', reference: 2 }
    }, fieldOperations);

    if (companyResult.success) {
      console.log(`    ✅ Added company field (ID: ${companyResult.field.id})`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to add company field: ${companyResult.error}`);
      results.push(false);
    }

    // Step 2: Add phone number
    console.log('  Step 2: Adding phone field...');
    const phoneResult = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'phone',
      properties: {
        label: 'Phone Number',
        phoneFormat: 'standard',
        isRequired: true
      },
      position: { mode: 'append' }
    }, fieldOperations);

    if (phoneResult.success) {
      console.log(`    ✅ Added phone field (ID: ${phoneResult.field.id})`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to add phone field: ${phoneResult.error}`);
      results.push(false);
    }

    // Step 3: Add address field (compound)
    console.log('  Step 3: Adding address field...');
    const addressResult = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'address',
      properties: {
        label: 'Business Address',
        addressType: 'us',
        isRequired: false
      },
      position: { mode: 'append' }
    }, fieldOperations);

    if (addressResult.success) {
      console.log(`    ✅ Added address field (ID: ${addressResult.field.id})`);
      console.log(`    📋 Address has ${addressResult.field.inputs?.length || 0} sub-inputs`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to add address field: ${addressResult.error}`);
      results.push(false);
    }

    // Step 4: Add message textarea
    console.log('  Step 4: Adding message field...');
    const messageResult = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'textarea',
      properties: {
        label: 'Message',
        placeholder: 'Tell us about your project...',
        rows: 5,
        isRequired: true
      },
      position: { mode: 'append' }
    }, fieldOperations);

    if (messageResult.success) {
      console.log(`    ✅ Added message field (ID: ${messageResult.field.id})`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to add message field: ${messageResult.error}`);
      results.push(false);
    }

    // Step 5: Update email field with better properties
    console.log('  Step 5: Enhancing email field...');
    const emailUpdateResult = await fieldOperationHandlers.gf_update_field({
      form_id: testForm.id,
      field_id: 2,
      properties: {
        placeholder: 'your@email.com',
        emailConfirmEnabled: true
      }
    }, fieldOperations);

    if (emailUpdateResult.success) {
      console.log(`    ✅ Enhanced email field with confirmation`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to enhance email field: ${emailUpdateResult.error}`);
      results.push(false);
    }

    const successCount = results.filter(r => r).length;
    console.log(`  📊 Scenario 1 Results: ${successCount}/${results.length} steps successful\n`);
    
    return successCount === results.length;

  } catch (error) {
    console.log(`  💥 Scenario 1 Error: ${error.message}\n`);
    return false;
  }
}

/**
 * E2E Scenario 2: Form Restructuring Workflow
 * Demonstrate field reorganization and dependency management
 */
async function scenario2_FormRestructuring() {
  console.log('🎭 Scenario 2: Form Restructuring Workflow');
  const results = [];

  try {
    // Step 1: Get current form state
    console.log('  Step 1: Analyzing current form structure...');
    const currentForm = await apiClient.getForm(testForm.id);
    console.log(`    📋 Form has ${currentForm.fields.length} fields`);

    // Step 2: Add a priority dropdown
    console.log('  Step 2: Adding priority field...');
    const priorityResult = await fieldOperationHandlers.gf_add_field({
      form_id: testForm.id,
      field_type: 'select',
      properties: {
        label: 'Priority Level',
        choices: [
          { text: 'Low', value: 'low' },
          { text: 'Medium', value: 'medium' },
          { text: 'High', value: 'high' },
          { text: 'Urgent', value: 'urgent' }
        ],
        defaultValue: 'medium'
      },
      position: { mode: 'after', reference: currentForm.fields[currentForm.fields.length - 1].id }
    }, fieldOperations);

    if (priorityResult.success) {
      console.log(`    ✅ Added priority field (ID: ${priorityResult.field.id})`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to add priority field: ${priorityResult.error}`);
      results.push(false);
    }

    // Step 3: Update form title to reflect new structure
    console.log('  Step 3: Updating form configuration...');
    const updatedForm = await apiClient.getForm(testForm.id);
    updatedForm.title = 'Enhanced Contact Form - E2E Test';
    updatedForm.description = 'Complete contact form with priority handling';
    
    await apiClient.updateForm(updatedForm);
    console.log('    ✅ Updated form metadata');
    results.push(true);

    // Step 4: Verify field listing works
    console.log('  Step 4: Testing field type listing...');
    const fieldTypesResult = await fieldOperationHandlers.gf_list_field_types({
      category: 'standard',
      include_variants: false
    }, fieldOperations);

    if (fieldTypesResult.success && fieldTypesResult.total > 0) {
      console.log(`    ✅ Listed ${fieldTypesResult.total} field types`);
      results.push(true);
    } else {
      console.log(`    ❌ Failed to list field types: ${fieldTypesResult.error}`);
      results.push(false);
    }

    const successCount = results.filter(r => r).length;
    console.log(`  📊 Scenario 2 Results: ${successCount}/${results.length} steps successful\n`);
    
    return successCount === results.length;

  } catch (error) {
    console.log(`  💥 Scenario 2 Error: ${error.message}\n`);
    return false;
  }
}

/**
 * E2E Scenario 3: Field Cleanup and Optimization
 * Test field deletion and form optimization
 */
async function scenario3_FieldCleanup() {
  console.log('🎭 Scenario 3: Field Cleanup and Optimization');
  const results = [];

  try {
    // Step 1: Get current form state
    const currentForm = await apiClient.getForm(testForm.id);
    const initialFieldCount = currentForm.fields.length;
    console.log(`  Step 1: Current form has ${initialFieldCount} fields`);

    // Step 2: Find a field to remove (let's remove company field if it exists)
    const companyField = currentForm.fields.find(f => f.label && f.label.includes('Company'));
    
    if (companyField) {
      console.log(`  Step 2: Removing company field (ID: ${companyField.id})...`);
      const deleteResult = await fieldOperationHandlers.gf_delete_field({
        form_id: testForm.id,
        field_id: companyField.id,
        force: true
      }, fieldOperations);

      if (deleteResult.success) {
        console.log(`    ✅ Removed company field: ${deleteResult.deleted_field.label}`);
        results.push(true);
      } else {
        console.log(`    ❌ Failed to remove company field: ${deleteResult.error}`);
        results.push(false);
      }
    } else {
      console.log('  Step 2: No company field found to remove');
      results.push(true); // Not an error
    }

    // Step 3: Verify field count reduced
    const updatedForm = await apiClient.getForm(testForm.id);
    const finalFieldCount = updatedForm.fields.length;
    
    if (companyField && finalFieldCount < initialFieldCount) {
      console.log(`  Step 3: ✅ Field count reduced from ${initialFieldCount} to ${finalFieldCount}`);
      results.push(true);
    } else if (!companyField) {
      console.log(`  Step 3: ✅ Field count verified: ${finalFieldCount} fields`);
      results.push(true);
    } else {
      console.log(`  Step 3: ❌ Field count unchanged: ${finalFieldCount} fields`);
      results.push(false);
    }

    // Step 4: Update remaining fields for optimization
    const emailField = updatedForm.fields.find(f => f.type === 'email');
    if (emailField) {
      console.log(`  Step 4: Optimizing email field (ID: ${emailField.id})...`);
      const optimizeResult = await fieldOperationHandlers.gf_update_field({
        form_id: testForm.id,
        field_id: emailField.id,
        properties: {
          label: 'Email Address (Required)',
          description: 'We will use this to contact you about your inquiry',
          placeholder: 'Enter your email address'
        }
      }, fieldOperations);

      if (optimizeResult.success) {
        console.log(`    ✅ Optimized email field`);
        results.push(true);
      } else {
        console.log(`    ❌ Failed to optimize email field: ${optimizeResult.error}`);
        results.push(false);
      }
    } else {
      console.log('  Step 4: No email field found to optimize');
      results.push(true);
    }

    const successCount = results.filter(r => r).length;
    console.log(`  📊 Scenario 3 Results: ${successCount}/${results.length} steps successful\n`);
    
    return successCount === results.length;

  } catch (error) {
    console.log(`  💥 Scenario 3 Error: ${error.message}\n`);
    return false;
  }
}

/**
 * Final form verification
 */
async function verifyFinalForm() {
  console.log('🔍 Final Form Verification');
  
  try {
    const finalForm = await apiClient.getForm(testForm.id);
    
    console.log('  📋 Final Form Summary:');
    console.log(`    - Title: ${finalForm.title}`);
    console.log(`    - Total Fields: ${finalForm.fields.length}`);
    console.log(`    - Field Types Used:`);
    
    const fieldTypes = {};
    finalForm.fields.forEach(field => {
      fieldTypes[field.type] = (fieldTypes[field.type] || 0) + 1;
    });
    
    Object.entries(fieldTypes).forEach(([type, count]) => {
      console.log(`      • ${type}: ${count}`);
    });
    
    // Count compound fields
    const compoundFields = finalForm.fields.filter(f => f.inputs && f.inputs.length > 0);
    if (compoundFields.length > 0) {
      console.log(`    - Compound Fields: ${compoundFields.length}`);
      compoundFields.forEach(field => {
        console.log(`      • ${field.label}: ${field.inputs.length} sub-inputs`);
      });
    }
    
    console.log('  ✅ Final verification complete\n');
    return true;
    
  } catch (error) {
    console.log(`  ❌ Final verification failed: ${error.message}\n`);
    return false;
  }
}

/**
 * Cleanup E2E test resources
 */
async function cleanupE2E() {
  try {
    if (testFormManager && testForm) {
      await testFormManager.deleteTestForm(testForm.id);
      console.log('🧹 E2E test form cleaned up');
    }
  } catch (error) {
    console.log('⚠️ E2E cleanup warning:', error.message);
  }
}

/**
 * Run all E2E scenarios
 */
async function runE2EScenarios() {
  console.log('🚀 Starting Field Operations E2E Test Scenarios\n');

  await setupE2E();
  await createE2ETestForm();

  const scenarios = [];
  
  // Run scenarios sequentially
  scenarios.push(await scenario1_CompleteContactForm());
  scenarios.push(await scenario2_FormRestructuring());
  scenarios.push(await scenario3_FieldCleanup());
  
  // Final verification
  const verification = await verifyFinalForm();
  
  await cleanupE2E();

  // Report results
  const passed = scenarios.filter(r => r).length;
  const total = scenarios.length;
  
  console.log('📊 E2E Test Scenarios Results:');
  console.log(`  ✅ Scenarios Passed: ${passed}/${total}`);
  console.log(`  🔍 Final Verification: ${verification ? 'PASSED' : 'FAILED'}`);
  
  if (passed === total && verification) {
    console.log('\n🎉 All E2E scenarios completed successfully!');
    console.log('✨ Field operations are working end-to-end!');
    process.exit(0);
  } else {
    console.log('\n⚠️ Some E2E scenarios had issues');
    console.log('🔧 Review logs above for details');
    process.exit(1);
  }
}

// Handle cleanup on exit
process.on('SIGINT', cleanupE2E);
process.on('SIGTERM', cleanupE2E);

// Run E2E scenarios
runE2EScenarios().catch(error => {
  console.error('\n💥 E2E test runner error:', error);
  cleanupE2E().finally(() => process.exit(1));
});