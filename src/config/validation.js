/**
 * Input Validation Module for Gravity MCP
 * Complete rewrite using composable validation architecture
 */

import { FieldAwareValidator } from './field-validation.js';
import { validate, ValidationSchema } from './validation-chain.js';
import { VALIDATION_CONFIG, getEnumValues } from './validation-config.js';
import {
  FormsValidator as NewFormsValidator,
  EntriesValidator as NewEntriesValidator,
  FeedsValidator as NewFeedsValidator,
  NotificationsValidator as NewNotificationsValidator,
  SubmissionsValidator as NewSubmissionsValidator,
} from './validators.js';

/**
 * Legacy compatibility exports - these map old static methods to new architecture
 */
export class BaseValidator {
  static validateRequired(data, requiredFields) {
    if (!data || typeof data !== 'object') {
      throw new Error('Input must be an object');
    }

    const missing = requiredFields.filter(field => {
      const value = data[field];
      return value === undefined || value === null;
    });

    if (missing.length > 0) {
      if (missing.length === 1) {
        throw new Error(`${missing[0]} is required`);
      } else {
        throw new Error(`Missing required fields: ${missing.join(', ')}`);
      }
    }
  }

  static validateId(id, fieldName = 'id') {
    const schema = new ValidationSchema();
    schema.field('value', validate('value')
      .required()
      .positiveInteger()
    );

    try {
      const result = schema.validate({ value: id });
      return result.value;
    } catch (error) {
      // Map to legacy error format
      if (error.errors && error.errors[0]) {
        const msg = error.errors[0].message
          .replace('value', fieldName);
        throw new Error(msg);
      }
      throw error;
    }
  }

  static validateIds(ids, fieldName = 'IDs') {
    if (!Array.isArray(ids)) {
      throw new Error(`${fieldName} must be an array`);
    }
    return ids.map((id, index) =>
      this.validateId(id, `${fieldName}[${index}]`)
    );
  }

  static validatePagination(params) {
    const validated = {};

    if (params.page !== undefined) {
      validated.page = this.validateId(params.page, 'page');
    }

    if (params.per_page !== undefined) {
      const perPage = this.validateId(params.per_page, 'per_page');
      if (perPage > 100) {
        throw new Error('per_page cannot exceed 100');
      }
      validated.per_page = perPage;
    }

    return validated;
  }

  static validateFieldFilter(filter) {
    if (!filter || typeof filter !== 'object') {
      throw new Error('Field filter must be an object');
    }

    const { key, value, operator } = filter;

    if (!key) {
      throw new Error('Field filter must have a key');
    }

    if (value === undefined) {
      throw new Error('Field filter must have a value');
    }

    if (operator && !getEnumValues('fieldOperators').includes(operator)) {
      throw new Error(`Invalid operator: ${operator}. Valid operators: ${getEnumValues('fieldOperators').join(', ')}`);
    }

    return {
      key: String(key),
      value: String(value),
      operator: operator || 'IS'
    };
  }

  static validateSearch(searchParams) {
    if (searchParams === undefined) {
      return null;
    }

    if (!searchParams || typeof searchParams !== 'object' || Array.isArray(searchParams)) {
      throw new Error('search must be an object');
    }

    const validated = {};

    if (searchParams.field_filters !== undefined) {
      validated.field_filters = this.validateArray(searchParams.field_filters, 'field_filters');
      if (validated.field_filters.length > 0) {
        validated.field_filters = validated.field_filters.map(filter =>
          this.validateFieldFilter(filter)
        );
      }
    }

    if (searchParams.mode !== undefined) {
      if (!getEnumValues('searchMode').includes(searchParams.mode)) {
        throw new Error(`mode must be one of: ${getEnumValues('searchMode').join(', ')}`);
      }
      validated.mode = searchParams.mode;
    }

    if (searchParams.start_date !== undefined) {
      validated.start_date = this.validateDate(searchParams.start_date, 'start_date');
    }

    if (searchParams.end_date !== undefined) {
      validated.end_date = this.validateDate(searchParams.end_date, 'end_date');
    }

    if (validated.mode && !validated.field_filters) {
      throw new Error(VALIDATION_CONFIG.errorMessages.custom.searchWithMode);
    }

    return validated;
  }

