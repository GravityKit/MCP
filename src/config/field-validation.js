/**
 * Field-Aware Validation Module for Gravity MCP
 *
 * Provides comprehensive field-specific validation using
 * the local field registry to ensure 100% valid structure
 * for forms, entries, and JSON data.
 */

import {
  getFieldDefinition,
  isCompoundField,
  isArrayField,
  fieldStoresData,

  detectFieldVariant,
  validateFieldConfig,
  getCompoundFieldInputs
} from '../field-definitions/field-registry.js';
import logger from '../utils/logger.js';

/**
 * Field-aware validator class
 * Validates form fields and entry data based on field type definitions
 */
export class FieldAwareValidator {
  /**
   * Validate array of form fields
   */
  static validateFormFields(fields) {
    if (!Array.isArray(fields)) {
      throw new Error('Fields must be an array');
    }

    const validated = [];
    const errors = [];

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const validation = this.validateField(field, `fields[${i}]`);

      if (validation.isValid) {
        validated.push(validation.field);
      } else {
        errors.push({
          index: i,
          fieldId: field?.id,
          fieldType: field?.type,
          error: validation.error
        });
      }
    }

    if (errors.length > 0) {
      throw new Error(`Field validation failed: ${JSON.stringify(errors, null, 2)}`);
    }

