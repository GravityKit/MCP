#!/usr/bin/env node

/**
 * Gravity MCP Server
 * Model Context Protocol server for Gravity Forms
 * Tools for forms, entries, and add-ons
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import GravityFormsClient from './gravity-forms-client.js';
import { createFieldOperations, fieldOperationHandlers, fieldOperationTools } from './field-operations/index.js';
import fieldRegistry from './field-definitions/field-registry.js';
import FieldAwareValidator from './config/field-validation.js';
import logger from './utils/logger.js';
import { sanitize } from './utils/sanitize.js';
import { stripEmpty, stripEntryMetaFromResponse } from './utils/compact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables:
// 	1. Current working directory first
dotenv.config({ path: join(process.cwd(), '.env') });
// 	2. Gravity MCP project directory
dotenv.config({ path: join(__dirname, '..', '.env') });

// Initialize the MCP server
const server = new Server(
  {
    name: 'gravitykit-mcp',
    version: '2.1.1'
  },
  {
    capabilities: {
      tools: {}
    },
    instructions: 'GravityKit MCP server for Gravity Forms. Checkbox/multiselect arrays auto-normalized: pass ["val1","val2"] and values are matched to correct sub-inputs. Text labels also work. Multiselect limitation: values containing commas get split by GF REST API. Responses strip null/empty by default; pass compact=false for full raw data. gf_submit_form_data = full pipeline (validation/notifications/feeds); gf_create_entry = raw import. Use gf_get_form to discover field IDs before creating/searching entries.'
  }
);

// Global client instance
let gravityFormsClient = null;
let fieldOperations = null;
let fieldValidator = null;

/**
 * Initialize Gravity Forms client
 */
async function initializeClient() {
  try {
    gravityFormsClient = new GravityFormsClient(process.env);
    const validation = await gravityFormsClient.initialize();

    if (!validation.available) {
      throw new Error(`Failed to initialize Gravity Forms client: ${validation.error}`);
    }

    // Initialize field operations infrastructure
    fieldValidator = new FieldAwareValidator();
    fieldOperations = createFieldOperations(
      gravityFormsClient,
      fieldRegistry,
      fieldValidator
    );

    logger.info('✅ GravityKit MCP initialized successfully');
    logger.info('✅ Field operations infrastructure initialized');
    return true;
  } catch (error) {
    logger.error(`❌ Failed to initialize: ${error.message}`);
    throw error;
  }
}

/**
 * Recursively strip null, empty string, and false values from objects/arrays.
 * Reduces token usage by removing noise like empty field values and absent meta keys.
 */
/**
 * Create standard error response
 */
