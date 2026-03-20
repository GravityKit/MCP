/**
 * Field Definition Loader Module
 * 
 * Loads and manages Gravity Forms field type definitions
 * to ensure 100% valid structure for forms, entries, and JSON data.
 * 
 * This module integrates with the gravity-forms-field-definitions
 * to provide comprehensive field-aware validation and processing.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Field Definition Loader Class
 * 
 * Responsible for:
 * - Locating field definitions in the MonoKit structure
 * - Loading TypeScript field definitions
 * - Providing access to field metadata, validation, and storage patterns
 * - Caching definitions for performance
 */
export class FieldDefinitionLoader {
  constructor() {
    this.definitions = new Map();
    this.fieldPath = null;
    this.isLoaded = false;
    this.useBasicValidation = false;
    
    // Field type metadata cache
    this.fieldMetaCache = new Map();
    this.variantCache = new Map();
    this.storagePatternCache = new Map();
  }

  /**
   * Initialize the loader and load definitions
   */
  async initialize() {
    if (this.isLoaded) {
      return true;
    }

    try {
      this.fieldPath = this.findFieldDefinitions();
      await this.loadDefinitions();
      this.isLoaded = true;
      return true;
    } catch (error) {
      logger.error(`[FieldLoader] Initialization failed: ${error.message}`);
      this.useBasicValidation = true;
      return false;
    }
  }

