/**
 * Composable Validation Rules
 * Individual validation rules that can be composed together
 */

import { formatErrorMessage, VALIDATION_CONFIG } from './validation-config.js';

/**
 * Base validation rule class
 */
export class ValidationRule {
  constructor(errorMessage) {
    this.errorMessage = errorMessage;
  }
  
  validate(value, fieldName) {
    throw new Error('validate method must be implemented');
  }
  
  getError(fieldName, params = {}) {
    return formatErrorMessage(this.errorMessage, fieldName, params);
  }
}

/**
 * Required field rule
 */
export class RequiredRule extends ValidationRule {
  constructor() {
    super(VALIDATION_CONFIG.errorMessages.required);
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      throw new Error(this.getError(fieldName));
    }
    return value;
  }
}

/**
 * Type validation rules
 */
export class TypeRule extends ValidationRule {
  constructor(type) {
    super(VALIDATION_CONFIG.errorMessages.type[type]);
    this.type = type;
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      return value;
    }
    
    let isValid = false;
    
    switch (this.type) {
      case 'string':
        isValid = typeof value === 'string';
        break;
      case 'number':
        isValid = typeof value === 'number' && !isNaN(value);
        break;
      case 'boolean':
        isValid = typeof value === 'boolean';
        break;
      case 'array':
        isValid = Array.isArray(value);
        break;
      case 'object':
        isValid = typeof value === 'object' && !Array.isArray(value);
        break;
    }
    
    if (!isValid) {
      throw new Error(this.getError(fieldName));
    }
    
    return value;
  }
}

/**
 * String length validation
 */
export class StringLengthRule extends ValidationRule {
  constructor(minLength = null, maxLength = null) {
    super('');
    this.minLength = minLength;
    this.maxLength = maxLength;
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      return value;
    }
    
    if (typeof value !== 'string') {
      return value; // Let TypeRule handle this
    }
    
    const trimmed = value.trim();
    
    if (this.minLength === 1 && trimmed.length === 0) {
      throw new Error(formatErrorMessage(
        VALIDATION_CONFIG.errorMessages.range.empty,
        fieldName
      ));
    }
    
    if (this.minLength !== null && value.length < this.minLength) {
      throw new Error(formatErrorMessage(
        VALIDATION_CONFIG.errorMessages.range.minLength,
        fieldName,
        { min: this.minLength }
      ));
    }
    
    if (this.maxLength !== null && value.length > this.maxLength) {
      throw new Error(formatErrorMessage(
        VALIDATION_CONFIG.errorMessages.range.maxLength,
        fieldName,
        { max: this.maxLength }
      ));
    }
    
    return trimmed;
  }
}

/**
 * Number range validation
 */
export class NumberRangeRule extends ValidationRule {
  constructor(min = null, max = null) {
    super('');
    this.min = min;
    this.max = max;
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      return value;
    }
    
    const num = Number(value);
    if (isNaN(num)) {
      return value; // Let TypeRule handle this
    }
    
    if (this.min !== null && num < this.min) {
      throw new Error(formatErrorMessage(
        VALIDATION_CONFIG.errorMessages.range.min,
        fieldName,
        { min: this.min }
      ));
    }
    
    if (this.max !== null && num > this.max) {
      throw new Error(formatErrorMessage(
        VALIDATION_CONFIG.errorMessages.range.max,
        fieldName,
        { max: this.max }
      ));
    }
    
    return num;
  }
}

/**
 * Pattern validation (regex)
 */
export class PatternRule extends ValidationRule {
  constructor(pattern, errorTemplate) {
    super(errorTemplate);
    this.pattern = pattern;
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null || value === '') {
      return value;
    }
    
    if (typeof value !== 'string') {
      return value; // Let TypeRule handle this
    }
    
    if (!this.pattern.test(value)) {
      throw new Error(this.getError(fieldName));
    }
    
    return value;
  }
}

/**
 * Email validation
 */
export class EmailRule extends PatternRule {
  constructor() {
    super(
      VALIDATION_CONFIG.fields.email.pattern,
      VALIDATION_CONFIG.errorMessages.format.email
    );
  }
  
  validate(value, fieldName) {
    const validated = super.validate(value, fieldName);
    return validated ? validated.toLowerCase() : validated;
  }
}

/**
 * URL validation
 */
export class URLRule extends PatternRule {
  constructor() {
    super(
      VALIDATION_CONFIG.fields.url.pattern,
      VALIDATION_CONFIG.errorMessages.format.url
    );
  }
}

/**
 * Date validation (ISO 8601)
 */
export class DateRule extends PatternRule {
  constructor() {
    super(
      VALIDATION_CONFIG.dates.iso8601.pattern,
      VALIDATION_CONFIG.errorMessages.format.date
    );
  }
  
  getError(fieldName) {
    return formatErrorMessage(this.errorMessage, fieldName, {
      format: 'ISO 8601'
    });
  }
}

/**
 * Enum validation
 */
export class EnumRule extends ValidationRule {
  constructor(allowedValues) {
    super(VALIDATION_CONFIG.errorMessages.enum);
    this.allowedValues = allowedValues;
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      return value;
    }
    
    if (!this.allowedValues.includes(value)) {
      throw new Error(formatErrorMessage(
        this.errorMessage,
        fieldName,
        { values: this.allowedValues.join(', ') }
      ));
    }
    
    return value;
  }
}

/**
 * Positive integer validation
 */
export class PositiveIntegerRule extends ValidationRule {
  constructor() {
    super(VALIDATION_CONFIG.errorMessages.format.id);
  }
  
  validate(value, fieldName) {
    if (value === undefined || value === null) {
      return value;
    }

    // GF types these as integers and 400s anything that isn't an integer-formatted
    // value. `Number(value)` is far too lax: it coerces JS-hex ("0x10" -> 16),
    // booleans (true -> 1), scientific notation, and silently rounds values past
    // Number.MAX_SAFE_INTEGER. Accept ONLY genuine integers:
    //  - a number that is a safe, positive integer, OR
    //  - a string of decimal digits only (/^\d+$/) that parses to a safe, positive int.
    let num;
    if (typeof value === 'number') {
      num = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      num = Number(value);
    } else {
      throw new Error(this.getError(fieldName));
    }

    const isGenuineInteger =
      Number.isInteger(num) && Number.isSafeInteger(num) && num > 0;

    if (!isGenuineInteger) {
      throw new Error(this.getError(fieldName));
    }

    return num;
  }
}

/**
 * Custom validation rule
 */
export class CustomRule extends ValidationRule {
  constructor(validateFn, errorMessage) {
    super(errorMessage);
    this.validateFn = validateFn;
  }
  
  validate(value, fieldName) {
    const result = this.validateFn(value, fieldName);
    if (result !== true && result !== undefined) {
      throw new Error(result);
    }
    return value;
  }
}

/**
 * Transform rule (modifies value without validation)
 */
export class TransformRule extends ValidationRule {
  constructor(transformFn) {
    super('');
    this.transformFn = transformFn;
  }
  
  validate(value, fieldName) {
    return this.transformFn(value, fieldName);
  }
}

/**
 * Trim whitespace transform
 */
export class TrimRule extends TransformRule {
  constructor() {
    super((value) => {
      if (typeof value === 'string') {
        return value.trim();
      }
      return value;
    });
  }
}

/**
 * Lowercase transform
 */
export class LowercaseRule extends TransformRule {
  constructor() {
    super((value) => {
      if (typeof value === 'string') {
        return value.toLowerCase();
      }
      return value;
    });
  }
}