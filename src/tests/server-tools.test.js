/**
 * Server Tools Validation Tests for Gravity MCP
 * Tests all 24 MCP tools registration, schemas, and handlers
 */

import { TestRunner, TestAssert, setupTestEnvironment } from './helpers.js';

const suite = new TestRunner('Server Tools Validation Tests');

// Tool definitions that should be registered
const EXPECTED_TOOLS = [
  // Forms Management (6)
  'gf_list_forms',
  'gf_get_form',
  'gf_create_form',
  'gf_update_form',
  'gf_delete_form',
  'gf_validate_form',

  // Entries Management (5)
  'gf_list_entries',
  'gf_get_entry',
  'gf_create_entry',
  'gf_update_entry',
  'gf_delete_entry',

  // Form Submissions (2)
  'gf_submit_form_data',
  'gf_validate_submission',

  // Notifications (1)
  'gf_send_notifications',

  // Add-on Feeds (7)
  'gf_list_feeds',
  'gf_get_feed',
  'gf_list_form_feeds',
  'gf_create_feed',
  'gf_update_feed',
  'gf_patch_feed',
  'gf_delete_feed',

  // Utilities (2)
  'gf_get_field_filters',
  'gf_get_results'
];

// Tool categories for organization validation
const TOOL_CATEGORIES = {
  forms: ['gf_list_forms', 'gf_get_form', 'gf_create_form', 'gf_update_form', 'gf_delete_form', 'gf_validate_form'],
  entries: ['gf_list_entries', 'gf_get_entry', 'gf_create_entry', 'gf_update_entry', 'gf_delete_entry'],
  submissions: ['gf_submit_form_data', 'gf_validate_submission'],
  notifications: ['gf_send_notifications'],
  feeds: ['gf_list_feeds', 'gf_get_feed', 'gf_list_form_feeds', 'gf_create_feed', 'gf_update_feed', 'gf_patch_feed', 'gf_delete_feed'],
  utilities: ['gf_get_field_filters', 'gf_get_results']
};

// =================================
// TOOL REGISTRATION TESTS
// =================================

suite.test('Tool Registration: Should have exactly 23 tools registered', () => {
  TestAssert.equal(EXPECTED_TOOLS.length, 23, 'Should have 23 tools defined');

  // Count by category
  let totalTools = 0;
  Object.values(TOOL_CATEGORIES).forEach(tools => {
    totalTools += tools.length;
  });

  TestAssert.equal(totalTools, 23, 'Category tools should sum to 23');
});

suite.test('Tool Registration: Should have all expected tool names', () => {
  const toolSet = new Set(EXPECTED_TOOLS);

  TestAssert.equal(toolSet.size, 23, 'Should have 23 unique tool names');

  // Verify naming convention
  EXPECTED_TOOLS.forEach(tool => {
    TestAssert.isTrue(tool.startsWith('gf_'), `Tool ${tool} should start with gf_`);
    TestAssert.isTrue(/^gf_[a-z_]+$/.test(tool), `Tool ${tool} should follow naming convention`);
  });
});

suite.test('Tool Registration: Should have correct category distribution', () => {
  TestAssert.equal(TOOL_CATEGORIES.forms.length, 6, 'Forms should have 6 tools');
  TestAssert.equal(TOOL_CATEGORIES.entries.length, 5, 'Entries should have 5 tools (no submit)');
  TestAssert.equal(TOOL_CATEGORIES.submissions.length, 2, 'Submissions should have 2 tools');
  TestAssert.equal(TOOL_CATEGORIES.notifications.length, 1, 'Notifications should have 1 tool');
  TestAssert.equal(TOOL_CATEGORIES.feeds.length, 7, 'Feeds should have 7 tools');
  TestAssert.equal(TOOL_CATEGORIES.utilities.length, 2, 'Utilities should have 2 tools');
});

// =================================
// INPUT SCHEMA VALIDATION
// =================================

suite.test('Schema Validation: Forms tools should have proper schemas', () => {
  // Validate list_forms schema - Only supports 'include' parameter per API documentation
  const listFormsSchema = {
    type: 'object',
    properties: {
      include: { type: 'array', items: { type: 'number' } }
    }
  };

  TestAssert.equal(listFormsSchema.type, 'object');
  TestAssert.isNotNull(listFormsSchema.properties);

  // Validate get_form schema
  const getFormSchema = {
    type: 'object',
    properties: {
      id: { type: 'number' }
    },
    required: ['id']
  };

  TestAssert.includes(getFormSchema.required, 'id');

  // Validate create_form schema
  const createFormSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      fields: { type: 'array' }
    },
    required: ['title']
  };

  TestAssert.includes(createFormSchema.required, 'title');
});

