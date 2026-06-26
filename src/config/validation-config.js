/**
 * Validation Configuration
 * Centralized configuration for all validation rules and limits
 */

export const VALIDATION_CONFIG = {
  // Field constraints
  fields: {
    title: {
      minLength: 1,
      maxLength: 255,
      required: true
    },
    description: {
      maxLength: 2000,
      required: false
    },
    email: {
      pattern: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
      maxLength: 254 // RFC 5321
    },
    url: {
      pattern: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}(\.[a-zA-Z0-9()]{1,6})?\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
      maxLength: 2083 // IE limit
    },
    slug: {
      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      maxLength: 200
    }
  },
  
  // Pagination limits
  pagination: {
    forms: {
      maxPerPage: 100,
      defaultPerPage: 20
    },
    entries: {
      maxPerPage: 200,
      defaultPerPage: 50,
      maxPage: 1000
    },
    feeds: {
      maxPerPage: 100,
      defaultPerPage: 20
    }
  },
  
  // Date formats
  dates: {
    iso8601: {
      pattern: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2}))?$/,
      description: 'ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ)'
    }
  },
  
  // Enum values
  enums: {
    formStatus: ['active', 'inactive', 'trash'],
    entryStatus: ['active', 'spam', 'trash'],
    searchMode: ['any', 'all'],
    sortDirection: ['asc', 'desc', 'ASC', 'DESC'],
    fieldOperators: [
      '=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 
      'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<='
    ],
    confirmationType: ['message', 'page', 'redirect']
  },
  
  // Error messages
  errorMessages: {
    required: '{field} is required',
    type: {
      string: '{field} must be a string',
      number: '{field} must be a number',
      boolean: '{field} must be a boolean',
      array: '{field} must be an array',
      object: '{field} must be an object'
    },
    range: {
      min: '{field} must be at least {min}',
      max: '{field} cannot exceed {max}',
      minLength: '{field} must be at least {min} characters',
      maxLength: '{field} cannot exceed {max} characters',
      empty: '{field} cannot be empty'
    },
    format: {
      email: '{field} must be a valid email',
      url: '{field} must be a valid URL',
      date: '{field} must be a valid {format} date',
      slug: '{field} must be a valid slug (lowercase letters, numbers, and hyphens)',
      id: '{field} must be a positive integer'
    },
    enum: '{field} must be one of: {values}',
    custom: {
      conditionalLogic: 'conditionalLogic with enabled=true requires rules',
      searchWithMode: 'search with mode requires field_filters',
      fieldFilter: 'Field filter must have key, value, and operator'
    }
  }
};

/**
 * Get error message with field name and parameters
 */
export function formatErrorMessage(template, field, params = {}) {
  // split/join replaces EVERY placeholder and treats the value literally.
  // String.replace(str, str) only swaps the first match and interprets `$&`/`$1`
  // sequences in the replacement string.
  let message = template.split('{field}').join(field);

  Object.keys(params).forEach(key => {
    message = message.split(`{${key}}`).join(String(params[key]));
  });

  return message;
}

/**
 * Get validation config for a specific field type
 */
export function getFieldConfig(fieldType) {
  return VALIDATION_CONFIG.fields[fieldType] || {};
}

/**
 * Get enum values for a specific enum type
 */
export function getEnumValues(enumType) {
  return VALIDATION_CONFIG.enums[enumType] || [];
}

/**
 * Get pagination limits for a specific resource
 */
export function getPaginationLimits(resource) {
  return VALIDATION_CONFIG.pagination[resource] || {
    maxPerPage: 100,
    defaultPerPage: 20
  };
}