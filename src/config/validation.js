/**
 * Input Validation Module for Gravity MCP
 * Complete rewrite using composable validation architecture
 */

import { FieldAwareValidator } from './field-validation.js';
import { validate, ValidationSchema } from './validation-chain.js';
import { VALIDATION_CONFIG, getEnumValues } from './validation-config.js';
import {
  FormsValidator as ChainFormsValidator,
  FeedsValidator as ChainFeedsValidator,
  NotificationsValidator as ChainNotificationsValidator,
  SubmissionsValidator as ChainSubmissionsValidator,
} from './validators.js';

/**
 * Base validation utilities. FormsValidator and EntriesValidator below extend this
 * with domain-specific logic. Feeds, Notifications, and Submissions use the chain-based
 * validators from validators.js (imported as Chain* above).
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

  /**
   * Resolves an id given under either of two accepted names.
   *
   * @param {object} input     The tool input.
   * @param {string} preferred The name this tool documents; the other is accepted too.
   * @param {string} other     The accepted alias.
   * @returns {number} The validated id.
   * @throws When neither is present, either is not a positive integer, or both
   *   are present and resolve to different ids.
   */
  static resolveIdAlias(input, preferred, other) {
    const isGiven = name => input[name] !== undefined && input[name] !== null && input[name] !== '';
    const hasPreferred = isGiven(preferred);
    const hasOther = isGiven(other);

    if (!hasPreferred && !hasOther) {
      throw new Error(`${preferred} is required`);
    }

    const preferredId = hasPreferred ? BaseValidator.validateId(input[preferred], preferred) : null;
    const otherId = hasOther ? BaseValidator.validateId(input[other], other) : null;

    if (hasPreferred && hasOther && preferredId !== otherId) {
      throw new Error(`${preferred} and ${other} were both given and disagree (${input[preferred]} vs ${input[other]}); pass one`);
    }

    return hasPreferred ? preferredId : otherId;
  }

  /**
   * Resolves a form id given under either `id` or `form_id`. The form tools are
   * split between the two spellings, so both are accepted everywhere.
   *
   * @param {object} input     The tool input.
   * @param {string} preferred The name this tool documents.
   * @returns {number} The validated id.
   */
  static resolveFormId(input, preferred = 'form_id') {
    return BaseValidator.resolveIdAlias(input, preferred, preferred === 'form_id' ? 'id' : 'form_id');
  }

  /**
   * Resolves an entry id given under either `id` or `entry_id`. The entry tools
   * document `id` while gf_send_notifications names the same entry `entry_id`, so
   * both are accepted.
   *
   * @param {object} input     The tool input.
   * @param {string} preferred The name this tool documents.
   * @returns {number} The validated id.
   */
  static resolveEntryId(input, preferred = 'id') {
    return BaseValidator.resolveIdAlias(input, preferred, preferred === 'id' ? 'entry_id' : 'id');
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

    // Reject null the same as a missing value — otherwise String(null) puts the
    // literal text "null" on the wire, matching entries whose value is the word
    // "null".
    if (value === undefined || value === null) {
      throw new Error('Field filter must have a value');
    }

    // Reject non-array objects: String({}) becomes "[object Object]", a silent
    // garbage filter value. Arrays stay valid for the multi-value operators
    // handled below; a plain object never is.
    if (typeof value === 'object' && !Array.isArray(value)) {
      throw new Error('Field filter value must be a string, number, boolean, or array');
    }

    // GF normalizes operators case-insensitively (IN/in/In all match), so accept
    // any case rather than rejecting valid GF operators.
    const validOperators = getEnumValues('fieldOperators');
    if (operator && !validOperators.some((o) => o.toLowerCase() === String(operator).toLowerCase())) {
      throw new Error(`Invalid operator: ${operator}. Valid operators: ${validOperators.join(', ')}`);
    }

    const resolvedOperator = operator || 'IS';
    // GF membership operators (in / not in / notin) match against an ARRAY;
    // String()-flattening to "1,2,3" makes GF match the literal joined string,
    // and the NOTIN alias hitting String() drives GF's in_array(null) 500.
    // Keep the array for these; scalars stay strings.
    const multiValueAliases = ['in', 'not in', 'notin'];
    const isMultiValue = multiValueAliases.includes(String(resolvedOperator).toLowerCase());
    return {
      key: String(key),
      value: isMultiValue && Array.isArray(value) ? value.map(String) : String(value),
      operator: resolvedOperator
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

    // GF forces numeric ordering whenever sorting.is_numeric is present and
    // truthy, and never intvals it — so a JSON string like "false" or "0" (both
    // truthy in JS) would wrongly force numeric ordering. Interpret it strictly
    // and carry it only when it genuinely means true; omit otherwise (GF then
    // uses its default lexical ordering for the field).
    const rawIsNumeric = sortingParams.is_numeric;
    const isNumericTrue =
      rawIsNumeric === true ||
      rawIsNumeric === 1 ||
      (typeof rawIsNumeric === 'string' && ['true', '1'].includes(rawIsNumeric.trim().toLowerCase()));
    if (isNumericTrue) {
      validated.is_numeric = true;
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
    return ChainFormsValidator.validateListFormsParams(params);
  }

  static validateFormData(formData, isUpdate = false) {
    // Handle the legacy validation manually for now
    if (!formData || typeof formData !== 'object') {
      throw new Error('Form data must be an object');
    }

    const validated = { ...formData };

    if (isUpdate) {
      validated.id = BaseValidator.resolveFormId(formData, 'id');
      delete validated.form_id;
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

    // NOTE: GF's /entries endpoint paginates ONLY via the `paging` object
    // (paging[page_size], paging[offset], paging[current_page]) — it has no
    // top-level page/per_page params (class-gf-rest-controller.php parse_entry_search_params).
    // Emitting page/per_page here leaked them to the wire as no-op params, so
    // they are intentionally NOT merged in. Entry paging is the `paging` block below.

    // GF reads the form filter on /entries as an ARRAY (form_ids[0]=…) and has no
    // singular form_id there, so one that reaches the wire is ignored and the
    // response is every entry on the site. Every other gf_* tool spells the form
    // as form_id, so accept it here as a one-element form_ids. An empty array
    // says nothing, so it does not contradict a singular alongside it.
    const formIdsArrayGiven = params.form_ids !== undefined;
    const formIdGiven = params.form_id !== undefined && params.form_id !== null && params.form_id !== '';

    if (formIdsArrayGiven) {
      validated.form_ids = this.validateArray(params.form_ids, 'form_ids');
      if (validated.form_ids.length > 0) {
        validated.form_ids = this.validateIds(validated.form_ids, 'form_ids');
      }
    }

    if (formIdGiven) {
      // Both values are validated before they are compared, so a bad id is
      // reported as a bad id rather than as a disagreement.
      const formId = this.validateId(params.form_id, 'form_id');
      const plural = validated.form_ids || [];
      const pluralNamesForms = plural.length > 0;
      const namesTheSameForm = plural.length === 1 && plural[0] === formId;

      if (pluralNamesForms && !namesTheSameForm) {
        throw new Error(`form_id and form_ids were both given and disagree (${formId} vs [${plural.join(', ')}]); pass one`);
      }

      validated.form_ids = [formId];
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

      // current_page must be a positive integer. Use `!== undefined` (not the
      // falsy `if (current_page)`) so current_page:0 reaches validateId and is
      // rejected consistently with -1 instead of being silently dropped.
      if (params.paging.current_page !== undefined) {
        paging.current_page = this.validateId(params.paging.current_page, 'current_page');
      }

      // GF reads paging.offset when current_page is absent. Keep it through when
      // provided; it must be a non-negative integer (offset:0 is valid).
      // validateId rejects 0/negatives, so validate offset explicitly here:
      // 0 allowed, negatives and non-integers rejected.
      if (params.paging.offset !== undefined) {
        const offset = params.paging.offset;
        const isNonNegInt =
          (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) ||
          (typeof offset === 'string' && /^\d+$/.test(offset));
        if (!isNonNegInt) {
          throw new Error('offset must be a non-negative integer');
        }
        paging.offset = Number(offset);
      }

      validated.paging = paging;
    }

    return validated;
  }

  /**
   * Entry properties GF writes that are not form fields. A key in this list is
   * never checked against the form.
   */
  static ENTRY_PROPERTY_KEYS = new Set([
    'id', 'form_id', 'status', 'created_by', 'date_created', 'date_updated',
    'is_starred', 'is_read', 'ip', 'source_url', 'user_agent', 'currency',
    'payment_status', 'payment_date', 'payment_amount', 'payment_method',
    'transaction_id', 'transaction_type', 'is_fulfilled', 'post_id'
  ]);

  /**
   * A field id ("6") or a sub-input id ("6.3", or "6_3" as submissions spell it).
   */
  static isFieldKey(key) {
    return /^\d+(?:[._]\d+)?$/.test(key);
  }

  /**
   * Puts sub-input keys in the dotted spelling GF stores them under.
   *
   * gf_submit_form_data treats `input_5.3` and `input_5_3` as one input and refuses
   * two values for it; entries follow the same rule. GF reads `6.3` from an entry
   * body and ignores `6_3`, so the underscored spelling is rewritten rather than
   * passed through to be dropped.
   *
   * @param {object} data Entry data.
   * @returns {object} A copy with dotted sub-input keys.
   * @throws When one sub-input is given under both spellings with different values.
   */
  static normalizeFieldKeys(data) {
    const out = { ...data };

    Object.keys(data).forEach(key => {
      if (!/^\d+_\d+$/.test(key)) {
        return;
      }
      const dotted = key.replace('_', '.');
      delete out[key];

      const hasBothSpellings = Object.prototype.hasOwnProperty.call(data, dotted);
      if (hasBothSpellings) {
        const spellingsDisagree = JSON.stringify(data[dotted]) !== JSON.stringify(data[key]);
        if (spellingsDisagree) {
          throw new Error(`${key} and ${dotted} name the same input and disagree; pass one`);
        }
        return;
      }
      out[dotted] = data[key];
    });

    return out;
  }

  /**
   * Refuses a write that cannot store what it carries, before any HTTP call.
   *
   * GF reads field values from top-level keys and ignores the rest. A plain object
   * under a non-field key is the nested `entry: { "1": "Ada" }` guess; accepted, it
   * stored nothing and reported success. On create, a payload with no field key at
   * all stores nothing either.
   *
   * @param {object} data      Entry data, sub-input keys already normalized.
   * @param {boolean} isUpdate Whether this is gf_update_entry.
   * @throws When the payload cannot store a value.
   */
  static assertStorableShape(data, isUpdate) {
    const idKey = isUpdate ? 'id' : 'form_id';
    const idExample = `${idKey}: ${data[idKey]}`;

    Object.keys(data).forEach(key => {
      const value = data[key];
      const isNamedProperty = this.isFieldKey(key) || this.ENTRY_PROPERTY_KEYS.has(key);
      const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);

      if (!isNamedProperty && isPlainObject) {
        throw new Error(`"${key}" holds an object, and Gravity Forms reads field values only from top-level keys beside ${idKey}: pass { ${idExample}, "1": "Ada", "2": "ada@example.com" }, not values nested under "${key}"`);
      }
    });

    const hasFieldKey = Object.keys(data).some(key => this.isFieldKey(key));
    if (!isUpdate && !hasFieldKey) {
      throw new Error('no field values were given: pass them as top-level field-id keys (e.g. "1": "Ada", "2": "ada@example.com", "6.3": "..."), one per field id or sub-input, not nested under "entry"');
    }
  }

  /**
   * Refuses field keys that name no field (or no input) on the form.
   *
   * GF drops such a key and still answers with the request body, so the value
   * looks stored. A sub-input is checked against the field's listed inputs; a
   * field that lists none (some post fields) accepts any sub-input, since refusing
   * would block a legitimate write.
   *
   * @param {object} data   Entry data, sub-input keys already normalized.
   * @param {Array} fields  The form's `fields`.
   * @param {number} formId The form id, for the message.
   * @throws When a key resolves to nothing.
   */
  static assertKeysResolve(data, fields, formId) {
    const problems = [];

    Object.keys(data).filter(key => this.isFieldKey(key)).forEach(key => {
      const [fieldPart, inputPart] = key.split('.');
      const field = fields.find(candidate => Number(candidate?.id) === Number(fieldPart));

      if (!field) {
        const ids = fields.map(candidate => candidate?.id).filter(id => id !== undefined);
        const shown = ids.length > 40 ? `${ids.slice(0, 40).join(', ')}, …` : ids.join(', ');
        problems.push(`field ${fieldPart} does not exist on form ${formId} (its fields: ${shown || 'none'})`);
        return;
      }

      const listsInputs = Array.isArray(field.inputs) && field.inputs.length > 0;
      if (inputPart !== undefined && listsInputs) {
        const inputIds = field.inputs.map(input => String(input.id));
        if (!inputIds.includes(key)) {
          problems.push(`input ${key} does not exist on field ${fieldPart} of form ${formId} (its inputs: ${inputIds.join(', ')})`);
        }
      }
    });

    if (problems.length > 0) {
      throw new Error(`${problems.join('; ')}. Gravity Forms ignores a key like this, so nothing would be stored for it`);
    }
  }

  static validateEntryData(entryData, isUpdate = false) {
    if (!entryData || typeof entryData !== 'object') {
      throw new Error('Entry data must be an object');
    }

    const validated = this.normalizeFieldKeys(entryData);

    if (!isUpdate) {
      BaseValidator.validateRequired(entryData, ['form_id']);
      validated.form_id = this.validateId(entryData.form_id, 'form_id');
    } else {
      validated.id = BaseValidator.resolveEntryId(entryData, 'id');
      // The client spreads everything but `id` into the PUT body, so an alias left
      // here would be saved onto the entry as a field of its own.
      delete validated.entry_id;
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

    this.assertStorableShape(validated, isUpdate);

    return validated;
  }
}

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
        return ChainSubmissionsValidator;
      case 'feeds':
        return ChainFeedsValidator;
      case 'notifications':
        return ChainNotificationsValidator;
      default:
        return BaseValidator;
    }
  }

  static validateToolInput(toolName, input) {
    try {
      switch (toolName) {
        case 'gf_list_forms':
          // GF's /forms endpoint honors ONLY `include` server-side
          // (class-controller-forms.php get_items reads $request['include'];
          // get_collection_params declares only page/per_page/search). `status`,
          // `active`, and `exclude` are NOT read by GF — forwarding them was a
          // no-op that misleadingly advertised support, so drop them here.
          const validated = {};
          if (input.include !== undefined) {
            validated.include = BaseValidator.validateArray(input.include, 'include');
            if (validated.include.length > 0) {
              validated.include = BaseValidator.validateIds(validated.include, 'include');
            }
          }
          return validated;

        case 'gf_create_form':
          return FormsValidator.validateFormData(input, false);
        case 'gf_update_form':
          return FormsValidator.validateFormData(input, true);
        case 'gf_get_form':
        case 'gf_delete_form':
          const result = {
            id: BaseValidator.resolveFormId(input, 'id')
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
          subValidated.form_id = BaseValidator.resolveFormId(input, 'form_id');
          delete subValidated.id;
          let inputKeyCount = 0;
          // GF spells "no value" as '', never the text "null".
          const toWireScalar = entry => (entry === null || entry === undefined) ? '' : String(entry);
          Object.keys(input).forEach(key => {
            if (!key.startsWith('input_')) {
              return;
            }
            // GF collapses input_5.3 to input_5_3 and keeps whichever spelling
            // came last. Normalizing first is what lets the two be compared.
            const targetKey = /^input_\d+\.\d+$/.test(key) ? key.replace('.', '_') : key;
            if (targetKey !== key) {
              delete subValidated[key];
              const hasBothSpellings = Object.prototype.hasOwnProperty.call(input, targetKey);
              if (hasBothSpellings) {
                const spellingsDisagree = JSON.stringify(input[targetKey]) !== JSON.stringify(input[key]);
                if (spellingsDisagree) {
                  throw new Error(`${key} and ${targetKey} name the same input and disagree; pass one`);
                }
                return;
              }
            }
            // Joined, a comma inside an array value ("Atlanta, GA") cannot be
            // told from a separator. A GF 3.0 "formatted" phone decodes only from
            // a JSON string. A checkbox reads each choice from its own sub-input
            // and ignores an array under input_5.
            const value = input[key];
            if (Array.isArray(value)) {
              subValidated[targetKey] = value.map(entry =>
                entry !== null && typeof entry === 'object' ? entry : toWireScalar(entry)
              );
            } else if (value !== null && typeof value === 'object') {
              subValidated[targetKey] = JSON.stringify(value);
            } else {
              subValidated[targetKey] = toWireScalar(value);
            }
            inputKeyCount++;
          });

          // GF declares field_values as type ['string','array'] — it is GF
          // dynamic-population data (GFAPI::submit_form's 3rd arg), NOT the
          // submitted values. Submitted values are the input_N keys above. An
          // object is rejected by GF's own arg validation (HTTP 400), so reject
          // it here with a message that points to the right place.
          const fieldValuesIsWrongType =
            input.field_values !== undefined &&
            typeof input.field_values !== 'string' &&
            !Array.isArray(input.field_values);
          // GF's API path never parses a string field_values (GFForms::get
          // returns '' for a non-array), so one populates nothing.
          const fieldValuesIsSerializedObject =
            typeof input.field_values === 'string' &&
            /^\s*[{[]/.test(input.field_values);

          if (fieldValuesIsWrongType || fieldValuesIsSerializedObject) {
            throw new Error('field_values must be an array — it is GF dynamic-population data, and GF ignores a string one on this path; pass field values as top-level input_N keys (e.g. input_1)');
          }

          // GF answers an empty submission by naming whichever field is
          // required, never the missing values.
          if (toolName === 'gf_submit_form_data' && inputKeyCount === 0) {
            throw new Error('no field values were given: pass them as top-level input_N keys (e.g. input_1: "Ada", input_3: "..."), one per field id');
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
          const entryResult = {
            id: BaseValidator.resolveEntryId(input, 'id')
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
          // GF's /feeds controller reads `include` as the feed-id filter
          // (class-controller-feeds.php get_items), and its per-form sibling
          // declares it in get_collection_params. Without it the query is every
          // feed on the site whatever ids were asked for.
          if (input.include !== undefined) {
            feedsValidated.include = BaseValidator.validateArray(input.include, 'include');
            if (feedsValidated.include.length > 0) {
              feedsValidated.include = BaseValidator.validateIds(feedsValidated.include, 'include');
            }
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
          return ChainFeedsValidator.validateFeedData(input, true);

        case 'gf_update_feed':
          return ChainFeedsValidator.validateFeedData(input, false);

        case 'gf_patch_feed':
          // PATCH already merges meta, so the opt-in has nothing to opt into. Accepting
          // and ignoring it would let a caller believe it had chosen something.
          if (input && input.replace_meta !== undefined) {
            throw new Error('replace_meta applies to gf_update_feed; gf_patch_feed already merges meta into the stored feed');
          }
          return ChainFeedsValidator.validateFeedData(input, false);

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
          // Check presence (not falsiness) so entry_id:0 falls through to the
          // positiveInteger rule and yields "must be a positive integer" rather
          // than the misleading "entry_id is required". Truly-missing/null still
          // reports required.
          if (!input || input.entry_id === undefined || input.entry_id === null) {
            throw new Error('entry_id is required');
          }
          return ChainNotificationsValidator.validateSendNotificationsParams(input);

        case 'gf_get_field_filters':
        case 'gf_get_results':
          BaseValidator.validateRequired(input, ['form_id']);
          const utilityValidated = {
            form_id: BaseValidator.validateId(input.form_id, 'form_id')
          };
          // GF's /results endpoint accepts the same entry search criteria as
          // /entries (parse_entry_search_params); reuse the entries validator.
          if (toolName === 'gf_get_results' && input.search !== undefined) {
            const search = BaseValidator.validateSearch(input.search);
            if (search && Object.keys(search).length > 0) {
              utilityValidated.search = search;
            }
          }
          return utilityValidated;

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
    return ChainFeedsValidator.validateFeedData(data || {}, isCreate);
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
    return ChainNotificationsValidator.validateSendNotificationsParams(params || {});
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