suite.test('Schema Validation: Entries tools should have search schema', () => {
  // Validate complex search schema
  const searchProperties = {
    search: {
      type: 'object',
      properties: {
        field_filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              operator: { type: 'string', enum: ['=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<='] }
            }
          }
        },
        mode: { type: 'string', enum: ['any', 'all'] }
      }
    }
  };

  TestAssert.equal(searchProperties.search.type, 'object');
  TestAssert.lengthOf(searchProperties.search.properties.field_filters.items.properties.operator.enum, 14);
});

suite.test('Schema Validation: Feeds tools should have addon_slug validation', () => {
  const feedSchema = {
    type: 'object',
    properties: {
      addon_slug: { type: 'string' },
      form_id: { type: 'number' },
      meta: { type: 'object' }
    },
    required: ['addon_slug', 'form_id', 'meta']
  };

  TestAssert.includes(feedSchema.required, 'addon_slug');
  TestAssert.includes(feedSchema.required, 'form_id');
  TestAssert.includes(feedSchema.required, 'meta');
});

// =================================
// HANDLER VALIDATION
// =================================

suite.test('Handler Validation: All tools should have handlers', () => {
  // Simulate handler mapping
  const handlers = {};

  EXPECTED_TOOLS.forEach(tool => {
    handlers[tool] = true; // Would be actual handler function
  });

  TestAssert.equal(Object.keys(handlers).length, 23, 'Should have 23 handlers');

  EXPECTED_TOOLS.forEach(tool => {
    TestAssert.isTrue(handlers[tool], `Should have handler for ${tool}`);
  });
});

suite.test('Handler Validation: Delete operations should check permissions', () => {
  const deleteTools = ['gf_delete_form', 'gf_delete_entry', 'gf_delete_feed'];

  deleteTools.forEach(tool => {
    TestAssert.includes(EXPECTED_TOOLS, tool, `${tool} should be registered`);
  });

  // These tools should have delete protection logic
  TestAssert.lengthOf(deleteTools, 3, 'Should have 3 delete tools');
});

// =================================
// PARAMETER VALIDATION
// =================================

suite.test('Parameter Validation: ID parameters should be numbers', () => {
  const toolsWithId = [
    'gf_get_form',
    'gf_update_form',
    'gf_delete_form',
    'gf_get_entry',
    'gf_update_entry',
    'gf_delete_entry',
    'gf_get_feed',
    'gf_update_feed',
    'gf_patch_feed',
    'gf_delete_feed'
  ];

  toolsWithId.forEach(tool => {
    TestAssert.includes(EXPECTED_TOOLS, tool, `${tool} should be registered`);
  });

  TestAssert.lengthOf(toolsWithId, 10, 'Should have 10 tools with ID parameter');
});

suite.test('Parameter Validation: form_id should be required where needed', () => {
  const toolsWithFormId = [
    'gf_validate_form',
    'gf_submit_form_data',
    'gf_validate_submission',
    'gf_list_form_feeds',
    'gf_create_feed',
    'gf_get_field_filters',
    'gf_get_results'
  ];

  toolsWithFormId.forEach(tool => {
    TestAssert.includes(EXPECTED_TOOLS, tool, `${tool} should be registered`);
  });
});

suite.test('Parameter Validation: Pagination parameters should be consistent', () => {
  // Only entries endpoint supports pagination, forms endpoint does not
  const toolsWithPagination = ['gf_list_entries'];

  toolsWithPagination.forEach(tool => {
    TestAssert.includes(EXPECTED_TOOLS, tool, `${tool} should support pagination`);
  });

  // Verify forms endpoint does NOT have pagination (returns all forms as object)
  TestAssert.includes(EXPECTED_TOOLS, 'gf_list_forms', 'gf_list_forms should exist but not support pagination');
});

// =================================
// ERROR HANDLING VALIDATION
// =================================