  static validateSorting(sortingParams) {
    if (!sortingParams || typeof sortingParams !== 'object') {
      return null;
    }

    const validated = {};

    if (sortingParams.key) {
      validated.key = String(sortingParams.key);
    }

    if (sortingParams.direction) {
      if (!getEnumValues('sortDirection').includes(sortingParams.direction)) {
        throw new Error(`Invalid sort direction: ${sortingParams.direction}. Valid directions: ${getEnumValues('sortDirection').join(', ')}`);
      }
      validated.direction = sortingParams.direction.toLowerCase();
    }

    return validated;
  }

  static validateStatus(status, validStatuses, fieldName = 'status') {
    if (status !== undefined && !validStatuses.includes(status)) {
      throw new Error(`Invalid ${fieldName}: ${status}. Valid values: ${validStatuses.join(', ')}`);
    }
    return status;
  }

  static validateDate(date, fieldName = 'date') {
    if (typeof date !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }
    if (!VALIDATION_CONFIG.dates.iso8601.pattern.test(date)) {
      throw new Error(`${fieldName} must be a valid ISO 8601 date`);
    }
    return date;
  }

  static validateBoolean(value, fieldName = 'boolean') {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
  }

  static sanitizeString(str, fieldName = 'string') {
    if (typeof str !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }
    const trimmed = str.trim();
    if (trimmed === '') {
      throw new Error(`${fieldName} cannot be empty`);
    }
    return trimmed;
  }

  static validateEmail(email, fieldName = 'email') {
    const schema = new ValidationSchema();
    schema.field('value', validate('value')
      .required()
      .string()
      .email()
    );

    try {
      const result = schema.validate({ value: email });
      return result.value;
    } catch (error) {
      throw new Error(`${fieldName} must be a valid email`);
    }
  }

  static validateURL(url, fieldName = 'url') {
    const schema = new ValidationSchema();
    schema.field('value', validate('value')
      .required()
      .string()
      .url()
    );

    try {
      const result = schema.validate({ value: url });
      return result.value;
    } catch (error) {
      throw new Error(`${fieldName} must be a valid URL`);
    }
  }

