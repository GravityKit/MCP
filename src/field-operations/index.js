/**
 * Field Operations Module - Main exports
 * Provides intelligent field management for Gravity MCP
 */

// Import core components for internal use
import { FieldManager } from './field-manager.js';
import { DependencyTracker } from './field-dependencies.js';
import { PositionEngine } from './field-positioner.js';
import { testConfig, TestFormManager } from '../config/test-config.js';

// Re-export components
export { FieldManager, DependencyTracker, PositionEngine, testConfig, TestFormManager };

/**
 * Create and configure field operations infrastructure
 * @param {object} apiClient - Gravity Forms API client
 * @param {object} fieldRegistry - Field type registry
 * @param {object} validator - Field validator
 * @returns {object} Configured field operations components
 */
export function createFieldOperations(apiClient, fieldRegistry, validator) {
  // Create core components
  const dependencyTracker = new DependencyTracker();
  const positionEngine = new PositionEngine();
  const fieldManager = new FieldManager(apiClient, fieldRegistry, validator);

  // Inject dependencies
  fieldManager.dependencyTracker = dependencyTracker;
  fieldManager.positionEngine = positionEngine;

  // Create test form manager if in test mode
  const testFormManager = testConfig.isTestMode() ?
    new TestFormManager(apiClient, testConfig) : null;

  return {
    fieldManager,
    fieldRegistry,
    dependencyTracker,
    positionEngine,
    testFormManager,
    config: testConfig
  };
}

/**
 * Field operation tool handlers for MCP integration
 */
export const fieldOperationHandlers = {
  /**
   * Add field to form
   */
  async gf_add_field(params, { fieldManager }) {
    const { form_id, field_type, properties = {}, position = {} } = params;

    const result = await fieldManager.addField(
      form_id,
      field_type,
      properties,
      position
    );

    return {
      success: true,
      ...result
    };
  },

  /**
   * Update field properties
   */
  async gf_update_field(params, { fieldManager }) {
    const { form_id, field_id, properties, force = false } = params;

    const result = await fieldManager.updateField(
      form_id,
      field_id,
      properties
    );

    // Check for breaking changes if not forced
    if (!force && result.warnings?.dependencies?.length > 0) {
      return {
        success: false,
        error: 'Field has dependencies that may be affected',
        ...result,
        suggestion: 'Use force=true to update anyway'
      };
    }

    return {
      success: true,
      ...result
    };
  },

  /**
   * Delete field with dependency checking
   */
  async gf_delete_field(params, { fieldManager }) {
    const { form_id, field_id, cascade = false, force = false } = params;

    const result = await fieldManager.deleteField(
      form_id,
      field_id,
      { cascade, force }
    );

    return result;
  },

  /**
   * List available field types
   */
  async gf_list_field_types(params, { fieldRegistry }) {
    const { category, feature, search, detail = false, include_variants = false } = params;

    try {
      // Apply filters first on raw registry to avoid unnecessary mapping
      let entries = Object.entries(fieldRegistry);

      if (category) {
        entries = entries.filter(([, def]) => def.category === category);
      }

      if (search) {
        const searchLower = search.toLowerCase();
        entries = entries.filter(([type, def]) =>
          type.toLowerCase().includes(searchLower) ||
          def.label.toLowerCase().includes(searchLower) ||
          (def.description && def.description.toLowerCase().includes(searchLower))
        );
      }

      if (feature) {
        const featureMap = {
          required: 'supportsRequired',
          conditional: 'supportsConditionalLogic',
          duplicate: 'supportsDuplicate',
          prepopulate: 'supportsPrepopulate',
          visibility: 'supportsVisibility',
          description: 'supportsDescription',
          validation: 'supportsValidation',
          css_class: 'supportsCssClass'
        };
        const key = featureMap[feature] || feature;
        entries = entries.filter(([, def]) => def[key] === true);
      }

      // Map to output format based on mode
      let fieldTypes;
      if (detail) {
        fieldTypes = entries.map(([type, def]) => ({
          type,
          label: def.label,
          category: def.category,
          description: def.description,
          icon: def.icon,
          supports: {
            required: def.supportsRequired || false,
            conditional: def.supportsConditional || false,
            duplicate: def.supportsDuplicate || false,
            prepopulate: def.supportsPrepopulate || false,
            visibility: def.supportsVisibility || false,
            description: def.supportsDescription || false,
            validation: def.supportsValidation || false,
            css_class: def.supportsCssClass || false
          },
          variants: include_variants && def.variants ?
            Object.entries(def.variants).map(([name, variant]) => ({
              name,
              label: variant.label,
              description: variant.description,
              settings: variant.settings
            })) : undefined,
          storage: def.storage,
          validation: def.validation
        }));
      } else {
        // Summary mode (default) — minimal tokens
        fieldTypes = entries.map(([type, def]) => ({
          type,
          label: def.label,
          category: def.category
        }));
      }

      return {
        field_types: fieldTypes,
        total: fieldTypes.length
      };
    } catch (error) {
      return {
        error: error.message
      };
    }
  }
};

