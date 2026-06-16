/**
 * Domain-Specific Validators
 * Validators for different domains using the composable validation system
 */

import { validate, ValidationSchema } from './validation-chain.js';
import { VALIDATION_CONFIG, getEnumValues, getPaginationLimits } from './validation-config.js';

/**
 * Forms Validator
 */
export class FormsValidator {
  /**
   * Get validation schema for list forms parameters
   */
  static getListFormsSchema() {
    const schema = new ValidationSchema();
    
    schema
      .field('include', validate('include')
        .array()
        .custom((value) => {
          if (Array.isArray(value)) {
            value.forEach((id, index) => {
              validate(`include[${index}]`)
                .required()
                .positiveInteger()
                .validate(id);
            });
          }
          return true;
        })
      )
      .field('status', validate('status')
        .enum(getEnumValues('formStatus'))
      )
      .field('active', validate('active')
        .boolean()
      )
      .field('exclude', validate('exclude')
        .array()
        .custom((value) => {
          if (Array.isArray(value)) {
            value.forEach((id, index) => {
              validate(`exclude[${index}]`)
                .required()
                .positiveInteger()
                .validate(id);
            });
          }
          return true;
        })
      );
    
    return schema;
  }
  
  /**
   * Get validation schema for form data
   */
  static getFormDataSchema(isUpdate = false) {
    const schema = new ValidationSchema();
    
    if (isUpdate) {
      schema.field('id', validate('id')
        .required()
        .positiveInteger()
      );
    }
    
    schema
      .field('title', validate('title')
        [isUpdate ? 'string' : 'required']()
        .string()
        .trim()
        .minLength(1)
        .maxLength(255)
      )
      .field('description', validate('description')
        .string()
        .trim()
        .maxLength(2000)
      )
      .field('is_active', validate('is_active')
        .boolean()
      )
      .field('fields', validate('fields')
        .array()
      )
      .field('confirmations', validate('confirmations')
        .object()
        .custom((confirmations) => {
          if (confirmations && typeof confirmations === 'object') {
            Object.entries(confirmations).forEach(([key, conf]) => {
              if (conf.type === 'redirect' && conf.url !== undefined) {
                validate(`confirmations.${key}.url`)
                  .required()
                  .string()
                  .url()
                  .validate(conf.url);
              }
            });
          }
          return true;
        })
      )
      .field('notifications', validate('notifications')
        .object()
      )
      .field('schedule_start', validate('schedule_start')
        .string()
        .date()
      )
      .field('schedule_end', validate('schedule_end')
        .string()
        .date()
      );
    
    return schema;
  }
  
  /**
   * Validate list forms parameters
   */
  static validateListFormsParams(params = {}) {
    return this.getListFormsSchema().validate(params);
  }
  
  /**
   * Validate form data
   */
  static validateFormData(data, isUpdate = false) {
    return this.getFormDataSchema(isUpdate).validate(data);
  }
}

/**
 * Entries Validator
 */
export class EntriesValidator {
  /**
   * Get validation schema for list entries parameters
   */
  static getListEntriesSchema() {
    const limits = getPaginationLimits('entries');
    const schema = new ValidationSchema();
    
    schema
      .field('form_ids', validate('form_ids')
        .array()
        .custom((value) => {
          if (Array.isArray(value)) {
            value.forEach((id, index) => {
              validate(`form_ids[${index}]`)
                .required()
                .positiveInteger()
                .validate(id);
            });
          }
          return true;
        })
      )
      .field('include', validate('include')
        .array()
      )
      .field('exclude', validate('exclude')
        .array()
      )
      .field('status', validate('status')
        .enum(getEnumValues('entryStatus'))
      )
      .field('search', validate('search')
        .object()
        .custom((search) => {
          if (search && typeof search === 'object') {
            // Validate field_filters
            if (search.field_filters !== undefined) {
              validate('search.field_filters')
                .array()
                .validate(search.field_filters);
              
              if (Array.isArray(search.field_filters)) {
                search.field_filters.forEach((filter, index) => {
                  if (!filter.key || filter.value === undefined) {
                    throw new Error('Field filter must have key and value');
                  }
                  if (filter.operator) {
                    validate(`search.field_filters[${index}].operator`)
                      .enum(getEnumValues('fieldOperators'))
                      .validate(filter.operator);
                  }
                });
              }
            }
            
            // Validate mode
            if (search.mode !== undefined) {
              validate('search.mode')
                .enum(getEnumValues('searchMode'))
                .validate(search.mode);
            }
            
            // Validate dates
            if (search.start_date !== undefined) {
              validate('search.start_date')
                .string()
                .date()
                .validate(search.start_date);
            }
            
            if (search.end_date !== undefined) {
              validate('search.end_date')
                .string()
                .date()
                .validate(search.end_date);
            }
            
            // Complex validation: mode requires field_filters
            if (search.mode && !search.field_filters) {
              throw new Error(VALIDATION_CONFIG.errorMessages.custom.searchWithMode);
            }
          }
          return true;
        })
      )
      .field('sorting', validate('sorting')
        .object()
        .custom((sorting) => {
          if (sorting && typeof sorting === 'object') {
            if (sorting.direction) {
              validate('sorting.direction')
                .enum(getEnumValues('sortDirection'))
                .validate(sorting.direction);
            }
          }
          return true;
        })
      )
      .field('paging', validate('paging')
        .object()
        .custom((paging) => {
          if (paging && typeof paging === 'object') {
            if (paging.page_size !== undefined) {
              validate('paging.page_size')
                .required()
                .number()
                .min(1)
                .max(limits.maxPerPage)
                .validate(paging.page_size);
            }
            if (paging.current_page !== undefined) {
              validate('paging.current_page')
                .required()
                .positiveInteger()
                .validate(paging.current_page);
            }
          }
          return true;
        })
      );
    
    return schema;
  }
  
