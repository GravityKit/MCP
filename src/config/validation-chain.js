/**
 * Validation Chain
 * Composable validation system that chains multiple rules together
 */

import {
  RequiredRule,
  TypeRule,
  StringLengthRule,
  NumberRangeRule,
  PatternRule,
  EmailRule,
  URLRule,
  DateRule,
  EnumRule,
  PositiveIntegerRule,
  CustomRule,
  TrimRule,
  LowercaseRule
} from './validation-rules.js';

/**
 * ValidationChain class for composing validation rules
 */
export class ValidationChain {
  constructor(fieldName) {
    this.fieldName = fieldName;
    this.rules = [];
  }
  
  /**
   * Add a validation rule to the chain
   */
  addRule(rule) {
    this.rules.push(rule);
    return this;
  }
  
  /**
   * Field is required
   */
  required() {
    return this.addRule(new RequiredRule());
  }
  
  /**
   * Field must be a string
   */
  string() {
    return this.addRule(new TypeRule('string'));
  }
  
  /**
   * Field must be a number
   */
  number() {
    return this.addRule(new TypeRule('number'));
  }
  
  /**
   * Field must be a boolean
   */
  boolean() {
    return this.addRule(new TypeRule('boolean'));
  }
  
  /**
   * Field must be an array
   */
  array() {
    return this.addRule(new TypeRule('array'));
  }
  
  /**
   * Field must be an object
   */
  object() {
    return this.addRule(new TypeRule('object'));
  }
  
  /**
   * String length validation
   */
  length(minLength = null, maxLength = null) {
    return this.addRule(new StringLengthRule(minLength, maxLength));
  }
  
  /**
   * Minimum length
   */
  minLength(min) {
    return this.addRule(new StringLengthRule(min, null));
  }
  
  /**
   * Maximum length
   */
  maxLength(max) {
    return this.addRule(new StringLengthRule(null, max));
  }
  
  /**
   * Number range validation
   */
  range(min = null, max = null) {
    return this.addRule(new NumberRangeRule(min, max));
  }
  
  /**
   * Minimum value
   */
  min(min) {
    return this.addRule(new NumberRangeRule(min, null));
  }
  
  /**
   * Maximum value
   */
  max(max) {
    return this.addRule(new NumberRangeRule(null, max));
  }
  
  /**
   * Pattern validation
   */
  pattern(regex, errorMessage) {
    return this.addRule(new PatternRule(regex, errorMessage));
  }
  
  /**
   * Email validation
   */
  email() {
    return this.addRule(new EmailRule());
  }
  
  /**
   * URL validation
   */
  url() {
    return this.addRule(new URLRule());
  }
  
  /**
   * Date validation (ISO 8601)
   */
  date() {
    return this.addRule(new DateRule());
  }
  
  /**
   * Enum validation
   */
  enum(allowedValues) {
    return this.addRule(new EnumRule(allowedValues));
  }
  
  /**
   * Positive integer validation
   */
  positiveInteger() {
    return this.addRule(new PositiveIntegerRule());
  }
  
  /**
   * Custom validation
   */
  custom(validateFn, errorMessage = 'Validation failed') {
    return this.addRule(new CustomRule(validateFn, errorMessage));
  }
  
  /**
   * Trim whitespace
   */
  trim() {
    return this.addRule(new TrimRule());
  }
  
  /**
   * Convert to lowercase
   */
  lowercase() {
    return this.addRule(new LowercaseRule());
  }
  
  /**
   * Validate the value
   */
  validate(value) {
    let result = value;
    
    for (const rule of this.rules) {
      result = rule.validate(result, this.fieldName);
    }
    
    return result;
  }
  
  /**
   * Validate with error context
   */
  validateWithContext(value, context = {}) {
    try {
      return {
        valid: true,
        value: this.validate(value),
        field: this.fieldName,
        context
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        field: this.fieldName,
        value,
        context
      };
    }
  }
}

/**
 * Factory function for creating validation chains
 */
export function validate(fieldName) {
  return new ValidationChain(fieldName);
}

/**
 * Validate multiple fields
 */
export class ValidationSchema {
  constructor() {
    this.fields = {};
  }
  
  /**
   * Add field validation
   */
  field(name, chain) {
    this.fields[name] = chain;
    return this;
  }
  
  /**
   * Validate an object
   */
  validate(data) {
    const errors = [];
    const validated = {};
    
    for (const [fieldName, chain] of Object.entries(this.fields)) {
      try {
        const value = data[fieldName];
        const result = chain.validate(value);
        // Only materialize keys that carry a value. A declared-but-omitted
        // optional field would otherwise land as `key: undefined`, and a later
        // fetch-then-merge spread copies that undefined over real fetched data
        // (gf_update_feed shipped PUT bodies with no `meta` because of this).
        if (result !== undefined) {
          validated[fieldName] = result;
        }
      } catch (error) {
        errors.push({
          field: fieldName,
          message: error.message,
          value: data[fieldName]
        });
      }
    }
    
    if (errors.length > 0) {
      const error = new ValidationError('Validation failed', errors);
      throw error;
    }
    
    return validated;
  }
  
  /**
   * Validate with detailed results
   */
  validateWithDetails(data) {
    const errors = [];
    const validated = {};
    const details = {};
    
    for (const [fieldName, chain] of Object.entries(this.fields)) {
      const result = chain.validateWithContext(data[fieldName]);
      details[fieldName] = result;
      
      if (result.valid) {
        validated[fieldName] = result.value;
      } else {
        errors.push({
          field: fieldName,
          message: result.error,
          value: result.value
        });
      }
    }
    
    return {
      valid: errors.length === 0,
      data: validated,
      errors,
      details
    };
  }
}

/**
 * Validation error with context
 */
export class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
  
  /**
   * Get formatted error message
   */
  getFormattedMessage() {
    if (this.errors.length === 0) {
      return this.message;
    }
    
    if (this.errors.length === 1) {
      return this.errors[0].message;
    }
    
    const errorList = this.errors
      .map(e => `  - ${e.field}: ${e.message}`)
      .join('\n');
    
    return `${this.message}:\n${errorList}`;
  }
  
  /**
   * Get errors for a specific field
   */
  getFieldErrors(fieldName) {
    return this.errors.filter(e => e.field === fieldName);
  }
  
  /**
   * Check if a specific field has errors
   */
  hasFieldError(fieldName) {
    return this.errors.some(e => e.field === fieldName);
  }
}