/**
 * Field Manager - Core orchestrator for field operations
 * Handles field CRUD operations within REST API v2 constraints
 */

export class FieldManager {
  constructor(apiClient, fieldRegistry, validator) {
    this.api = apiClient;
    this.registry = fieldRegistry;
    this.validator = validator;
    this.dependencyTracker = null; // Will be injected
    this.positionEngine = null;    // Will be injected
  }

  /**
   * Add a new field to a form with intelligent defaults
   * @param {number} formId - Target form ID
   * @param {string} fieldType - Field type from registry
   * @param {object} properties - Field configuration
   * @param {object} position - Positioning configuration
   * @returns {object} Field creation result with warnings
   */
  async addField(formId, fieldType, properties = {}, position = {}) {
    // 1. Validate field type against registry
    const fieldDef = this.registry[fieldType];
    if (!fieldDef) {
      throw new Error(`Unknown field type: ${fieldType}`);
    }

    // 2. Fetch current form via REST API
    const { form } = await this.api.getForm({ id: formId });
    
    // 3. Generate unique integer field ID (max + 1 pattern)
    const fieldId = this.generateFieldId(form.fields || []);
    
    // 4. Create field with type-specific defaults
    const field = this.createField(fieldId, fieldType, properties, fieldDef);
    
    // 5. Generate compound sub-inputs if needed (address.1, name.3, etc.)
    if (fieldDef.storage?.type === 'compound') {
      field.inputs = this.generateSubInputs(field, fieldDef);
    }
    
    // 6. Calculate insertion position (page-aware)
    const insertIndex = this.positionEngine?.calculatePosition(
      form.fields || [],
      position,
      form.pagination
    ) || form.fields?.length || 0;
    
    // 7. Insert field at calculated position
    if (!form.fields) form.fields = [];
    form.fields.splice(insertIndex, 0, field);
    
    // 8. Replace form via direct PUT (no re-fetch — we already have the full state)
    const updatedForm = await this.api.replaceForm(formId, form);
    
    // 9. Return result with validation warnings
    return {
      success: true,
      field: field,
      warnings: this.validator?.getWarnings(field) || [],
      form_id: formId,
      position: { 
        index: insertIndex, 
        page: field.pageNumber || 1 
      }
    };
  }

  /**
   * Update existing field with dependency checking
   */
  async updateField(formId, fieldId, updates = {}) {
    // Fetch form
    const { form } = await this.api.getForm({ id: formId });
    
    // Find field
    const fieldIndex = form.fields?.findIndex(f => f.id == fieldId);
    if (fieldIndex === -1) {
      throw new Error(`Field ${fieldId} not found in form ${formId}`);
    }
    
    // Check dependencies
    const dependencies = this.dependencyTracker?.scanFormDependencies(form, fieldId) || {};
    
    // Apply updates
    const originalField = { ...form.fields[fieldIndex] };
    form.fields[fieldIndex] = {
      ...originalField,
      ...updates,
      id: originalField.id // Preserve ID
    };

    // Replace form via direct PUT (no re-fetch — we already have the full state)
    const result = await this.api.replaceForm(formId, form);
    
    return {
      success: true,
      field: result.form.fields[fieldIndex],
      changes: {
        before: originalField,
        after: result.form.fields[fieldIndex]
      },
      warnings: {
        dependencies: dependencies.conditionalLogic?.length > 0 ? 
          ['Field has conditional logic dependencies'] : [],
        validationIssues: this.validator?.getWarnings(result.form.fields[fieldIndex]) || []
      }
    };
  }

  /**
   * Delete field with comprehensive dependency analysis
   */
  async deleteField(formId, fieldId, options = {}) {
    const { cascade = false, force = false } = options;
    
    // Fetch form
    const { form } = await this.api.getForm({ id: formId });
    
    // Check field exists
    const field = form.fields?.find(f => f.id == fieldId);
    if (!field) {
      throw new Error(`Field ${fieldId} not found in form ${formId}`);
    }
    
    // Scan dependencies
    const dependencies = this.dependencyTracker?.scanFormDependencies(form, fieldId) || {};
    const hasBreakingDeps = this.dependencyTracker?.hasBreakingDependencies(dependencies);
    
    // Handle dependencies
    if (hasBreakingDeps && !force) {
      return {
        success: false,
        error: 'Field has dependencies that would break',
        deleted_field: {
          id: field.id,
          type: field.type,
          label: field.label
        },
        dependencies,
        suggestion: 'Use force=true to delete anyway, or cascade=true to clean up dependencies'
      };
    }
    
    // Remove field
    form.fields = form.fields.filter(f => f.id != fieldId);
    
    // Clean up dependencies if cascade
    if (cascade && hasBreakingDeps) {
      this.cleanupDependencies(form, fieldId);
    }
    
    // Replace form via direct PUT (no re-fetch — we already have the full state)
    await this.api.replaceForm(formId, form);

    return {
      success: true,
      deleted_field: {
        id: field.id,
        type: field.type,
        label: field.label
      },
      dependencies,
      actions_taken: cascade ? ['Dependencies cleaned up'] : []
    };
  }