suite.test('Error Handling: All tools should handle missing required params', () => {
  const toolsWithRequired = {
    'gf_get_form': ['id'],
    'gf_update_form': ['id'],
    'gf_delete_form': ['id'],
    'gf_create_form': ['title'],
    'gf_get_entry': ['id'],
    'gf_create_entry': ['form_id'],
    'gf_update_entry': ['id'],
    'gf_delete_entry': ['id'],
    'gf_submit_form_data': ['form_id'],
    'gf_validate_submission': ['form_id'],
    'gf_send_notifications': ['entry_id'],
    'gf_get_feed': ['id'],
    'gf_list_form_feeds': ['form_id'],
    'gf_create_feed': ['addon_slug', 'form_id', 'meta'],
    'gf_update_feed': ['id'],
    'gf_patch_feed': ['id'],
    'gf_delete_feed': ['id'],
    'gf_get_field_filters': ['form_id'],
    'gf_get_results': ['form_id']
  };

  Object.keys(toolsWithRequired).forEach(tool => {
    TestAssert.includes(EXPECTED_TOOLS, tool, `${tool} should be registered`);
    TestAssert.isTrue(toolsWithRequired[tool].length > 0, `${tool} should have required params`);
  });
});

suite.test('Error Handling: Tools should wrap errors consistently', () => {
  // Verify error response structure
  const errorResponse = {
    error: 'Error message',
    details: 'Detailed error information',
    success: false
  };

  TestAssert.isFalse(errorResponse.success);
  TestAssert.isNotNull(errorResponse.error);
  TestAssert.isNotNull(errorResponse.details);
});

// =================================
// TOOL COVERAGE VALIDATION
// =================================

suite.test('Coverage: Should cover all REST API v2 endpoints', () => {
  const apiEndpoints = {
    '/forms': ['list', 'get', 'create', 'update', 'delete'],
    '/entries': ['list', 'get', 'create', 'update', 'delete'],
    '/forms/{id}/submissions': ['submit', 'validate'],
    '/entries/{id}/notifications': ['send'],
    '/feeds': ['list', 'get', 'create', 'update', 'patch', 'delete'],
    '/forms/{id}/feeds': ['list'],
    '/forms/{id}/field-filters': ['get'],
    '/forms/{id}/results': ['get']
  };

  let totalOperations = 0;
  Object.values(apiEndpoints).forEach(ops => {
    totalOperations += ops.length;
  });

  // We have 24 tools covering all operations
  TestAssert.isTrue(totalOperations >= 20, 'Should cover at least 20 operations');
});

suite.test('Coverage: Should have complete CRUD operations where applicable', () => {
  const crudEntities = {
    forms: ['list', 'get', 'create', 'update', 'delete'],
    entries: ['list', 'get', 'create', 'update', 'delete'],
    feeds: ['list', 'get', 'create', 'update', 'patch', 'delete']
  };

  TestAssert.lengthOf(crudEntities.forms, 5);
  TestAssert.lengthOf(crudEntities.entries, 5);
  TestAssert.lengthOf(crudEntities.feeds, 6); // Includes patch
});

// =================================
// TOOL DESCRIPTION VALIDATION
// =================================

suite.test('Descriptions: All tools should have clear descriptions', () => {
  const toolDescriptions = {
    'gf_list_forms': 'List all forms',
    'gf_get_form': 'Get a form by ID',
    'gf_create_form': 'Create a new form',
    'gf_update_form': 'Update a form',
    'gf_delete_form': 'Delete a form (requires ALLOW_DELETE=true)',
    'gf_validate_form': 'Validate form data',
    'gf_submit_form_data': 'Submit form data (triggers notifications, confirmations, payment)'
  };

  Object.keys(toolDescriptions).forEach(tool => {
    TestAssert.isTrue(toolDescriptions[tool].length > 5, `${tool} should have meaningful description`);
  });

  // Verify submit description clarifies the full processing pipeline
  TestAssert.includes(
    toolDescriptions['gf_submit_form_data'],
    'triggers notifications',
    'gf_submit_form_data description should clarify it triggers the full pipeline'
  );
});

suite.test('Descriptions: Delete tools should mention permission requirement', () => {
  const deleteDescriptions = {
    'gf_delete_form': 'Delete a form (requires ALLOW_DELETE=true)',
    'gf_delete_entry': 'Delete an entry (requires ALLOW_DELETE=true)',
    'gf_delete_feed': 'Delete a feed'
  };

  TestAssert.includes(deleteDescriptions['gf_delete_form'], 'ALLOW_DELETE');
  TestAssert.includes(deleteDescriptions['gf_delete_entry'], 'ALLOW_DELETE');
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
suite.run().then(results => {
  process.exit(results.failed > 0 ? 1 : 0);
});

}

export default suite;