/**
 * MCP Tool Definitions for field operations
 */
export const fieldOperationTools = [
  {
    name: 'gf_add_field',
    description: 'Add a field to a form',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID'
        },
        field_type: {
          type: 'string',
          description: 'Field type (text, email, address, etc.)'
        },
        properties: {
          type: 'object',
          description: 'Field properties',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            isRequired: { type: 'boolean' },
            placeholder: { type: 'string' },
            defaultValue: { type: 'string' },
            cssClass: { type: 'string' },
            size: { type: 'string', enum: ['small', 'medium', 'large'] },
            visibility: { type: 'string', enum: ['visible', 'hidden', 'administrative'] }
          }
        },
        position: {
          type: 'object',
          description: 'Field positioning',
          properties: {
            mode: { type: 'string', enum: ['append', 'prepend', 'after', 'before', 'index'] },
            reference: { type: 'number', description: 'Reference field ID or index' },
            page: { type: 'number', description: 'Page number' }
          }
        },
        test_mode: {
          type: 'boolean',
          description: 'Test mode',
          default: false
        }
      },
      required: ['form_id', 'field_type']
    }
  },
  {
    name: 'gf_update_field',
    description: 'Update a field in a form',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID'
        },
        field_id: {
          type: 'number',
          description: 'Field ID'
        },
        properties: {
          type: 'object',
          description: 'Properties to update'
        },
        force: {
          type: 'boolean',
          description: 'Force update despite dependencies',
          default: false
        },
        test_mode: {
          type: 'boolean',
          description: 'Test mode',
          default: false
        }
      },
      required: ['form_id', 'field_id', 'properties']
    }
  },
  {
    name: 'gf_delete_field',
    description: 'Delete a field (checks dependencies)',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID'
        },
        field_id: {
          type: 'number',
          description: 'Field ID'
        },
        cascade: {
          type: 'boolean',
          description: 'Clean up dependencies',
          default: false
        },
        force: {
          type: 'boolean',
          description: 'Force delete',
          default: false
        },
        test_mode: {
          type: 'boolean',
          description: 'Test mode',
          default: false
        }
      },
      required: ['form_id', 'field_id']
    }
  },
  {
    name: 'gf_list_field_types',
    description: 'List available field types. Returns type/label/category by default; use detail=true for full metadata.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category (standard, advanced, pricing, post)'
        },
        feature: {
          type: 'string',
          description: 'Filter by feature (required, conditional, duplicate, prepopulate, visibility)'
        },
        search: {
          type: 'string',
          description: 'Search field type names/labels'
        },
        detail: {
          type: 'boolean',
          description: 'Return full metadata (supports, storage, validation, icon)',
          default: false
        },
        include_variants: {
          type: 'boolean',
          description: 'Include field variants (requires detail=true)',
          default: false
        }
      }
    }
  }
];