  /**
   * Find field definitions in the file system
   * Checks multiple possible locations
   */
  findFieldDefinitions() {
    const possiblePaths = [
      // Primary: Direct path in MonoKit structure
      join(__dirname, '../../../../../Development/Gravity-Forms/gravity-forms-field-definitions'),
      
      // Secondary: As an npm dependency
      join(__dirname, '../../../node_modules/@gravitykit/gravity-forms-field-definitions'),
      
      // Tertiary: Environment variable override
      process.env.GF_FIELD_DEFINITIONS_PATH,
      
      // Fallback: Look for compiled dist directory
      join(__dirname, '../../../../../Development/Gravity-Forms/gravity-forms-field-definitions/dist'),
      
      // Alternative: Check for TypeScript source
      join(__dirname, '../../../../../Development/Gravity-Forms/gravity-forms-field-definitions/src/types/fields')
    ].filter(Boolean);

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        logger.info(`[FieldLoader] Found field definitions at: ${path}`);
        return path;
      }
    }

    throw new Error('Field definitions not found. Please ensure gravity-forms-field-definitions are available.');
  }

  /**
   * Load field definitions from the discovered path
   */
  async loadDefinitions() {
    try {
      // Check if we have compiled JavaScript definitions
      const distPath = join(this.fieldPath, 'dist', 'index.js');
      if (existsSync(distPath)) {
        await this.loadCompiledDefinitions(distPath);
        return;
      }

      // Otherwise, load from TypeScript source
      const fieldsPath = join(this.fieldPath, 'src', 'types', 'fields');
      if (existsSync(fieldsPath)) {
        await this.loadTypeScriptDefinitions(fieldsPath);
        return;
      }

      // Load from direct fields directory if that's what we found
      if (this.fieldPath.includes('types/fields')) {
        await this.loadTypeScriptDefinitions(this.fieldPath);
        return;
      }

      throw new Error('Could not find loadable field definitions');
    } catch (error) {
      logger.error(`[FieldLoader] Failed to load definitions: ${error}`);
      throw error;
    }
  }

  /**
   * Load compiled JavaScript definitions
   */
  async loadCompiledDefinitions(distPath) {
    try {
      const module = await import(distPath);
      const { fieldRegistry } = module;
      
      if (fieldRegistry && fieldRegistry.entries) {
        for (const [fieldType, definition] of fieldRegistry.entries()) {
          this.definitions.set(fieldType, definition);
          this.cacheFieldMetadata(fieldType, definition);
        }
      }
      
      logger.info(`[FieldLoader] Loaded ${this.definitions.size} compiled field definitions`);
    } catch (error) {
      logger.error(`[FieldLoader] Error loading compiled definitions: ${error}`);
      throw error;
    }
  }

  /**
   * Load TypeScript definitions by parsing the source
   */
  async loadTypeScriptDefinitions(fieldsPath) {
    try {
      const fieldDirs = readdirSync(fieldsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const fieldDir of fieldDirs) {
        const fieldPath = join(fieldsPath, fieldDir);
        const definition = await this.parseFieldDefinition(fieldPath, fieldDir);
        
        if (definition) {
          this.definitions.set(fieldDir, definition);
          this.cacheFieldMetadata(fieldDir, definition);
        }
      }

      logger.info(`[FieldLoader] Loaded ${this.definitions.size} TypeScript field definitions`);
    } catch (error) {
      logger.error(`[FieldLoader] Error loading TypeScript definitions: ${error}`);
      throw error;
    }
  }

  /**
   * Parse a single field definition from TypeScript files
   */
  async parseFieldDefinition(fieldPath, fieldType) {
    try {
      // Look for the main types file
      const typesFile = join(fieldPath, `${fieldType}.types.ts`);
      
      if (!existsSync(typesFile)) {
        logger.warn(`[FieldLoader] No types file found for ${fieldType}`);
        return null;
      }

      // Read and parse the TypeScript file
      const content = readFileSync(typesFile, 'utf8');
      
      // Extract field metadata
      const meta = this.extractFieldMeta(content, fieldType);
      const storage = this.extractStoragePattern(content, fieldType);
      const variants = this.extractVariants(content, fieldType);
      const validation = this.extractValidation(content, fieldType);
      const hooks = this.extractHooks(content, fieldType);

      return {
        meta,
        storage,
        variants,
        validation,
        hooks,
        fieldType
      };
    } catch (error) {
      logger.error(`[FieldLoader] Error parsing ${fieldType}: ${error}`);
      return null;
    }
  }

  /**
   * Extract field metadata from TypeScript content
   */
  extractFieldMeta(content, fieldType) {
    const meta = {
      type: fieldType,
      label: this.formatFieldLabel(fieldType),
      supportsConditionalLogic: false,
      supportsRequired: false,
      storesData: true,
      isCompound: false,
      isArray: false
    };

    // Check for common patterns
    if (content.includes('supportsConditionalLogic: true')) {
      meta.supportsConditionalLogic = true;
    }
    if (content.includes('supportsRequired: true')) {
      meta.supportsRequired = true;
    }
    if (content.includes('storesData: false')) {
      meta.storesData = false;
    }

    // Check for compound fields
    const compoundFields = ['address', 'name', 'creditcard', 'quiz', 'poll', 'survey'];
    if (compoundFields.includes(fieldType)) {
      meta.isCompound = true;
    }

    // Check for array fields
    const arrayFields = ['checkbox', 'multiselect', 'list', 'repeater'];
    if (arrayFields.includes(fieldType) || content.includes('multiple: true')) {
      meta.isArray = true;
    }

    return meta;
  }

  /**
   * Extract storage pattern from TypeScript content
   */
  extractStoragePattern(content, _fieldType) {
    const storage = {
      type: 'string',
      sqlType: 'LONGTEXT',
      format: 'single',
      serialize: null,
      deserialize: null
    };

    // Check for JSON storage
    if (content.includes('JSON.stringify') || content.includes('JSON.parse')) {
      storage.type = 'json';
      storage.format = 'json';
    }

    // Check for array storage
    if (content.includes('Array<') || content.includes('[]')) {
      storage.type = 'array';
      storage.format = 'array';
    }

    // Check for compound storage
    if (content.includes('dot notation') || content.includes(`entry['`) && content.includes('.')) {
      storage.format = 'compound';
    }

    return storage;
  }

  /**
   * Extract field variants from TypeScript content
   */
  extractVariants(content, fieldType) {
    const variants = {};

    // Default variant
    variants.default = {
      id: 'default',
      label: 'Default',
      settings: {},
      behavior: 'Standard field behavior'
    };

    // Check for specific variants
    if (fieldType === 'fileupload') {
      if (content.includes('multipleFiles')) {
        variants.multipleFiles = {
          id: 'multipleFiles',
          label: 'Multiple Files',
          settings: { multipleFiles: true },
          behavior: 'Allows multiple file uploads, stores as JSON array'
        };
      }
    }

    if (fieldType === 'text' && content.includes('enablePasswordInput')) {
      variants.passwordInput = {
        id: 'passwordInput',
        label: 'Password Input',
        settings: { enablePasswordInput: true },
        behavior: 'Text field rendered as password input'
      };
    }

    if (fieldType === 'date' && content.includes('dateFormat')) {
      variants.datepicker = {
        id: 'datepicker',
        label: 'Date Picker',
        settings: { dateType: 'datepicker' },
        behavior: 'Shows date picker interface'
      };
    }

    return variants;
  }

  /**
   * Extract validation rules from TypeScript content
   */
  extractValidation(content, fieldType) {
    const validation = {
      rules: [],
      messages: {}
    };

    // Add required validation if supported
    if (content.includes('supportsRequired: true') || content.includes('isRequired')) {
      validation.rules.push({
        id: 'required',
        type: 'required',
        validator: (value, field) => {
          if (!field.isRequired) {
            return { isValid: true };
          }
          const isEmpty = value === null || value === undefined || value === '';
          return {
            isValid: !isEmpty,
            message: isEmpty ? 'This field is required.' : ''
          };
        }
      });
      validation.messages.required = 'This field is required.';
    }

    // Add field-specific validation
    if (fieldType === 'email') {
      validation.rules.push({
        id: 'email',
        type: 'format',
        validator: (value) => {
          if (!value) return { isValid: true };
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return {
            isValid: emailRegex.test(value),
            message: 'Please enter a valid email address.'
          };
        }
      });
    }

    if (fieldType === 'number') {
      validation.rules.push({
        id: 'number',
        type: 'format',
        validator: (value, field) => {
          if (!value) return { isValid: true };
          const num = Number(value);
          if (isNaN(num)) {
            return { isValid: false, message: 'Please enter a valid number.' };
          }
          if (field.rangeMin !== undefined && num < field.rangeMin) {
            return { isValid: false, message: `Value must be at least ${field.rangeMin}.` };
          }
          if (field.rangeMax !== undefined && num > field.rangeMax) {
            return { isValid: false, message: `Value must be at most ${field.rangeMax}.` };
          }
          return { isValid: true };
        }
      });
    }

    return validation;
  }

  /**
   * Extract hook configurations from TypeScript content
   */
  extractHooks(content, fieldType) {
    const hooks = {};

    // Extract hook patterns
    const hookPattern = /gform_field_value[_\w]*/g;
    const matches = content.match(hookPattern);

    if (matches && matches.length > 0) {
      hooks.value = {
        name: `gform_field_value_${fieldType}`,
        type: 'filter',
        description: `Modify ${fieldType} field value`,
        parameters: [
          { name: 'value', type: 'mixed', description: 'The field value' },
          { name: 'form', type: 'array', description: 'The form object' },
          { name: 'field', type: 'GF_Field', description: 'The field object' }
        ]
      };
    }

    return hooks;
  }

  /**
   * Cache field metadata for quick access
   */
  cacheFieldMetadata(fieldType, definition) {
    if (definition.meta) {
      this.fieldMetaCache.set(fieldType, definition.meta);
    }
    if (definition.variants) {
      this.variantCache.set(fieldType, definition.variants);
    }
    if (definition.storage) {
      this.storagePatternCache.set(fieldType, definition.storage);
    }
  }

  /**
   * Get field definition by type
   */
  getFieldDefinition(type) {
    if (!this.isLoaded && !this.useBasicValidation) {
      logger.warn('[FieldLoader] Definitions not loaded yet');
      return null;
    }
    return this.definitions.get(type);
  }

  /**
   * Get all available field types
   */
  getAllFieldTypes() {
    return Array.from(this.definitions.keys());
  }

  /**
   * Get field metadata
   */
  getFieldMeta(type) {
    return this.fieldMetaCache.get(type) || null;
  }

  /**
   * Get field variants
   */
  getFieldVariants(type) {
    return this.variantCache.get(type) || { default: { id: 'default', label: 'Default' } };
  }

  /**
   * Get storage pattern for field type
   */
  getStoragePattern(type) {
    return this.storagePatternCache.get(type) || { type: 'string', format: 'single' };
  }

  /**
   * Check if field type is compound
   */
  isCompoundField(type) {
    const meta = this.getFieldMeta(type);
    return meta ? meta.isCompound : false;
  }

  /**
   * Check if field type stores array
   */
  isArrayField(type) {
    const meta = this.getFieldMeta(type);
    return meta ? meta.isArray : false;
  }

  /**
   * Format field label from type
   */
  formatFieldLabel(type) {
    return type
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /**
   * Get validation rules for field type
   */
  getValidationRules(type) {
    const definition = this.getFieldDefinition(type);
    return definition && definition.validation ? definition.validation.rules : [];
  }

  /**
   * Detect field variant based on settings
   */
  detectFieldVariant(field) {
    const variants = this.getFieldVariants(field.type);
    
    if (!variants || Object.keys(variants).length <= 1) {
      return 'default';
    }

    // Check each variant's settings to find a match
    for (const [variantId, variant] of Object.entries(variants)) {
      if (variantId === 'default') continue;
      
      const isMatch = Object.entries(variant.settings || {}).every(([key, value]) => {
        return field[key] === value;
      });

      if (isMatch) {
        return variantId;
      }
    }

    return 'default';
  }

  /**
   * Validate field value based on type
   */
  validateFieldValue(value, field) {
    const rules = this.getValidationRules(field.type);
    
    for (const rule of rules) {
      if (rule.validator) {
        const result = rule.validator(value, field);
        if (!result.isValid) {
          return result;
        }
      }
    }

    return { isValid: true };
  }

  /**
   * Get summary of loaded definitions
   */
  getSummary() {
    return {
      isLoaded: this.isLoaded,
      useBasicValidation: this.useBasicValidation,
      fieldTypesCount: this.definitions.size,
      fieldTypes: this.getAllFieldTypes(),
      compoundFields: Array.from(this.definitions.entries())
        .filter(([_, def]) => def.meta && def.meta.isCompound)
        .map(([type]) => type),
      arrayFields: Array.from(this.definitions.entries())
        .filter(([_, def]) => def.meta && def.meta.isArray)
        .map(([type]) => type)
    };
  }
}

// Export singleton instance
let loaderInstance = null;

export function getFieldLoader() {
  if (!loaderInstance) {
    loaderInstance = new FieldDefinitionLoader();
  }
  return loaderInstance;
}

export default FieldDefinitionLoader;