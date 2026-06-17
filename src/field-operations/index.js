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
        // Entry-value shape per field type. Surfaced for every type whose entry
        // format is NOT an obvious plain string — the ones a small model is most
        // likely to populate wrong. Each hint mirrors the field-registry storage
        // model (compound dot-notation, pricing "Label|amount", add-on choice
        // codes, array-of-rows for repeaters). Plain string fields (text, email,
        // number, phone, website, textarea, hidden) are omitted on purpose.
        const inputHints = {
          // Choice — store the choice VALUE when it has a non-empty value (or
          // "Show Values"/enableChoiceValue is on), ELSE the choice LABEL text.
          // (GF rule: !empty(choice.value) || enableChoiceValue ? value : text;
          // enablePrice then appends "|price".) Inspect the form's choices to know.
          select: 'string: choice value if set (or "Show Values" on); else the choice label',
          radio: 'string: choice value if set (or "Show Values" on); else the choice label',
          checkbox: 'array: selected choices — value if set else label; auto-matched to sub-inputs (N.1, N.2…)',
          multiselect: 'array: choice values if set else labels; commas in a value get split',
          list: 'array: ["a","b"] or [{Col1:"a",Col2:"b"}] for multi-col (free text, no choices)',
          // Compound (dot-notation, keyed by sub-input id)
          name: 'dot-notation: {"1.3":"First","1.6":"Last"}',
          address: 'dot-notation by sub-input (N = field id): {"N.1":"Street","N.2":"Line 2","N.3":"City","N.4":"State","N.5":"ZIP","N.6":"Country"}',
          consent: 'dot-notation: {"5.1":"1","5.2":"text","5.3":"revision"}',
          chainedselect: 'dot-notation, one sub-input per dropdown level (count is dynamic): {"N.1":"Level1 value","N.2":"Level2 value",…}',
          time: 'string: "HH:MM am/pm" (e.g. "12:30 pm"), stored at the field id (one combined value)',
          date: 'string: "YYYY-MM-DD" (always ISO, zero-padded — independent of the field\'s display format)',
          fileupload: 'string: single file URL; a JSON array of URLs (e.g. ["https://.../a.pdf"]) when multipleFiles is on or the field\'s storageType is "json"',
          signature: 'string: the saved signature image filename (e.g. "<hash>.png")',
          password: 'not stored — the entry value is always empty ("")',
          // Post fields
          post_image: 'string: "url|:|title|:|caption|:|description|:|alt" — one composite joined by "|:|" (5 segments); a bare URL alone is fine, trailing parts may be empty',
          // Pricing (price encoded as "Label|amount")
          product: 'singleproduct: dot-notation {"N.1":"Name","N.2":"10.00","N.3":"qty"}; select/radio: "Name|10.00"; price (User Defined): single money string',
          option: 'string: "Label|price"; checkbox option: dot-notation per choice',
          quantity: 'string: "2" (integer)',
          shipping: 'string: "Method|price" (or "price")',
          total: 'string: "29.99" — calculated from pricing fields; rarely set directly',
          // Surveys / quiz / poll. Choice VALUES are add-on-generated tokens of
          // the form "g<kind><fieldId><hex>" (e.g. gsurvey5a1b2c3d); inspect the
          // form's choices for the real tokens.
          survey_likert: 'single-row: string = the column token "glikertcol<fieldId><hex>"; multi-row: dot-notation keyed by sub-input id (N.1, N.2…) with value "glikertrow<hex>:glikertcol<fieldId><hex>"',
          survey_rating: 'string: the rating choice value token "grating<fieldId><hex>" (e.g. "grating5a1b2c3d")',
          survey_rank: 'string: all choice values in ranked order, comma-separated (order = the data). Choice value tokens are comma-free, so the delimiter is unambiguous (labels are not stored).',
          survey: 'by inputType: radio/select→string, checkbox→dot-notation sub-inputs, text/textarea→string, rank/rating/likert→see survey_rank/survey_rating/survey_likert. Choice values are "gsurvey<fieldId><hex>" tokens',
          quiz: 'string: "gquiz<fieldId><hex>" (radio/select) or dot-notation sub-inputs N.1/N.2 (checkbox)',
          poll: 'string: "gpoll<fieldId><hex>" (radio/select) or dot-notation sub-inputs (checkbox)',
          // Repeaters / nested
          repeater: 'array of row objects: [{"<subFieldId>":"val", ...}, ...]',
          form: 'comma-separated string of child entry ids, e.g. "101,102" (create child entries first)',
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