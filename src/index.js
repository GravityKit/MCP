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
import { loadAbilitiesAsTools } from './view-operations/abilities-loader.js';

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
      tools: { listChanged: true }
    },
    instructions: 'GravityKit MCP server. Two tool families: gf_* for Gravity Forms (forms, entries, feeds, notifications, fields) and gv_* for GravityView Views.\n\nGravityView authoring flow: 1) gv_view_create to create a draft (defaults to gravityview-layout-builder, supports per-zone template_ids). 2) Use gv_grid_row_add (surface=fields|widgets) to materialise rows in the layout. 3) Use gv_view_config_apply for bulk one-shot writes, or gv_view_field_add / gv_view_field_patch / gv_view_field_move for surgical edits. 4) For Search Bar internal layout, use gv_search_field_add / gv_search_field_patch / gv_search_field_remove — modern keyed-by-position storage (search_fields_section). Existing legacy search_bar widgets auto-migrate to modern on first save through this API.\n\nDiscovery: gv_layouts_list (Layout Builder, DIY, Table, List, DataTables, Map — with is_grid_aware flag), gv_widgets_list, gv_grid_row_types_list, gv_widget_zones_list (header/footer), gv_search_zones_list (search-general/search-advanced), gv_available_fields_get. Schema: gv_field_type_schema_get works for fields, widgets, AND search_field types (search_all, submit, search_mode, etc.) — kind in the response says which.\n\nMove semantics: gv_view_field_move accepts to.before_slot / to.after_slot for ref-relative placement (preferred) and position="start"|"end"|integer for symbolic. Concurrency: pass ifMatch="auto" to use the client-cached version. Compact: responses strip null/empty by default — pass compact=false for raw.\n\nGravity Forms specifics: checkbox/multiselect arrays auto-normalized; multiselect values with commas get split by GF REST API; gf_submit_form_data runs the full pipeline (validation/notifications/feeds), gf_create_entry is raw import.'
  }
);

// Global client instance
let gravityFormsClient = null;
let fieldOperations = null;
let fieldValidator = null;
let gravityViewClient = null;
// Auto-generated from the WordPress Abilities API (Foundation catalog
// first, WP core fallback). Populated by initializeClient(). This is
// the ONLY source of gv_* tools — when no catalog is reachable (older
// WP, plugin off), these stay null, gv_* tools are absent from
// tools/list, and every gv_* call retries the load (self-healing).
let abilityToolDefinitions = null;
let abilityToolHandlers = null;
// In-flight catalog fetch. Single-flight: concurrent callers share the
// same promise. On rejection it's cleared so the NEXT call retries —
// covers transient cert / network / WP-not-yet-booted failures without
// requiring an MCP process restart.
let abilitiesLoadPromise = null;

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
      logger.info('✅ GravityView client initialized — loading gv_* abilities');

      // Fire-and-forget: kick off the abilities catalog fetch in the
      // background so MCP startup is fast. ListTools awaits up to 2s
      // for it (long enough for a warm cold-start on dev.test, short
      // enough to never feel like a hang); gv_* tool calls await with
      // no timeout. On success we emit `tools/list_changed` so the
      // client refetches with the abilities-derived schemas.
      ensureAbilitiesLoaded();
    } catch (gvError) {
      // Don't fail the whole MCP if GravityView credentials are
      // missing — gf_* tools still work standalone.
      logger.warn(`⚠️  GravityView client unavailable: ${gvError.message}`);
      gravityViewClient = null;
      abilityToolDefinitions = null;
      abilityToolHandlers = null;
    }

    return true;
  } catch (error) {
    logger.error(`❌ Failed to initialize: ${error.message}`);
    throw error;
  }
}

/**
 * Idempotent + self-healing loader for the WordPress Abilities API
 * catalog. Single-flight (concurrent callers share a promise), with
 * a per-call optional timeout (used by ListTools so a slow / down WP
 * doesn't hang the tool list at startup). On rejection the cached
 * promise is cleared so the NEXT call retries — sleep/wake, cert
 * mid-fix, valet still booting all self-heal on the next gv_* call.
 *
 * Side effects on success:
 *   - populates `abilityToolDefinitions` + `abilityToolHandlers`
 *   - emits `notifications/tools/list_changed` so MCP clients refetch
 *
 * @param {Object}   [opts]
 * @param {boolean}  [opts.force]      Discard cached state and reload.
 * @param {number}   [opts.timeoutMs]  Cap the await; the load itself
 *                                     keeps running in the background
 *                                     after the timeout fires.
 */
