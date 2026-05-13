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
import { GravityViewClient } from './gravityview-client.js';
import {
  createViewOperations,
  viewToolDefinitions,
  buildViewToolHandlers,
} from './view-operations/index.js';

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
    version: '2.1.0'
  },
  {
    capabilities: {
      tools: {}
    },
    instructions: 'GravityKit MCP server. Two tool families: gf_* for Gravity Forms (forms, entries, feeds, notifications, fields) and gv_* for GravityView Views.\n\nGravityView authoring flow: 1) gv_create_view to create a draft (defaults to gravityview-layout-builder, supports per-zone template_ids). 2) Use gv_create_grid_row (surface=fields|widgets) to materialise rows in the layout. 3) Use gv_apply_view_config for bulk one-shot writes, or gv_add_view_field / gv_patch_view_field / gv_move_view_field for surgical edits. 4) For Search Bar internal layout, use gv_add_search_field / gv_patch_search_field / gv_remove_search_field — modern keyed-by-position storage (search_fields_section). Existing legacy search_bar widgets auto-migrate to modern on first save through this API.\n\nDiscovery: gv_list_templates, gv_list_widgets, gv_list_grid_row_types, gv_list_widget_zones (header/footer), gv_list_search_zones (search-general/search-advanced), gv_list_available_fields. Schema: gv_get_field_type_schema works for fields, widgets, AND search_field types (search_all, submit, search_mode, etc.) — kind in the response says which.\n\nMove semantics: gv_move_view_field accepts to.before_slot / to.after_slot for ref-relative placement (preferred) and position="start"|"end"|integer for symbolic. Concurrency: pass ifMatch="auto" to use the client-cached version. Compact: responses strip null/empty by default — pass compact=false for raw.\n\nGravity Forms specifics: checkbox/multiselect arrays auto-normalized; multiselect values with commas get split by GF REST API; gf_submit_form_data runs the full pipeline (validation/notifications/feeds), gf_create_entry is raw import.'
  }
);

// Global client instance
let gravityFormsClient = null;
let fieldOperations = null;
let fieldValidator = null;
let gravityViewClient = null;
let viewOperations = null;
let viewToolHandlers = null;

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

    // GravityView Inspector client — separate WP REST namespace
    // (`/wp-json/gravityview/v1/*`) so the credentials and base
    // URL are resolved independently of the GF REST endpoint. The
    // constructor allows credential fallback to GRAVITY_FORMS_*
    // env vars so single-WP-install setups don't need to mint
    // two separate app passwords.
    try {
      gravityViewClient = new GravityViewClient(process.env);
      viewOperations = createViewOperations(gravityViewClient);
      viewToolHandlers = buildViewToolHandlers(viewOperations);
      logger.info('✅ GravityView client initialized — gv_* tools available');
    } catch (gvError) {
      // Don't fail the whole MCP if GravityView credentials are
      // missing — gf_* tools still work standalone.
      logger.warn(`⚠️  GravityView client unavailable: ${gvError.message}`);
      gravityViewClient = null;
      viewOperations = null;
      viewToolHandlers = null;
    }

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

/**
 * Variant of wrapHandler for gv_* tools. Differs in two ways:
 *   - Checks gravityViewClient (not gravityFormsClient).
 *   - Surfaces the inspector REST envelope (`{ code, message, data }`)
 *     so the agent sees `gv_rest_invalid_template` etc. instead of a
 *     generic "Request failed with status code 400". The inspector's
 *     errors are designed for AI consumption — preserve them.
 */