  static validateArray(value, fieldName = 'value') {
    if (value !== undefined && !Array.isArray(value)) {
      // MCP clients may serialize arrays as JSON strings — parse them
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch (_) { /* not valid JSON, fall through */ }
      }
      throw new Error(`${fieldName} must be an array`);
    }
    return value || [];
  }

  static validateObject(value, fieldName = 'value') {
    if (value !== undefined) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${fieldName} must be an object`);
      }
    }
    return value || {};
  }
}

/**
 * Forms-specific validation - legacy wrapper
 */
export class FormsValidator extends BaseValidator {
  static validateListFormsParams(params) {
    // Use the new FormsValidator from validators.js
    return NewFormsValidator.validateListFormsParams(params);
  }

  static validateFormData(formData, isUpdate = false) {
    // Handle the legacy validation manually for now
    if (!formData || typeof formData !== 'object') {
      throw new Error('Form data must be an object');
    }

    const validated = { ...formData };

    if (isUpdate) {
      // Use lowercase for validation tests
      BaseValidator.validateRequired(formData, ['id']);
      validated.id = BaseValidator.validateId(formData.id, 'id');
    } else {
      BaseValidator.validateRequired(formData, ['title']);
    }

    if (formData.title !== undefined) {
      if (typeof formData.title !== 'string') {
        throw new Error('title must be a string');
      }
      if (formData.title.trim() === '') {
        throw new Error('title cannot be empty');
      }
      if (formData.title.length > 255) {
        throw new Error('title is too long');
      }
      validated.title = formData.title.trim();
    }

    if (formData.description) {
      validated.description = this.sanitizeString(formData.description, 'description');
    }

    if (formData.fields) {
      if (!Array.isArray(formData.fields)) {
        throw new Error('Form fields must be an array');
      }
      validated.fields = FieldAwareValidator.validateFormFields(formData.fields);
    }

    if (formData.confirmations !== undefined) {
      validated.confirmations = this.validateObject(formData.confirmations, 'confirmations');
      Object.entries(validated.confirmations).forEach(([key, conf]) => {
        if (conf.type === 'redirect' && conf.url !== undefined) {
          conf.url = this.validateURL(conf.url, `confirmations.${key}.url`);
        }
      });
    }

    if (formData.notifications !== undefined) {
      validated.notifications = this.validateObject(formData.notifications, 'notifications');
    }

    if (formData.schedule_start !== undefined) {
      validated.schedule_start = this.validateDate(formData.schedule_start, 'schedule_start');
    }

    if (formData.schedule_end !== undefined) {
      validated.schedule_end = this.validateDate(formData.schedule_end, 'schedule_end');
    }

    return validated;
  }
}

/**
 * Entries-specific validation - legacy wrapper
 */
export class EntriesValidator extends BaseValidator {
  static validateListEntriesParams(params) {
    const validated = {};

    Object.assign(validated, this.validatePagination(params));

    if (params.form_ids !== undefined) {
      validated.form_ids = this.validateArray(params.form_ids, 'form_ids');
      if (validated.form_ids.length > 0) {
        validated.form_ids = this.validateIds(validated.form_ids, 'form_ids');
      }
    }

    if (params.include !== undefined) {
      validated.include = this.validateArray(params.include, 'include');
      if (validated.include.length > 0) {
        validated.include = this.validateIds(validated.include, 'include');
      }
    }

    if (params.exclude !== undefined) {
      validated.exclude = this.validateArray(params.exclude, 'exclude');
      if (validated.exclude.length > 0) {
        validated.exclude = this.validateIds(validated.exclude, 'exclude');
      }
    }

    if (params.status) {
      validated.status = this.validateStatus(params.status, getEnumValues('entryStatus'));
    }

    if (params.search) {
      validated.search = this.validateSearch(params.search);
    }

    if (params.sorting) {
      validated.sorting = this.validateSorting(params.sorting);
    }

    if (params.paging !== undefined) {
      validated.paging = this.validateObject(params.paging, 'paging');

      const paging = {};
      if (params.paging.page_size !== undefined) {
        const pageSize = Number(params.paging.page_size);
        if (isNaN(pageSize) || pageSize < 1) {
          throw new Error('page_size must be at least 1');
        }
        if (pageSize > 200) {
          throw new Error('page_size cannot exceed 200');
        }
        paging.page_size = pageSize;
      }

      if (params.paging.current_page) {
        paging.current_page = this.validateId(params.paging.current_page, 'current_page');
      }

      validated.paging = paging;
    }

    return validated;
  }

  static validateEntryData(entryData, isUpdate = false) {
    if (!entryData || typeof entryData !== 'object') {
      throw new Error('Entry data must be an object');
    }

    const validated = { ...entryData };

    if (!isUpdate) {
      BaseValidator.validateRequired(entryData, ['form_id']);
      validated.form_id = this.validateId(entryData.form_id, 'form_id');
    } else {
      BaseValidator.validateRequired(entryData, ['id']);
      validated.id = this.validateId(entryData.id, 'id');
      if (entryData.form_id !== undefined) {
        validated.form_id = this.validateId(entryData.form_id, 'form_id');
      }
    }

    if (entryData.created_by) {
      validated.created_by = this.validateId(entryData.created_by, 'created_by');
    }

    if (entryData.status) {
      validated.status = this.validateStatus(entryData.status, getEnumValues('entryStatus'));
    }

    if (entryData.date_created) {
      validated.date_created = this.validateDate(entryData.date_created, 'date_created');
    }

    return validated;
  }
}

/**
 * Export other validators
 */
export { NewSubmissionsValidator as SubmissionsValidator, NewFeedsValidator as FeedsValidator, NewNotificationsValidator as NotificationsValidator };

/**
 * Main validation factory
 */
export class ValidationFactory {
  static getValidator(context) {
    switch (context) {
      case 'forms':
        return FormsValidator;
      case 'entries':
        return EntriesValidator;
      case 'submissions':
        return NewSubmissionsValidator;
      case 'feeds':
        return NewFeedsValidator;
      case 'notifications':
        return NewNotificationsValidator;
      default:
        return BaseValidator;
    }
  }

  static validateToolInput(toolName, input) {
    try {
      switch (toolName) {
        case 'gf_list_forms':
          // Special handling for forms - it has limited parameters
          const validated = {};
          if (input.include !== undefined) {
            validated.include = BaseValidator.validateArray(input.include, 'include');
            if (validated.include.length > 0) {
              validated.include = BaseValidator.validateIds(validated.include, 'include');
            }
          }
          if (input.active !== undefined) {
            validated.active = BaseValidator.validateBoolean(input.active, 'active');
          }
          if (input.exclude !== undefined) {
            validated.exclude = BaseValidator.validateArray(input.exclude, 'exclude');
            if (validated.exclude.length > 0) {
              validated.exclude = BaseValidator.validateIds(validated.exclude, 'exclude');
            }
          }
          if (input.status !== undefined) {
            const validStatuses = ['active', 'inactive', 'trash'];
            if (!validStatuses.includes(input.status)) {
              throw new Error(`status must be one of: ${validStatuses.join(', ')}`);
            }
            validated.status = input.status;
          }
          return validated;

        case 'gf_create_form':
          return FormsValidator.validateFormData(input, false);
        case 'gf_update_form':
          return FormsValidator.validateFormData(input, true);
        case 'gf_get_form':
        case 'gf_delete_form':
          BaseValidator.validateRequired(input, ['id']);
          const result = {
            id: BaseValidator.validateId(input.id, 'id')
          };
          if (toolName === 'gf_delete_form' && input.force !== undefined) {
            result.force = BaseValidator.validateBoolean(input.force, 'force');
          }
          return result;

        case 'gf_validate_form':
        case 'gf_submit_form_data':
        case 'gf_validate_submission':
          if (!input || typeof input !== 'object') {
            throw new Error('Submission data must be an object');
          }
          const subValidated = { ...input };
          if (!input.form_id) {
            throw new Error('form_id is required for form submission');
          }
          subValidated.form_id = BaseValidator.validateId(input.form_id, 'form_id');
          Object.keys(input).forEach(key => {
            if (key.startsWith('input_')) {
              subValidated[key] = String(input[key]);
            }
          });
          if (input.field_values && typeof input.field_values !== 'object') {
            throw new Error('field_values must be an object');
          }
          return subValidated;

        case 'gf_list_entries':
          return EntriesValidator.validateListEntriesParams(input);
        case 'gf_create_entry':
          return EntriesValidator.validateEntryData(input, false);
        case 'gf_update_entry':
          return EntriesValidator.validateEntryData(input, true);
        case 'gf_get_entry':
        case 'gf_delete_entry':
          BaseValidator.validateRequired(input, ['id']);
          const entryResult = {
            id: BaseValidator.validateId(input.id, 'id')
          };
          if (toolName === 'gf_delete_entry' && input.force !== undefined) {
            entryResult.force = BaseValidator.validateBoolean(input.force, 'force');
          }
          return entryResult;

        case 'gf_list_feeds':
          const feedsValidated = {};
          if (input.addon) {
            if (!/^[a-z0-9_-]+$/i.test(input.addon)) {
              throw new Error('addon filter must be a valid slug format');
            }
            feedsValidated.addon = input.addon.toLowerCase();
          }
          if (input.form_id) {
            feedsValidated.form_id = BaseValidator.validateId(input.form_id, 'form_id');
          }
          return feedsValidated;

        case 'gf_create_feed':
          // For create, we need to handle the validation carefully
          if (!input || typeof input !== 'object') {
            throw new Error('Feed data must be an object');
          }
          // Check required fields manually for legacy compatibility
          if (!input.addon_slug) {
            throw new Error('addon_slug is required');
          }
          if (!input.form_id) {
            throw new Error('form_id is required');
          }
          if (!input.meta) {
            throw new Error('meta is required');
          }
          // Check meta is an object
          if (typeof input.meta !== 'object' || Array.isArray(input.meta)) {
            throw new Error('meta must be an object');
          }
          // Now use the new validator for detailed validation
          return NewFeedsValidator.validateFeedData(input, true);

        case 'gf_update_feed':
        case 'gf_patch_feed':
          return NewFeedsValidator.validateFeedData(input, false);

        case 'gf_get_feed':
        case 'gf_delete_feed':
          BaseValidator.validateRequired(input, ['id']);
          return {
            id: BaseValidator.validateId(input.id, 'id')
          };

        case 'gf_list_form_feeds':
          if (!input.form_id) {
            throw new Error('form_id is required for listing form feeds');
          }
          return {
            form_id: BaseValidator.validateId(input.form_id, 'form_id')
          };

        case 'gf_send_notifications':
          // Check required field for legacy compatibility
          if (!input || !input.entry_id) {
            throw new Error('entry_id is required');
          }
          return NewNotificationsValidator.validateSendNotificationsParams(input);

        case 'gf_get_field_filters':
        case 'gf_get_results':
          BaseValidator.validateRequired(input, ['form_id']);
          return {
            form_id: BaseValidator.validateId(input.form_id, 'form_id')
          };

        default:
          if (input.id !== undefined) {
            input.id = BaseValidator.validateId(input.id);
          }
          return input;
      }
    } catch (error) {
      // Check if it's a ValidationError with detailed errors
      if (error.name === 'ValidationError' && error.errors && error.errors.length > 0) {
        // Throw the first error message directly for backward compatibility
        throw new Error(error.errors[0].message);
      }
      throw new Error(`Validation error for ${toolName}: ${error.message}`);
    }
  }
}

// Export individual validation functions for compatibility
export const validateListFormsParams = (params) => {
  try {
    return ValidationFactory.validateToolInput('gf_list_forms', params || {});
  } catch (error) {
    throw error;
  }
};

export const validateFormData = (data, isUpdate = false) => {
  try {
    return FormsValidator.validateFormData(data || {}, isUpdate);
  } catch (error) {
    throw error;
  }
};

export const validateListEntriesParams = (params) => {
  try {
    return EntriesValidator.validateListEntriesParams(params || {});
  } catch (error) {
    throw error;
  }
};

export const validateEntryData = (data, isUpdate = false) => {
  try {
    return EntriesValidator.validateEntryData(data || {}, isUpdate);
  } catch (error) {
    throw error;
  }
};

export const validateFeedData = (data, isCreate = true) => {
  try {
    return NewFeedsValidator.validateFeedData(data || {}, isCreate);
  } catch (error) {
    throw error;
  }
};

export const validateSubmissionData = (data) => {
  try {
    return ValidationFactory.validateToolInput('gf_submit_form_data', data || {});
  } catch (error) {
    throw error;
  }
};

export const validateSendNotificationsParams = (params) => {
  try {
    return NewNotificationsValidator.validateSendNotificationsParams(params || {});
  } catch (error) {
    throw error;
  }
};

export const validateListFeedsParams = (params) => {
  try {
    return ValidationFactory.validateToolInput('gf_list_feeds', params || {});
  } catch (error) {
    throw error;
  }
};

// Constants for backward compatibility
export const PATTERNS = VALIDATION_CONFIG.fields;
export const FIELD_OPERATORS = getEnumValues('fieldOperators');
export const ENTRY_STATUSES = getEnumValues('entryStatus');
export const FORM_STATUSES = getEnumValues('formStatus');
export const SEARCH_MODES = getEnumValues('searchMode');
export const SORT_DIRECTIONS = getEnumValues('sortDirection');

export default ValidationFactory;