  /**
   * Get validation schema for entry data
   */
  static getEntryDataSchema(isUpdate = false) {
    const schema = new ValidationSchema();
    
    if (isUpdate) {
      schema.field('id', validate('id')
        .required()
        .positiveInteger()
      );
    } else {
      schema.field('form_id', validate('form_id')
        .required()
        .positiveInteger()
      );
    }
    
    schema
      .field('status', validate('status')
        .enum(getEnumValues('entryStatus'))
      )
      .field('created_by', validate('created_by')
        .positiveInteger()
      )
      .field('date_created', validate('date_created')
        .string()
        .date()
      );
    
    return schema;
  }
  
  /**
   * Validate list entries parameters
   */
  static validateListEntriesParams(params = {}) {
    return this.getListEntriesSchema().validate(params);
  }
  
  /**
   * Validate entry data
   */
  static validateEntryData(data, isUpdate = false) {
    return this.getEntryDataSchema(isUpdate).validate(data);
  }
}

/**
 * Feeds Validator
 */
export class FeedsValidator {
  /**
   * Get validation schema for feed data
   */
  static getFeedDataSchema(isCreate = true) {
    const schema = new ValidationSchema();
    
    if (isCreate) {
      schema
        .field('addon_slug', validate('addon_slug')
          .required()
          .string()
          .lowercase()
          .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'addon_slug must be a valid slug format')
        )
        .field('form_id', validate('form_id')
          .required()
          .positiveInteger()
        )
        .field('meta', validate('meta')
          .required()
          .object()
          .custom((meta) => {
            if (meta && meta.conditionalLogic && meta.conditionalLogic.enabled === true) {
              if (!meta.conditionalLogic.rules) {
                throw new Error('conditionalLogic with enabled=true requires rules');
              }
            }
            return true;
          })
        );
    } else {
      schema
        .field('id', validate('id')
          .required()
          .positiveInteger()
        )
        .field('meta', validate('meta')
          .object()
          .custom((meta) => {
            if (meta && meta.conditionalLogic && meta.conditionalLogic.enabled === true) {
              if (!meta.conditionalLogic.rules) {
                throw new Error('conditionalLogic with enabled=true requires rules');
              }
            }
            return true;
          })
        )
        .field('is_active', validate('is_active')
          .boolean()
        );
    }
    
    return schema;
  }
  
  /**
   * Validate feed data
   */
  static validateFeedData(data, isCreate = true) {
    return this.getFeedDataSchema(isCreate).validate(data);
  }
}

/**
 * Notifications Validator
 */
export class NotificationsValidator {
  /**
   * Get validation schema for send notifications parameters
   */
  static getSendNotificationsSchema() {
    const schema = new ValidationSchema();
    
    schema
      .field('entry_id', validate('entry_id')
        .required()
        .positiveInteger()
      )
      .field('notification_ids', validate('notification_ids')
        .array()
      )
      .field('event', validate('event')
        .string()
      )
      .field('to', validate('to')
        .email()
      )
      .field('from', validate('from')
        .email()
      )
      .field('reply_to', validate('reply_to')
        .email()
      );
    
    return schema;
  }
  
  /**
   * Validate send notifications parameters
   */
  static validateSendNotificationsParams(params = {}) {
    return this.getSendNotificationsSchema().validate(params);
  }
}

/**
 * Submissions Validator
 */
export class SubmissionsValidator {
  /**
   * Get validation schema for submission data
   */
  static getSubmissionDataSchema() {
    const schema = new ValidationSchema();
    
    schema
      .field('form_id', validate('form_id')
        .required()
        .positiveInteger()
      );
    
    return schema;
  }
  
  /**
   * Validate submission data
   */
  static validateSubmissionData(data) {
    return this.getSubmissionDataSchema().validate(data);
  }
}

/**
 * Generic validators
 */
export class GenericValidators {
  /**
   * Validate a single ID
   */
  static validateId(params) {
    const schema = new ValidationSchema();
    schema.field('id', validate('id')
      .required()
      .positiveInteger()
    );
    return schema.validate(params);
  }
  
  /**
   * Validate ID with optional force parameter
   */
  static validateIdWithForce(params) {
    const schema = new ValidationSchema();
    schema
      .field('id', validate('id')
        .required()
        .positiveInteger()
      )
      .field('force', validate('force')
        .boolean()
      );
    return schema.validate(params);
  }
}