  /**
   * Generate unique integer field ID using max+1 pattern
   */
  generateFieldId(existingFields) {
    if (!existingFields || existingFields.length === 0) return 1;
    
    const maxId = existingFields.reduce((max, field) => {
      const id = parseInt(field.id);
      return isNaN(id) ? max : Math.max(max, id);
    }, 0);
    
    return maxId + 1;
  }

  /**
   * Create field with intelligent defaults from registry
   */
  createField(id, type, properties, fieldDef) {
    return {
      id,
      type,
      label: properties.label || fieldDef.label || 'Untitled',
      adminLabel: properties.adminLabel || '',
      isRequired: properties.isRequired || false,
      size: properties.size || fieldDef.defaults?.size || 'medium',
      errorMessage: properties.errorMessage || '',
      visibility: properties.visibility || 'visible',
      cssClass: properties.cssClass || '',
      ...this.getTypeSpecificDefaults(type, fieldDef),
      ...properties
    };
  }

  /**
   * Generate compound sub-inputs (address.1, name.3, etc.)
   */
  generateSubInputs(field, fieldDef) {
    const subInputs = [];
    const baseId = field.id;
    
    // Address field sub-inputs
    if (field.type === 'address') {
      const variant = field.addressType || 'us';
      
      if (variant === 'us' || variant === 'international') {
        subInputs.push(
          { id: `${baseId}.1`, label: 'Street Address', name: '' },
          { id: `${baseId}.2`, label: 'Address Line 2', name: '' },
          { id: `${baseId}.3`, label: 'City', name: '' },
          { id: `${baseId}.4`, label: variant === 'us' ? 'State' : 'State / Province', name: '' },
          { id: `${baseId}.5`, label: variant === 'us' ? 'ZIP Code' : 'ZIP / Postal Code', name: '' },
          { id: `${baseId}.6`, label: 'Country', name: '' }
        );
      } else if (variant === 'canadian') {
        subInputs.push(
          { id: `${baseId}.1`, label: 'Street Address', name: '' },
          { id: `${baseId}.2`, label: 'Address Line 2', name: '' },
          { id: `${baseId}.3`, label: 'City', name: '' },
          { id: `${baseId}.4`, label: 'Province', name: '' },
          { id: `${baseId}.5`, label: 'Postal Code', name: '' },
          { id: `${baseId}.6`, label: 'Country', name: '' }
        );
      }
    }
    
    // Name field sub-inputs
    else if (field.type === 'name') {
      const format = field.nameFormat || 'advanced';
      
      if (format === 'advanced') {
        subInputs.push(
          { id: `${baseId}.2`, label: 'Prefix', name: '' },
          { id: `${baseId}.3`, label: 'First', name: '' },
          { id: `${baseId}.4`, label: 'Middle', name: '' },
          { id: `${baseId}.6`, label: 'Last', name: '' },
          { id: `${baseId}.8`, label: 'Suffix', name: '' }
        );
      } else {
        subInputs.push(
          { id: `${baseId}.3`, label: 'First', name: '' },
          { id: `${baseId}.6`, label: 'Last', name: '' }
        );
      }
    }
    
    // Credit card field sub-inputs
    else if (field.type === 'creditcard') {
      subInputs.push(
        { id: `${baseId}.1`, label: 'Card Number', name: '' },
        { id: `${baseId}.2`, label: 'Expiration Date', name: '' },
        { id: `${baseId}.3`, label: 'Security Code', name: '' },
        { id: `${baseId}.4`, label: 'Cardholder Name', name: '' },
        { id: `${baseId}.5`, label: 'Card Type', name: '' }
      );
    }
    
    return subInputs;
  }

  /**
   * Get type-specific default values
   */
  getTypeSpecificDefaults(type, fieldDef) {
    const defaults = {};
    
    // Add choices for choice-based fields
    if (fieldDef.hasChoices) {
      defaults.choices = [
        { text: 'First Choice', value: 'First Choice' },
        { text: 'Second Choice', value: 'Second Choice' },
        { text: 'Third Choice', value: 'Third Choice' }
      ];
    }
    
    // Add date format for date fields
    if (type === 'date') {
      defaults.dateFormat = 'mdy';
      defaults.dateType = 'datepicker';
    }
    
    // Add time format for time fields
    if (type === 'time') {
      defaults.timeFormat = '12';
    }
    
    return defaults;
  }

  /**
   * Clean up dependencies when cascade deleting
   */
  cleanupDependencies(form, fieldId) {
    // Remove from conditional logic rules
    form.fields?.forEach(field => {
      if (field.conditionalLogic?.rules) {
        field.conditionalLogic.rules = field.conditionalLogic.rules.filter(
          rule => rule.fieldId != fieldId
        );
        
        // Disable conditional logic if no rules remain
        if (field.conditionalLogic.rules.length === 0) {
          field.conditionalLogic.enabled = false;
        }
      }
    });
    
    // Note: Calculations and merge tags would need manual review
    // as they use string-based formulas that are harder to clean automatically
  }
}