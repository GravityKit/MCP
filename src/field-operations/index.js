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
        // Summary mode (default) — minimal tokens, with entry input hints
        const inputHints = {
          checkbox: 'array: ["val1","val2"] — auto-matched to sub-inputs',
          multiselect: 'array: ["val1","val2"] — commas in values get split',
          select: 'string: "value"',
          radio: 'string: "value"',
          list: 'array: ["a","b"] or [{Col1:"a",Col2:"b"}] for multi-col',
          name: 'dot-notation: {"1.3":"First","1.6":"Last"}',
          address: 'dot-notation: {"2.1":"Street","2.3":"City","2.4":"State","2.5":"ZIP"}',
          consent: 'dot-notation: {"5.1":"1","5.2":"text","5.3":"revision"}',
          chainedselect: 'dot-notation: {"1.1":"Level1","1.2":"Level2"}',
        };
        fieldTypes = entries.map(([type, def]) => {
          const entry = { type, label: def.label, category: def.category };
          if (inputHints[type]) entry.entry_input = inputHints[type];
          return entry;
        });
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
    description: 'Add a field to a form. Auto-handles ID generation, compound sub-inputs (name, address), and page-aware positioning. Use gf_list_field_types for available types.',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID to add the field to'
        },
        field_type: {
          type: 'string',
          description: "Field type slug (e.g. 'text', 'email', 'select', 'name', 'address', 'phone', 'number', 'date', 'checkbox', 'radio', 'hidden', 'html', 'section', 'page')"
        },
        properties: {
          type: 'object',
          description: 'Field configuration',
          properties: {
            label: { type: 'string', description: 'Field label shown to users' },
            description: { type: 'string', description: 'Field help text' },
            isRequired: { type: 'boolean', description: 'Whether field is required' },
            placeholder: { type: 'string', description: 'Placeholder text' },
            defaultValue: { type: 'string', description: 'Default value' },
            cssClass: { type: 'string', description: 'Custom CSS class' },
            size: { type: 'string', enum: ['small', 'medium', 'large'] },
            visibility: { type: 'string', enum: ['visible', 'hidden', 'administrative'], description: "Default: 'visible'" }
          }
        },
        position: {
          type: 'object',
          description: 'Where to place the field',
          properties: {
            mode: { type: 'string', enum: ['append', 'prepend', 'after', 'before', 'index'], description: "Default: 'append'" },
            reference: { type: 'number', description: 'Reference field ID (for after/before) or index' },
            page: { type: 'number', description: 'Page number for multi-page forms' }
          },
          additionalProperties: false
        }
      },
      required: ['form_id', 'field_type']
    }
  },
  {
    name: 'gf_update_field',
    description: 'Update field properties. Checks conditional logic/merge tag dependencies — warns unless force=true. Only provided properties change.',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID containing the field'
        },
        field_id: {
          type: 'number',
          description: 'Field ID to update'
        },
        properties: {
          type: 'object',
          description: 'Properties to change (e.g. {label, isRequired, choices})'
        },
        force: {
          type: 'boolean',
          description: 'Update even if other fields depend on this one',
          default: false
        }
      },
      required: ['form_id', 'field_id', 'properties']
    }
  },
  {
    name: 'gf_delete_field',
    description: 'Delete a field. Checks dependencies (conditional logic, merge tags, calculations). cascade=true auto-cleans references; force=true skips checks.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: {
          type: 'number',
          description: 'Form ID containing the field'
        },
        field_id: {
          type: 'number',
          description: 'Field ID to delete'
        },
        cascade: {
          type: 'boolean',
          description: 'Auto-remove references to this field from other fields',
          default: false
        },
        force: {
          type: 'boolean',
          description: 'Delete even if other fields depend on this one',
          default: false
        }
      },
      required: ['form_id', 'field_id'],
      additionalProperties: false
    }
  },
  {
    name: 'gf_list_field_types',
    description: 'List available field types. Summary by default; detail=true for full metadata (storage, validation, supports). Essential before building forms.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['standard', 'advanced', 'pricing', 'post'],
          description: 'Filter by category'
        },
        feature: {
          type: 'string',
          enum: ['required', 'conditional', 'duplicate', 'prepopulate', 'visibility'],
          description: 'Filter by supported feature'
        },
        search: {
          type: 'string',
          description: 'Search field type names and labels'
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
      },
      additionalProperties: false
    }
  }
];