    return validated;
  }

  /**
   * Validate individual field configuration
   */
  static validateField(field, path = 'field') {
    // Basic field structure validation
    if (!field || typeof field !== 'object') {
      return {
        isValid: false,
        error: `${path}: Field must be an object`
      };
    }

    if (!field.type) {
      return {
        isValid: false,
        error: `${path}: Field must have a type`
      };
    }

    // Get field definition from registry
    const definition = getFieldDefinition(field.type);

    if (!definition) {
      // Check if we're in a test environment
      const isTest = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));

      if (isTest) {
        logger.info(`Handling unknown field type '${field.type}' gracefully`);
      } else {
        logger.warn(`[FieldValidator] Unknown field type '${field.type}' at ${path}`);
      }

      // Allow unknown types (third-party add-ons, GravityKit, custom fields).
      // Gravity Forms accepts them on save; pass the field through unchanged. No
      // internal flag is added: it would be PUT verbatim and nothing reads it.
      return {
        isValid: true,
        field: { ...field }
      };
    }

    // Validate field configuration
    const configValidation = validateFieldConfig(field);
    if (!configValidation.isValid) {
      return {
        isValid: false,
        error: `${path}: ${configValidation.error}`
      };
    }

    // Create validated field object
    const validatedField = { ...field };

    // Detect and validate field variant
    const variant = detectFieldVariant(field);
    validatedField._variant = variant;

    // Validate conditional logic if supported
    if (definition.supportsConditionalLogic && field.conditionalLogic) {
      const clValidation = this.validateConditionalLogic(field.conditionalLogic, path);
      if (!clValidation.isValid) {
        return {
          isValid: false,
          error: clValidation.error
        };
      }
    }

    // Validate required field setting
    if (field.isRequired && !definition.supportsRequired) {
      logger.warn(`${path}: Field type '${field.type}' does not support required validation`);
      validatedField.isRequired = false;
    }

    // Validate choices for choice fields
    if (definition.hasChoices) {
      const choicesValidation = this.validateChoices(field.choices, path);
      if (!choicesValidation.isValid) {
        return {
          isValid: false,
          error: choicesValidation.error
        };
      }
    }

    // Add metadata for processing
    validatedField._meta = {
      isCompound: definition.isCompound || false,
      isArray: definition.isArray || false,
      storesData: definition.storesData !== false,
      storageFormat: definition.storage ? definition.storage.format : 'single'
    };

    // Strip internal metadata before returning
    delete validatedField._variant;
    delete validatedField._meta;

    return {
      isValid: true,
      field: validatedField
    };
  }

  /**
   * Validate conditional logic structure
   */
  static validateConditionalLogic(logic, path) {
    if (!logic || typeof logic !== 'object') {
      return {
        isValid: false,
        error: `${path}: Conditional logic must be an object`
      };
    }

    if (!['show', 'hide'].includes(logic.actionType)) {
      return {
        isValid: false,
        error: `${path}: actionType must be 'show' or 'hide'`
      };
    }

    if (!['all', 'any'].includes(logic.logicType)) {
      return {
        isValid: false,
        error: `${path}: logicType must be 'all' or 'any'`
      };
    }

    if (!Array.isArray(logic.rules)) {
      return {
        isValid: false,
        error: `${path}: rules must be an array`
      };
    }

    // Validate each rule
    for (let i = 0; i < logic.rules.length; i++) {
      const rule = logic.rules[i];
      if (!rule.fieldId || !rule.operator) {
        return {
          isValid: false,
          error: `${path}: rule[${i}] must have fieldId and operator`
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Validate field choices
   */
  static validateChoices(choices, path) {
    if (!choices || !Array.isArray(choices)) {
      return {
        isValid: false,
        error: `${path}: Choices must be an array`
      };
    }

    if (choices.length === 0) {
      return {
        isValid: false,
        error: `${path}: Choices array cannot be empty`
      };
    }

    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      if (!choice.text || choice.value === undefined) {
        return {
          isValid: false,
          error: `${path}: choice[${i}] must have text and value`
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Validate entry data against form fields
   */
  static validateEntryData(entryData, form) {
    if (!entryData || typeof entryData !== 'object') {
      throw new Error('Entry data must be an object');
    }

    if (!form || !form.fields) {
      throw new Error('Form with fields is required for entry validation');
    }

    const validated = { ...entryData };
    const errors = [];

    // Validate each field value
    for (const field of form.fields) {
      const definition = getFieldDefinition(field.type);

      if (!definition) {
        continue; // Skip unknown field types
      }

      // Skip fields that don't store data
      if (!fieldStoresData(field.type)) {
        continue;
      }

      // Get field value(s)
      const fieldValue = this.getFieldValue(entryData, field, definition);

      // Validate required fields
      if (field.isRequired) {
        const requiredValidation = this.validateRequired(fieldValue, field, definition);
        if (!requiredValidation.isValid) {
          errors.push({
            fieldId: field.id,
            fieldType: field.type,
            error: requiredValidation.error
          });
        }
      }

      // Validate field-specific rules
      const typeValidation = this.validateFieldType(fieldValue, field, definition);
      if (!typeValidation.isValid) {
        errors.push({
          fieldId: field.id,
          fieldType: field.type,
          error: typeValidation.error
        });
      }
    }

    if (errors.length > 0) {
      throw new Error(`Entry validation failed: ${JSON.stringify(errors, null, 2)}`);
    }

    return validated;
  }

  /**
   * Get field value from entry data
   */
  static getFieldValue(entryData, field, _definition) {
    // Handle array fields first (checkbox is both isCompound and isArray)
    if (isArrayField(field.type)) {
      const arrayValue = [];
      let index = 1;
      while (entryData[`${field.id}.${index}`] !== undefined) {
        arrayValue.push(entryData[`${field.id}.${index}`]);
        index++;
      }
      return arrayValue.length > 0 ? arrayValue : entryData[field.id];
    }

    // Handle compound fields (name, address, creditcard, consent — NOT checkbox)
    if (isCompoundField(field.type)) {
      const subInputs = getCompoundFieldInputs(field.type);
      if (subInputs) {
        const compoundValue = {};
        for (const [subId, subName] of Object.entries(subInputs)) {
          const key = `${field.id}.${subId}`;
          if (entryData[key] !== undefined) {
            compoundValue[subName] = entryData[key];
          }
        }
        return Object.keys(compoundValue).length > 0 ? compoundValue : null;
      }
    }

    // Handle single value fields
    return entryData[field.id];
  }

  /**
   * Validate required field
   */
  static validateRequired(value, field, _definition) {
    if (!field.isRequired) {
      return { isValid: true };
    }

    let isEmpty = false;

    if (value === null || value === undefined || value === '') {
      isEmpty = true;
    } else if (Array.isArray(value) && value.length === 0) {
      isEmpty = true;
    } else if (typeof value === 'object' && Object.keys(value).length === 0) {
      isEmpty = true;
    }

    if (isEmpty) {
      return {
        isValid: false,
        error: `Field ${field.id} (${field.label || field.type}) is required`
      };
    }

    return { isValid: true };
  }

  /**
   * Validate field type specific rules
   */
  static validateFieldType(value, field, _definition) {
    if (!value) {
      return { isValid: true }; // Empty values handled by required validation
    }

    // Email validation
    if (field.type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return {
          isValid: false,
          error: `Invalid email address in field ${field.id}`
        };
      }
    }

    // URL validation
    if (field.type === 'website') {
      const urlRegex = /^https?:\/\/.+/;
      if (!urlRegex.test(value)) {
        return {
          isValid: false,
          error: `Invalid URL in field ${field.id}`
        };
      }
    }

    // Number validation
    if (field.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        return {
          isValid: false,
          error: `Invalid number in field ${field.id}`
        };
      }

      if (field.rangeMin !== undefined && num < field.rangeMin) {
        return {
          isValid: false,
          error: `Value in field ${field.id} must be at least ${field.rangeMin}`
        };
      }

      if (field.rangeMax !== undefined && num > field.rangeMax) {
        return {
          isValid: false,
          error: `Value in field ${field.id} must be at most ${field.rangeMax}`
        };
      }
    }

    // File upload validation (multiple files variant)
    if (field.type === 'fileupload' && field.multipleFiles) {
      if (typeof value === 'string') {
        try {
          const files = JSON.parse(value);
          if (!Array.isArray(files)) {
            return {
              isValid: false,
              error: `Multiple file upload field ${field.id} must contain JSON array`
            };
          }
        } catch (e) {
          return {
            isValid: false,
            error: `Multiple file upload field ${field.id} must contain valid JSON`
          };
        }
      }
    }

    return { isValid: true };
  }

  /**
   * Process submission data into entry format
   */
  static processSubmissionData(submissionData, form) {
    if (!submissionData || typeof submissionData !== 'object') {
      throw new Error('Submission data must be an object');
    }

    if (!form || !form.fields) {
      throw new Error('Form with fields is required');
    }

    const processed = {
      form_id: form.id,
      date_created: new Date().toISOString(),
      status: 'active'
    };

    // Process each field
    for (const field of form.fields) {
      const definition = getFieldDefinition(field.type);

      if (!definition || !fieldStoresData(field.type)) {
        continue; // Skip fields that don't store data
      }

      // Extract submission value
      const inputValue = this.extractSubmissionValue(submissionData, field, definition);

      if (inputValue === null || inputValue === undefined) {
        continue; // Skip empty values
      }

      // Store based on field type
      // Check array fields first: checkbox is both isCompound and isArray,
      // but uses array-style sequential sub-inputs, not named subInputs.
      if (isArrayField(field.type)) {
        // Store array fields
        if (Array.isArray(inputValue)) {
          // For checkbox fields, store with sequential numbering
          inputValue.forEach((value, index) => {
            processed[`${field.id}.${index + 1}`] = value;
          });
        } else {
          processed[field.id] = inputValue;
        }
      } else if (isCompoundField(field.type)) {
        // Store compound fields with dot notation (name, address, creditcard, consent)
        const subInputs = getCompoundFieldInputs(field.type);
        if (subInputs) {
          for (const [subId, subName] of Object.entries(subInputs)) {
            if (inputValue[subName] !== undefined) {
              processed[`${field.id}.${subId}`] = inputValue[subName];
            }
          }
        } else {
          // Fallback: no subInput mapping for this compound type
          logger.warn(`No subInput mapping for compound field type '${field.type}' (field ${field.id}), storing as single value`);
          processed[field.id] = inputValue;
        }
      } else {
        // Store single value
        processed[field.id] = this.processFieldValue(inputValue, field, definition);
      }
    }

    return processed;
  }

  /**
   * Extract submission value from input data
   */
  static extractSubmissionValue(submissionData, field, _definition) {
    // Handle array fields first (checkbox is both isCompound and isArray)
    if (isArrayField(field.type)) {
      const values = [];
      let index = 1;

      while (submissionData[`input_${field.id}_${index}`] !== undefined) {
        values.push(submissionData[`input_${field.id}_${index}`]);
        index++;
      }

      return values.length > 0 ? values : submissionData[`input_${field.id}`];
    }

    // Handle compound fields (name, address, creditcard, consent)
    if (isCompoundField(field.type)) {
      const subInputs = getCompoundFieldInputs(field.type);
      const value = {};

      if (subInputs) {
        for (const [subId, subName] of Object.entries(subInputs)) {
          const inputKey = `input_${field.id}_${subId}`;
          if (submissionData[inputKey] !== undefined) {
            value[subName] = submissionData[inputKey];
          }
        }
      }

      return Object.keys(value).length > 0 ? value : null;
    }

    // Handle single value fields
    return submissionData[`input_${field.id}`];
  }

  /**
   * Process field value based on type and variant
   */
  static processFieldValue(value, field, _definition) {
    if (value === null || value === undefined) {
      return '';
    }

    // Handle file upload with multiple files variant
    if (field.type === 'fileupload' && field.multipleFiles) {
      if (Array.isArray(value)) {
        return JSON.stringify(value);
      }
    }

    // Handle signature field (base64)
    if (field.type === 'signature') {
      // Ensure proper base64 format
      if (typeof value === 'string' && !value.startsWith('data:')) {
        return `data:image/png;base64,${value}`;
      }
    }

    // Default: convert to string
    return String(value);
  }

  /**
   * Get field validation summary
   */
  static getValidationSummary(form) {
    const summary = {
      totalFields: 0,
      requiredFields: 0,
      conditionalFields: 0,
      compoundFields: 0,
      arrayFields: 0,
      unknownTypes: []
    };

    if (!form || !form.fields) {
      return summary;
    }

    for (const field of form.fields) {
      summary.totalFields++;

      const definition = getFieldDefinition(field.type);

      if (!definition) {
        summary.unknownTypes.push(field.type);
        continue;
      }

      if (field.isRequired) {
        summary.requiredFields++;
      }

      if (field.conditionalLogic) {
        summary.conditionalFields++;
      }

      // Count compound fields (name, address, etc.) but not checkbox
      // which is isCompound for storage but isArray for processing
      if (isCompoundField(field.type) && !isArrayField(field.type)) {
        summary.compoundFields++;
      }

      if (isArrayField(field.type)) {
        summary.arrayFields++;
      }
    }

    return summary;
  }

  /**
   * Non-fatal warnings for a single field, surfaced by gf_add_field and
   * gf_update_field. Never throws — returns an array of human-readable strings
   * (empty when the field looks fine).
   *
   * @param {object} field A Gravity Forms field object.
   * @returns {string[]}
   */
  getWarnings(field) {
    const warnings = [];
    if (!field || typeof field !== 'object') {
      return warnings;
    }

    const id = field.id != null ? String(field.id) : '?';

    const label = typeof field.label === 'string' ? field.label.trim() : '';
    if (!label) {
      warnings.push(`Field ${id} has no label.`);
    }

    // Choice-based fields should define choices.
    const choiceTypes = ['select', 'multiselect', 'checkbox', 'radio'];
    const hasChoices = Array.isArray(field.choices) && field.choices.length > 0;
    if (choiceTypes.includes(field.type) && !hasChoices) {
      warnings.push(`Field ${id} (${field.type}) has no choices defined.`);
    }

    return warnings;
  }
}

export default FieldAwareValidator;