async function ensureAbilitiesLoaded({ force = false, timeoutMs } = {}) {
  if (!gravityViewClient) return;
  if (force) {
    abilityToolDefinitions = null;
    abilityToolHandlers = null;
    abilitiesLoadPromise = null;
  }
  if (abilityToolDefinitions) return;
  if (!abilitiesLoadPromise) {
    abilitiesLoadPromise = loadAbilitiesAsTools(gravityViewClient)
      .then(({ definitions, handlers, count, source }) => {
        abilityToolDefinitions = definitions;
        abilityToolHandlers = handlers;
        const sourceLabel = source === 'foundation-catalog' ? 'gravitykit/v1 catalog' : '/wp-abilities/v1';
        logger.info(`✅ Loaded ${count} GravityKit abilities from ${sourceLabel}`);
        // Tell connected MCP clients to refetch the tool list so the
        // abilities-derived schemas (e.g. `joins` on view-config-apply,
        // gk_apply_joins, gk_list_joins) land in their cached catalogue.
        server.sendToolListChanged().catch((err) => {
          logger.warn(`tools/list_changed notification failed: ${err.message}`);
        });
      })
      .catch((err) => {
        logger.warn(`⚠️  Abilities API catalog unavailable: ${err.message} — gv_* tools unavailable until a catalog is reachable (will retry on next call)`);
        abilitiesLoadPromise = null; // clear so next call retries
        throw err;
      });
  }
  if (timeoutMs) {
    await Promise.race([
      abilitiesLoadPromise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } else {
    await abilitiesLoadPromise.catch(() => {});
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
  // ListTools is the FIRST request Claude fires after the MCP
  // handshake, so we lazily initialise here too — otherwise the
  // tool list goes out before initializeClient() has had a chance
  // to construct the GravityView client + start the abilities load.
  if (!gravityFormsClient) {
    try { await initializeClient(); } catch (_) { /* gf_* still serves */ }
  }
  // Best-effort wait for the abilities catalog. 2s covers a warm
  // cold-start on dev.test (~800ms) plus headroom; if WP is
  // genuinely unreachable the list ships without gv_* tools and the
  // next gv_* call (or gv_reload_abilities) retries.
  await ensureAbilitiesLoaded({ timeoutMs: 2000 });

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

      // GravityView Inspector — auto-generated from the WordPress
      // Abilities API (Foundation catalog first, WP core fallback).
      // Empty until the background load succeeds; gv_reload_abilities
      // and the per-call self-heal repopulate it.
      ...(abilityToolDefinitions ?? []),

      // Always present — the manual escape hatch when the eager
      // background load fails AND the per-call self-heal hasn't fired
      // (e.g. you fixed the WP env and want the tool list refreshed
      // without waiting to call another gv_* tool first).
      {
        name: 'gv_reload_abilities',
        description: 'Force a re-fetch of the WordPress Abilities API catalog and refresh the gv_* tool list. Use after fixing a WP / network / cert issue that prevented the eager background load from succeeding at MCP startup.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
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
    // abilities-derived handler map. Single dispatch keeps the switch
    // readable; the map is rebuilt whenever the abilities catalog is
    // (re)fetched.
    default:
      if (name === 'gv_reload_abilities') {
        if (!gravityViewClient) {
          return createErrorResponse(
            'GravityView client not initialized. Set GRAVITYVIEW_BASE_URL + GRAVITYVIEW_WP_USERNAME + GRAVITYVIEW_WP_APP_PASSWORD in .env (or reuse the GRAVITY_FORMS_* credentials).'
          );
        }
        const before = abilityToolDefinitions?.length ?? 0;
        await ensureAbilitiesLoaded({ force: true });
        const after = abilityToolDefinitions?.length ?? 0;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              loaded: !!abilityToolDefinitions,
              ability_tool_count: after,
              previous_count: before,
              note: abilityToolDefinitions
                ? 'Catalog refreshed. Clients receive `notifications/tools/list_changed` automatically.'
                : 'Catalog still unreachable — check WP logs / cert / credentials. Will retry on next gv_* tool call.',
            }, null, 2),
          }],
        };
      }
      if (typeof name === 'string' && name.startsWith('gv_')) {
        if (!gravityViewClient) {
          return createErrorResponse(
            'GravityView client not initialized. Set GRAVITYVIEW_BASE_URL + GRAVITYVIEW_WP_USERNAME + GRAVITYVIEW_WP_APP_PASSWORD in .env (or reuse GRAVITY_FORMS_BASE_URL / GRAVITY_FORMS_CONSUMER_KEY / GRAVITY_FORMS_CONSUMER_SECRET when the same WP install hosts both surfaces).'
          );
        }
        // Self-heal: every gv_* call retries the abilities load if a
        // prior attempt failed. Cheap (cache hit on success path),
        // and lets transient cert / network / boot races recover
        // without an MCP process restart.
        await ensureAbilitiesLoaded();
        const handlerMap = abilityToolHandlers;
        if (!handlerMap) {
          return createErrorResponse(
            'GravityView abilities catalog unreachable — no gv_* tools are available. Fix WP connectivity / credentials, then call gv_reload_abilities to refresh.'
          );
        }
        const handler = handlerMap[name];
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