function wrapViewHandler(handler, params = {}) {
  return async () => {
    if (!gravityViewClient) {
      return createErrorResponse('GravityView client not initialized');
    }
    try {
      const result = await handler();
      const output = params.compact !== false ? stripEmpty(result) : result;
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
      };
    } catch (error) {
      // Axios errors carry response.data — when the server speaks
      // the inspector REST envelope, that's the most useful payload.
      const restBody = error?.response?.data;
      const status = error?.response?.status;
      const message = restBody?.message || error.message;
      const details = restBody
        ? { status, code: restBody.code, data: restBody.data }
        : undefined;
      logger.error(`gv_* tool error: ${message}${status ? ` (HTTP ${status})` : ''}`);
      return createErrorResponse(message, details);
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
        description: 'List all forms with optional search and pagination.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Form IDs to include'
            },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          }
        }
      },
      {
        name: 'gf_get_form',
        description: 'Get a form by ID with full field configuration.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_create_form',
        description: 'Create a new form',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Form title' },
            description: { type: 'string', description: 'Form description' },
            fields: {
              type: 'array',
              description: 'Array of field objects',
              items: { type: 'object' }
            },
            button: { type: 'object', description: 'Submit button settings' },
            confirmations: { type: 'object', description: 'Confirmation settings' },
            notifications: { type: 'object', description: 'Notification settings' },
            is_active: { type: 'boolean', description: 'Form active state' }
          },
          required: ['title']
        }
      },
      {
        name: 'gf_update_form',
        description: 'Update a form',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            title: { type: 'string', description: 'Form title' },
            description: { type: 'string', description: 'Form description' },
            fields: {
              type: 'array',
              description: 'Array of field objects',
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
        description: 'Delete a form (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Form ID' },
            force: { type: 'boolean', description: 'Permanent delete (vs trash)' }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_validate_form',
        description: 'Validate form data',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },

      // Entries Management (5 tools)
      {
        name: 'gf_list_entries',
        description: 'List/search entries with filtering, sorting, and pagination.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Filter by form IDs'
            },
            include: {
              type: 'array',
              items: { type: 'number' },
              description: 'Entry IDs to include'
            },
            exclude: {
              type: 'array',
              items: { type: 'number' },
              description: 'Entry IDs to exclude'
            },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            },
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
                      operator: {
                        type: 'string',
                        enum: ['=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<=']
                      }
                    }
                  }
                },
                mode: {
                  type: 'string',
                  enum: ['any', 'all'],
                  description: 'Search mode'
                }
              }
            },
            sorting: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                direction: {
                  type: 'string',
                  enum: ['asc', 'desc', 'ASC', 'DESC']
                }
              }
            },
            paging: {
              type: 'object',
              properties: {
                page_size: { type: 'number' },
                current_page: { type: 'number' }
              }
            },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          }
        }
      },
      {
        name: 'gf_get_entry',
        description: 'Get an entry by ID with field labels.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_create_entry',
        description: 'Create an entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            created_by: { type: 'number', description: 'Creator user ID' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            },
            date_created: { type: 'string', description: 'ISO date' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },
      {
        name: 'gf_update_entry',
        description: 'Update an entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            status: {
              type: 'string',
              enum: ['active', 'spam', 'trash'],
              description: 'Entry status'
            }
          },
          additionalProperties: true,
          required: ['id']
        }
      },
      {
        name: 'gf_delete_entry',
        description: 'Delete an entry (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Entry ID' },
            force: { type: 'boolean', description: 'Permanent delete (vs trash)' }
          },
          required: ['id']
        }
      },

      // Form Submissions (2 tools)
      {
        name: 'gf_submit_form_data',
        description: 'Submit form data (triggers notifications, confirmations, payment)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' },
            field_values: { type: 'object', description: 'Field values' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },
      {
        name: 'gf_validate_submission',
        description: 'Validate submission without processing',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          additionalProperties: true,
          required: ['form_id']
        }
      },

      // Notifications (1 tool)
      {
        name: 'gf_send_notifications',
        description: 'Send notifications for entry',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'number', description: 'Entry ID' },
            notification_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Notification IDs to send'
            }
          },
          required: ['entry_id']
        }
      },

      // Add-on Feeds (7 tools)
      {
        name: 'gf_list_feeds',
        description: 'List feeds. Filter by form_id and/or addon slug.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon: { type: 'string', description: 'Addon slug' },
            form_id: { type: 'number', description: 'Form ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          }
        }
      },
      {
        name: 'gf_get_feed',
        description: 'Get a feed by ID.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
          },
          required: ['id']
        }
      },
      // gf_list_form_feeds removed — gf_list_feeds with form_id does the same thing
      // and also supports addon filtering. Kept listFormFeeds() client method for
      // backwards compatibility but no longer exposed as a tool.
      {
        name: 'gf_create_feed',
        description: 'Create a feed',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            addon_slug: { type: 'string', description: 'Add-on slug' },
            form_id: { type: 'number', description: 'Form ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'object', description: 'Feed config' }
          },
          required: ['addon_slug', 'form_id', 'meta']
        }
      },
      {
        name: 'gf_update_feed',
        description: 'Update a feed (full replace)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'object', description: 'Feed config' }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_patch_feed',
        description: 'Patch a feed (partial update)',
        annotations: { idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' },
            is_active: { type: 'boolean', description: 'Feed active state' },
            meta: { type: 'object', description: 'Feed config' }
          },
          required: ['id']
        }
      },
      {
        name: 'gf_delete_feed',
        description: 'Delete a feed (requires ALLOW_DELETE=true)',
        annotations: { destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Feed ID' }
          },
          required: ['id']
        }
      },

      // Field Filters (1 tool)
      {
        name: 'gf_get_field_filters',
        description: 'Get field filters for form',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          required: ['form_id']
        }
      },

      // Results (1 tool)
      {
        name: 'gf_get_results',
        description: 'Get quiz/poll/survey results',
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            form_id: { type: 'number', description: 'Form ID' }
          },
          required: ['form_id']
        }
      },

      // Field Operations (4 tools) - Intelligent field management
      ...fieldOperationTools,

      // GravityView Inspector (~20 tools) - View configuration CRUD
      ...viewToolDefinitions
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

    // GravityView Inspector — every gv_* tool routes through the
    // shared handler map. Single dispatch instead of 20 cases keeps
    // the switch readable and makes adding/removing tools a one-line
    // change in view-operations/index.js.
    default:
      if (typeof name === 'string' && name.startsWith('gv_')) {
        if (!viewToolHandlers || !gravityViewClient) {
          return createErrorResponse(
            'GravityView client not initialized. Set GRAVITYVIEW_BASE_URL + GRAVITYVIEW_WP_USERNAME + GRAVITYVIEW_WP_APP_PASSWORD in .env (or reuse GRAVITY_FORMS_BASE_URL / GRAVITY_FORMS_CONSUMER_KEY / GRAVITY_FORMS_CONSUMER_SECRET when the same WP install hosts both surfaces).'
          );
        }
        const handler = viewToolHandlers[name];
        if (!handler) {
          return createErrorResponse(`Unknown GravityView tool: ${name}`);
        }
        return wrapViewHandler(() => handler(params), params)();
      }
      return createErrorResponse(`Unknown tool: ${name}`);
  }
});

// =================================
// SERVER INITIALIZATION
// =================================

async function main() {
  try {
    // Create stdio transport — client initialization is deferred to first tool call
    // so the MCP handshake completes instantly (live site validation can take 3+ seconds)
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