function createErrorResponse(message, details = null) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}${details ? `\nDetails: ${JSON.stringify(details)}` : ''}`
      }
    ],
    isError: true
  };
}

/**
 * Wrap async handler with error handling and response compaction.
 * @param {Function} handler - async function returning result object
 * @param {object} params - tool params; if compact !== false, strips null/empty/false values
 */
function wrapHandler(handler, params = {}) {
  return async () => {
    if (!gravityFormsClient) {
      return createErrorResponse('Gravity Forms client not initialized');
    }

    try {
      const result = await handler();
      const output = params.compact !== false ? stripEmpty(result) : result;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output)
          }
        ]
      };
    } catch (error) {
      const safeDetails = error.details ? sanitize(error.details) : undefined;
      logger.error(`Tool error: ${error.message}`);
      return createErrorResponse(error.message, safeDetails);
    }
  };
}

// =================================
// FORMS MANAGEMENT TOOLS (6)
// =================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Forms Management (6 tools)
      {
        name: 'gf_list_forms',
        description: 'List all forms (title, ID, entry count, active status). Returns summary data — use gf_get_form for full field config.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Limit to these form IDs'
            },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          },
          additionalProperties: false
        }
      },
      {
        name: 'gf_get_form',
        description: 'Get form by ID with all fields, confirmations, notifications, and settings. Use to inspect structure before creating entries or modifying fields.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_create_form',
        description: 'Create a form. Fields can be included here or added individually via gf_add_field. Returns new form ID and admin edit URL.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Form title (required)' },
            description: { type: 'string', description: 'Form description shown to users' },
            fields: {
              type: 'array',
              description: 'Field objects — each needs at minimum {type, label}. Use gf_list_field_types to see available types.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: "Field type slug (e.g. 'text', 'email', 'select', 'name', 'address')" },
                  label: { type: 'string', description: 'Field label shown to users' },
                  isRequired: { type: 'boolean', description: 'Whether the field is required' },
                  choices: {
                    type: 'array',
                    description: 'For select/radio/checkbox — array of {text, value} objects',
                    items: {
                      type: 'object',
                      properties: {
                        text: { type: 'string' },
                        value: { type: 'string' }
                      }
                    }
                  },
                  defaultValue: { type: 'string', description: 'Default field value' },
                  placeholder: { type: 'string', description: 'Placeholder text' },
                  description: { type: 'string', description: 'Field help text' }
                }
              }
            },
            button: { type: 'object', description: 'Submit button settings' },
            confirmations: { type: 'object', description: 'Confirmation settings' },
            notifications: { type: 'object', description: 'Notification settings' },
            is_active: { type: 'boolean', description: 'Form active state', default: true }
          },
          required: ['title']
        }
      },
      {
        name: 'gf_update_form',
        description: 'Update a form. Fetch-then-merge: only include properties you want to change. For single-field changes, prefer gf_update_field.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID to update' },
            title: { type: 'string', description: 'New form title' },
            description: { type: 'string', description: 'New form description' },
            fields: {
              type: 'array',
              description: 'Complete fields array — replaces all existing fields. For single-field changes, prefer gf_update_field.',
              items: { type: 'object' }
            },
            button: { type: 'object', description: 'Submit button settings' },
            confirmations: { type: 'object', description: 'Confirmation settings' },
            notifications: { type: 'object', description: 'Notification settings' },
            is_active: { type: 'boolean', description: 'Form active state' }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_delete_form',
        description: 'Delete a form and all its entries/feeds/notifications. Requires ALLOW_DELETE=true. force=true skips trash.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID to delete' },
            force: { type: 'boolean', description: 'true = permanent delete, false = move to trash' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_validate_form',
        description: 'Validate submission data against a form without creating an entry. Pass form_id plus field values (input_1, input_2, etc.). Same endpoint as gf_validate_submission.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID to validate against' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },

      // Entries Management (5 tools)
      {
        name: 'gf_list_entries',
        description: 'Search entries across forms with field_filters, date ranges, status, sorting, and pagination. Returns entries and total count.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Form IDs to search across. Omit to search all forms.'
            },
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Return only these entry IDs'
            },
            exclude: {
              type: 'array',
              items: { type: 'number' },
              description: 'Exclude these entry IDs'
            },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Filter by entry status. Default: active.'
            },
            search: {
              type: 'object',
              description: 'Field-based search filters',
              properties: {
                field_filters: {
                  type: 'array',
                  description: 'Array of field filter conditions',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: 'Field ID or entry property (e.g. "1", "date_created", "created_by")' },
                      value: { type: 'string', description: 'Value to match against' },
                      operator: {
                        type: 'string',
                        enum: ['=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<='],
                        description: 'Comparison operator. Default: IS.'
                      }
                    },
                    required: ['key', 'value'],
                    additionalProperties: false
                  }
                },
                mode: {
                  type: 'string',
                  enum: ['any', 'all'],
                  description: 'any = OR, all = AND. Default: all.'
                }
              },
              additionalProperties: false
            },
            sorting: {
              type: 'object',
              description: 'Sort configuration',
              properties: {
                key: { type: 'string', description: 'Field ID or property to sort by' },
                direction: {
                  type: 'string',
                  enum: ['asc', 'desc', 'ASC', 'DESC'],
                  description: 'Sort direction. Default: DESC.'
                }
              },
              additionalProperties: false
            },
            paging: {
              type: 'object',
              description: 'Pagination',
              properties: {
                page_size: { type: 'number', description: 'Entries per page (max 200)' },
                current_page: { type: 'number', description: 'Page number (1-based)' }
              },
              additionalProperties: false
            },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          }
        }
      },
      {
        name: 'gf_get_entry',
        description: 'Get entry by ID with all field values and metadata. Values keyed by field ID (e.g. "1": "John"). Use gf_get_form to map IDs to labels.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_create_entry',
        description: 'Create a raw entry bypassing validation/notifications/feeds. For full submission pipeline, use gf_submit_form_data instead. Values keyed by field ID. Checkbox/multiselect arrays auto-normalized.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID (required)' },
            created_by: { type: 'number', description: 'WordPress user ID of creator' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status. Default: active.'
            },
            date_created: { type: 'string', description: 'Override creation date (Y-m-d H:i:s)' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },
      {
        name: 'gf_update_entry',
        description: 'Update entry fields. Fetch-then-merge: only include fields to change. Checkbox/multiselect arrays auto-normalized.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID to update' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Change entry status'
            }
          },
          additionalProperties: true,
          required: ['id']
        }
      },
      {
        name: 'gf_delete_entry',
        description: 'Delete an entry and its notes/meta. Requires ALLOW_DELETE=true. force=true skips trash.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID to delete' },
            force: { type: 'boolean', description: 'true = permanent delete, false = move to trash' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },

      // Form Submissions (2 tools)
      {
        name: 'gf_submit_form_data',
        description: 'Submit form through full pipeline: validation, entry creation, notifications, confirmations, feeds/payments. Use gf_create_entry instead for raw data import.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID to submit' },
            field_values: { type: 'object', description: 'Field values keyed by input name (e.g. "input_1": "John")' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },
      {
        name: 'gf_validate_submission',
        description: 'Dry-run validation before gf_submit_form_data. Returns is_valid and per-field validation messages without creating an entry.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID to validate against' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },

      // Notifications (1 tool)
      {
        name: 'gf_send_notifications',
        description: 'Send notifications for an entry. Sends all active notifications unless notification_ids specified. Use gf_get_form to find notification IDs.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'number', description: 'Entry ID to send notifications for' },
            notification_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific notification IDs. Omit to send all active notifications.'
            }
          },
          required: ['entry_id'],
          additionalProperties: false
        }
      },

      // Add-on Feeds (7 tools)
      {
        name: 'gf_list_feeds',
        description: 'List feeds (add-on integrations like email marketing, CRMs, payments). Filter by form_id and/or addon slug.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon: { type: 'string', description: "Add-on slug (e.g. 'gravityformsmailchimp', 'gravityformsstripe')" },
            form_id: { type: 'number', description: 'Filter feeds by form ID' },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          },
          additionalProperties: false
        }
      },
      {
        name: 'gf_get_feed',
        description: 'Get feed by ID with full config, field mappings, and conditional logic.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            compact: { type: 'boolean', description: 'Set false for full raw data', default: true }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_create_feed',
        description: 'Create a feed for a form. Meta structure is add-on specific — use gf_list_feeds to see existing configs as examples.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon_slug: { type: 'string', description: "Add-on slug (e.g. 'gravityformsmailchimp')" },
            form_id: { type: 'number', description: 'Form ID to attach feed to' },
            is_active: { type: 'boolean', description: 'Feed active state', default: true },
            meta: { type: 'object', description: 'Feed configuration (add-on specific)' }
          },
          required: ['addon_slug', 'form_id', 'meta'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_update_feed',
        description: 'Replace feed config entirely. Use gf_patch_feed for partial updates.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID to update' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'object', description: 'Complete feed configuration (replaces existing)' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_patch_feed',
        description: 'Partial feed update — merges with existing config. Safer than gf_update_feed for individual setting changes.',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID to patch' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'object', description: 'Partial feed config to merge' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'gf_delete_feed',
        description: 'Delete a feed. Requires ALLOW_DELETE=true.',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID to delete' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },

      // Field Filters (1 tool)
      {
        name: 'gf_get_field_filters',
        description: 'Get available search filter options for a form (field IDs, operators, values). Use to build gf_list_entries field_filters.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          required: ['form_id'],
          additionalProperties: false
        }
      },

      // Results (1 tool)
      {
        name: 'gf_get_results',
        description: 'Get aggregated quiz/poll/survey results. Requires Quiz, Poll, or Survey add-on fields on the form.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          required: ['form_id'],
          additionalProperties: false
        }
      },

      // Field Operations (4 tools) - Intelligent field management
      ...fieldOperationTools
    ]
  };
});

// =================================
// TOOL HANDLERS
// =================================

// Forms Management Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;

  // Ensure client is initialized
  if (!gravityFormsClient) {
    await initializeClient();
  }

  // Route to appropriate handler
  // The client already validates internally, just pass params directly
  switch (name) {
    // Forms Management
    case 'gf_list_forms':
      return wrapHandler(() => gravityFormsClient.listForms(params), params)();
    case 'gf_get_form':
      return wrapHandler(() => gravityFormsClient.getForm(params), params)();
    case 'gf_create_form':
      return wrapHandler(() => gravityFormsClient.createForm(params), params)();
    case 'gf_update_form':
      return wrapHandler(() => gravityFormsClient.updateForm(params), params)();
    case 'gf_delete_form':
      return wrapHandler(() => gravityFormsClient.deleteForm(params), params)();
    case 'gf_validate_form':
      return wrapHandler(() => gravityFormsClient.validateForm(params), params)();

    // Entries Management
    case 'gf_list_entries':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.listEntries(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_get_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.getEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_create_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.createEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_update_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.updateEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_delete_entry':
      return wrapHandler(() => gravityFormsClient.deleteEntry(params), params)();

    // Form Submissions
    case 'gf_submit_form_data':
      return wrapHandler(() => gravityFormsClient.submitFormData(params), params)();
    case 'gf_validate_submission':
      return wrapHandler(() => gravityFormsClient.validateSubmission(params), params)();

    // Notifications
    case 'gf_send_notifications':
      return wrapHandler(() => gravityFormsClient.sendNotifications(params), params)();

    // Add-on Feeds
    case 'gf_list_feeds':
      return wrapHandler(() => gravityFormsClient.listFeeds(params), params)();
    case 'gf_get_feed':
      return wrapHandler(() => gravityFormsClient.getFeed(params), params)();
    case 'gf_create_feed':
      return wrapHandler(() => gravityFormsClient.createFeed(params), params)();
    case 'gf_update_feed':
      return wrapHandler(() => gravityFormsClient.updateFeed(params), params)();
    case 'gf_patch_feed':
      return wrapHandler(() => gravityFormsClient.patchFeed(params), params)();
    case 'gf_delete_feed':
      return wrapHandler(() => gravityFormsClient.deleteFeed(params), params)();

    // Utilities
    case 'gf_get_field_filters':
      return wrapHandler(() => gravityFormsClient.getFieldFilters(params), params)();
    case 'gf_get_results':
      return wrapHandler(() => gravityFormsClient.getResults(params), params)();

    // Field Operations - Intelligent field management
    case 'gf_add_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_add_field(params, fieldOperations);
      }, params)();
    case 'gf_update_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_update_field(params, fieldOperations);
      }, params)();
    case 'gf_delete_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_delete_field(params, fieldOperations);
      }, params)();
    case 'gf_list_field_types':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_list_field_types(params, fieldOperations);
      }, params)();

    default:
      return createErrorResponse(`Unknown tool: ${name}`);
  }
});

// =================================
// SERVER INITIALIZATION
// =================================

async function main() {
  try {
    // Initialize client on startup
    await initializeClient();

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logger.info('🚀 GravityKit MCP running on stdio');
  } catch (error) {
    logger.error(`Failed to start server: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});