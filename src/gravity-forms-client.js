/**
 * Gravity Forms REST API v2 Client
 * Comprehensive client for all Gravity Forms endpoints
 * Uses Basic Authentication as primary method per Gravity Forms v2 recommendations
 */

import axios from 'axios';
import https from 'https';
import { AuthManager, validateRestApiAccess, flattenParams, rfc3986Encode } from './config/auth.js';
import { ValidationFactory } from './config/validation.js';
import logger from './utils/logger.js';
import { sanitizeUrl, sanitizeHeaders } from './utils/sanitize.js';
import { generateCompoundInputs, assignFieldIds } from './field-definitions/field-registry.js';
import { testConfig } from './config/test-config.js';
import { resourceMutex } from './utils/mutex.js';
import { USER_AGENT } from './version.js';

/**
 * Build the query params for GET /entries from validated gf_list_entries input.
 *
 * Returned object is fed to the axios paramsSerializer (flattenParams), which
 * brackets nested objects/arrays. Gravity Forms reads `sorting`/`paging` as
 * arrays (sorting[key], paging[page_size]) and `search` as a JSON string;
 * it has no top-level status/include/exclude — status lives in search.status
 * and id-based selection is field_filters on key 'id'.
 *
 * @param {object} validated Output of EntriesValidator.validateListEntriesParams.
 * @returns {object} Query params object for the GF REST request.
 */
export function buildEntriesQuery(validated) {
  const { search, sorting, paging, form_ids, status, include, exclude, ...rest } = validated;
  const query = { ...rest };

  // GF reads form_ids/sorting/paging as arrays; the paramsSerializer brackets
  // them on the wire (form_ids[0]=…, sorting[key]=…, paging[page_size]=…). They
  // must stay objects/arrays — JSON-stringifying makes GF's isset() checks fail,
  // so it silently defaults paging (page_size=10/offset=0) and sorting (id/DESC).
  if (form_ids !== undefined) query.form_ids = form_ids;
  if (sorting !== undefined) query.sorting = sorting;
  if (paging !== undefined) query.paging = paging;

  // GF /entries has a native `include` fast-path: fetch exactly these entry ids
  // (any status, in order), bypassing search/sorting/paging/form_ids. Pass it as
  // the native top-level param so the serializer brackets it (include[0]=…).
  if (Array.isArray(include) && include.length > 0) {
    query.include = include;
  }

  // GF has no top-level status/exclude param. status lives in search.status;
  // exclude maps to a field_filter on key 'id' (operator 'not in'). Both ride
  // the single `search` criteria GF expects JSON-encoded. (When `include` is set,
  // GF takes the fast-path and ignores search — that is GF's own behavior.)
  const criteria = search ? { ...search } : {};

  // GF reads the search mode from INSIDE field_filters ($field_filters['mode']),
  // never from a top-level search.mode. Pull it off the criteria here and
  // re-attach it to field_filters below.
  const { mode, ...criteriaWithoutMode } = criteria;
  const finalCriteria = criteriaWithoutMode;

  const fieldFilters = Array.isArray(finalCriteria.field_filters) ? [...finalCriteria.field_filters] : [];

  if (Array.isArray(exclude) && exclude.length > 0) {
    fieldFilters.push({ key: 'id', operator: 'not in', value: exclude });
  }

  // Attach mode as a `mode` key on field_filters. JSON.stringify drops a named
  // prop off a JS array, so when mode is present we emit field_filters as an
  // object ({"0":…,"mode":…}) which json_decodes to the PHP array GF iterates
  // after reading + unsetting 'mode'. Object index access keeps [0]/[1] valid.
  if (mode !== undefined) {
    finalCriteria.field_filters = Object.assign({}, fieldFilters, { mode });
  } else if (fieldFilters.length > 0) {
    finalCriteria.field_filters = fieldFilters;
  }

  if (status !== undefined) {
    finalCriteria.status = status;
  }

  if (Object.keys(finalCriteria).length > 0) {
    query.search = JSON.stringify(finalCriteria);
  }

  return query;
}

export class GravityFormsClient {
  constructor(config) {
    this.config = testConfig.resolveEnv(config);
    this.authManager = new AuthManager(this.config);
    this.baseURL = `${this.config.GRAVITY_FORMS_BASE_URL}/wp-json/gf/v2`;

    // Allow self-signed certs when EITHER flag is explicitly 'true'. Compare each
    // flag on its own — `A || B` short-circuits on a truthy string like 'false',
    // which would let one flag mask the other.
    const allowSelfSignedCerts =
      this.config.GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS === 'true' ||
      this.config.MCP_ALLOW_SELF_SIGNED_CERTS === 'true';

    // Initialize HTTP client with Basic Auth as primary method
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: parseInt(this.config.GRAVITY_FORMS_TIMEOUT, 10) || 30000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      // Serialize query params as explicit bracket-index pairs
      // (include[0]=3, paging[page_size]=2) — the exact pairs
      // flattenParams() feeds the OAuth signature, so the signed
      // string and the wire string can never diverge. PHP parses
      // either bracket style identically, so Basic-auth requests
      // are unaffected.
      paramsSerializer: {
        serialize: (params) => flattenParams(params)
          .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
          .join('&'),
      },
      // Allow self-signed certificates for local development
      // Set GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=true in .env for local dev environments
      httpsAgent: new https.Agent({
        rejectUnauthorized: !allowSelfSignedCerts
      })
    });

    // Request interceptor for authentication
    this.httpClient.interceptors.request.use(
      (requestConfig) => {
        // Get auth headers using the preferred method (Basic Auth primary)
        const authHeaders = this.authManager.getAuthHeaders(
          requestConfig.method?.toUpperCase(),
          `${this.baseURL}${requestConfig.url}`,
          requestConfig.params
        );

        // Merge auth headers
        requestConfig.headers = {
          ...requestConfig.headers,
          ...authHeaders
        };

        // Log request if debug enabled (with sanitization)
        if (this.config.GRAVITY_FORMS_DEBUG === 'true') {
          const safeUrl = sanitizeUrl(`${this.baseURL}${requestConfig.url}`);
          sanitizeHeaders(requestConfig.headers);
          logger.info(`🌐 ${requestConfig.method?.toUpperCase()} ${safeUrl}`);
          if (requestConfig.data) {
            logger.info('  📦 Request data sent (sanitized)');
          }
        }

        return requestConfig;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => {
        if (this.config.GRAVITY_FORMS_DEBUG === 'true') {
          // Response URLs are relative paths without sensitive data
          logger.info(`✅ ${response.status} ${response.config.url}`);
        }
        return response;
      },
      (error) => {
        if (this.config.GRAVITY_FORMS_DEBUG === 'true') {
          // Error URLs are relative paths without sensitive data
          console.error(`❌ ${error.response?.status || 'Network Error'} ${error.config?.url || ''}`);
        }

        // Enhanced error handling
        return this.handleApiError(error);
      }
    );

    // Safety check for delete operations
    this.allowDelete = this.config.GRAVITY_FORMS_ALLOW_DELETE === 'true';
  }

  /**
   * Initialize and validate connection
   */
  async initialize() {
    // During testing, don't output to stderr to avoid red terminal output
    const isTest = process.env.NODE_ENV === 'test' ||
                  process.env.GRAVITY_FORMS_TEST_MODE === 'true' ||
                  process.argv.some(arg => arg.includes('test'));

    const isTestMode = this.config.GRAVITYKIT_MCP_TEST_MODE === 'true' || this.config.GRAVITYMCP_TEST_MODE === 'true';

    // Only output initialization messages when not in unit test mode
    if (!isTest) {
      logger.info('🚀 Initializing GravityKit MCP');
      logger.info(`📡 Connecting to: ${this.config.GRAVITY_FORMS_BASE_URL}${isTestMode ? ' (TEST MODE)' : ''}`);
    }

    // Validate REST API access
    const validation = await validateRestApiAccess(this.httpClient, this.authManager);

    if (!validation.available) {
      throw new Error(`Gravity Forms REST API not accessible: ${validation.error}`);
    }

    if (!isTest) {
      const authInfo = this.authManager.getAuthInfo();
      logger.info(`🔐 Authentication: ${authInfo.method} ${authInfo.recommended ? '(Recommended)' : '(Secondary)'}`);
      logger.info(`🛡️ Security: ${authInfo.secure ? 'HTTPS ✅' : 'HTTP ⚠️'}`);
      logger.info(`🔧 API Access: ${validation.message}`);
      logger.info(`🗑️ Delete Operations: ${this.allowDelete ? 'ENABLED ⚠️' : 'DISABLED ✅'}`);

      if (!validation.fullAccess) {
        logger.warn(`⚠️ Limited API access: ${validation.coverage}`);
      }
    }

    return validation;
  }

  /**
   * Enhanced error handling
   */
  async handleApiError(error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const message = data?.message || error.message;

    // Create standardized error
    const apiError = new Error(message);
    apiError.status = status;
    apiError.code = data?.code;
    apiError.details = data;
    apiError.originalError = error;

    // Add helpful context based on error type
    switch (status) {
      case 401:
        apiError.message = `Authentication failed: ${message}. Please check your Consumer Key and Secret.`;
        break;
      case 403:
        apiError.message = `Access forbidden: ${message}. Please check user permissions in Gravity Forms.`;
        break;
      case 404:
        apiError.message = `Resource not found: ${message}`;
        break;
      case 429:
        apiError.message = `Rate limit exceeded: ${message}. Please wait before retrying.`;
        break;
      case 500:
        apiError.message = `Server error: ${message}. Please check your Gravity Forms installation.`;
        break;
    }

    throw apiError;
  }

  /**
   * Extract the GF response body + status from a thrown error, regardless of
   * which layer threw it.
   *
   * Two shapes reach a client method's catch block:
   *   - Raw axios/mock error: `err.response = { status, data }` (the shape axios
   *     produces, and what the test fake throws — the response interceptor has
   *     not standardized it yet at this point in some paths).
   *   - Standardized apiError from handleApiError(): `{ status, details }`.
   *
   * @param {Error} error The thrown error.
   * @returns {{status: (number|undefined), body: any}} The HTTP status and body.
   */
  _extractErrorResponse(error) {
    const status = error?.response?.status ?? error?.status;
    const body = error?.response?.data ?? error?.details;
    return { status, body };
  }

  /**
   * Whether a thrown error is GF's NORMAL "submission is invalid" response: an
   * HTTP 400 carrying an `is_valid` flag in the body. GF returns this for a
   * rejected /submissions or /submissions/validation request — it is a valid
   * result to return, not an error to throw. A 400 WITHOUT an is_valid body
   * (e.g. a malformed request) is a real error and is NOT matched here.
   *
   * @param {Error} error The thrown error.
   * @returns {any|null} The validation body when this is GF's invalid-submission
   *   400, otherwise null.
   */
  _gfValidationBody(error) {
    const { status, body } = this._extractErrorResponse(error);
    const isValidationResult = status === 400 && body && typeof body === 'object' && 'is_valid' in body;
    return isValidationResult ? body : null;
  }

  /**
   * Validate tool input and execute API call
   */
  async validateAndCall(toolName, input, apiCall) {
    try {
      // Validate input parameters
      const validatedInput = ValidationFactory.validateToolInput(toolName, input);

      // Execute API call with validated input
      return await apiCall(validatedInput);
    } catch (error) {
      // If it's an HTTP error from the mock/real client, handle it properly
      if (error.response && error.response.status) {
        // Transform the error with proper message based on status code
        return this.handleApiError(error);
      }
      // Otherwise, wrap validation errors with tool name
      throw new Error(`${toolName} failed: ${error.message}`);
    }
  }

  // =================================
  // FORMS MANAGEMENT (6 tools)
  // =================================

  /**
   * List all forms with filtering and pagination
   */
  async listForms(params = {}) {
    return this.validateAndCall('gf_list_forms', params, async (validated) => {
      const response = await this.httpClient.get('/forms', { params: validated });
      const forms = response.data;

      // GF returns /forms as an object keyed by id ({ "1": {...} }) and sends NO
      // X-WP-Total header, so the count is simply how many forms came back.
      // total_pages would always be bogus (GF doesn't paginate /forms), so it
      // is fixed at 1.
      let total_count = 0;
      if (Array.isArray(forms)) {
        total_count = forms.length;
      } else if (forms && typeof forms === 'object') {
        total_count = Object.keys(forms).length;
      }

      return {
        forms,
        total_count,
        total_pages: 1
      };
    });
  }

  /**
   * Get specific form by ID with complete schema
   */
  async getForm(params) {
    return this.validateAndCall('gf_get_form', params, async (validated) => {
      const { id } = validated;
      const response = await this.httpClient.get(`/forms/${id}`);

      return {
        form: response.data
      };
    });
  }

  /**
   * Create new form with fields and settings
   */
  async createForm(params) {
    // Auto-number any fields the caller left without an id (GF max+1), BEFORE
    // validation — so a natural-language caller can describe fields without
    // hand-assigning ids. Explicit ids are preserved; compound sub-inputs are
    // re-based onto the assigned id.
    if (params && Array.isArray(params.fields)) {
      params = { ...params, fields: assignFieldIds(params.fields) };
    }
    return this.validateAndCall('gf_create_form', params, async (validated) => {
      // Process fields to ensure compound types have proper inputs array.
      if (validated.fields && Array.isArray(validated.fields)) {
        validated.fields = validated.fields.map(field => {
          if (field.inputs && Array.isArray(field.inputs) && field.inputs.length > 0) {
            return field;
          }

          // Generate inputs for compound fields (address, name, creditcard, consent).
          const inputs = generateCompoundInputs(field);

          if (inputs) {
            return { ...field, inputs };
          }

          return field;
        });
      }

      const response = await this.httpClient.post('/forms', validated);

      return {
        form: response.data
      };
    });
  }

  /**
   * Update existing form (fetch-then-merge, mutex-serialized).
   *
   * Acquires a per-form lock to prevent concurrent updates from
   * overwriting each other in the GET→merge→PUT pattern.
   */
  async updateForm(params) {
    return this.validateAndCall('gf_update_form', params, async (validated) => {
      const { id, ...updates } = validated;

      return resourceMutex.withLock(`form:${id}`, async () => {
        // Fetch existing form to preserve all current data
        const existingFormResponse = await this.httpClient.get(`/forms/${id}`);
        const existingForm = existingFormResponse.data;

        // Merge updates with existing form data
        const updatedFormData = {
          ...existingForm,
          ...updates
        };

        const response = await this.httpClient.put(`/forms/${id}`, updatedFormData);

        return {
          form: response.data
        };
      });
    });
  }

  /**
   * Replace a form's data directly via PUT without re-fetching.
   *
   * Used by FieldManager which already has the complete form state
   * after its own GET + modification. Avoids the double-fetch that
   * would occur if FieldManager called updateForm().
   *
   * Mutex-serialized on the form ID to prevent concurrent field
   * operations from overwriting each other.
   *
   * @param {number} formId - The form ID.
   * @param {object} formData - The complete form data to PUT.
   * @returns {Promise<{form: object}>} The updated form.
   */
  async replaceForm(formId, formData) {
    return resourceMutex.withLock(`form:${formId}`, async () => {
      const response = await this.httpClient.put(`/forms/${formId}`, formData);
      return {
        form: response.data
      };
    });
  }

  /**
   * Delete/trash form (requires ALLOW_DELETE=true)
   */
  async deleteForm(params) {
    if (!this.allowDelete) {
      throw new Error('Delete operations are disabled. Set GRAVITY_FORMS_ALLOW_DELETE=true to enable.');
    }

    return this.validateAndCall('gf_delete_form', params, async (validated) => {
      const { id, force = false } = validated;

      const deleteParams = {};
      if (force) {
        deleteParams.force = 'true';
      }

      await this.httpClient.delete(`/forms/${id}`, { params: deleteParams });

      return {
        deleted: true,
        form_id: id,
        permanently: force
      };
    });
  }

  /**
   * Validate form submission data
   */
  async validateForm(params) {
    return this.validateAndCall('gf_validate_form', params, async (validated) => {
      const { form_id, ...submissionData } = validated;

      // Dedicated validation route — validate WITHOUT creating an entry. POSTing
      // {validation_only:true} to /submissions does NOT validate: GF ignores the
      // body flag (it reads the `_validate_only` query param) and really submits,
      // creating an entry and firing notifications/feeds. GF returns the normal
      // "invalid" case as HTTP 400 with an is_valid body — caught as a result.
      let body;
      try {
        const response = await this.httpClient.post(`/forms/${form_id}/submissions/validation`, submissionData);
        body = response.data;
      } catch (error) {
        const validationBody = this._gfValidationBody(error);
        if (!validationBody) throw error;
        body = validationBody;
      }

      return {
        valid: body.is_valid || false,
        validation_messages: body.validation_messages || {},
        page_number: body.page_number,
        source_page_number: body.source_page_number
      };
    });
  }

  // =================================
  // ENTRIES MANAGEMENT (6 tools)
  // =================================

  /**
   * Search and list entries with advanced filtering
   */
  async listEntries(params = {}) {
    return this.validateAndCall('gf_list_entries', params, async (validated) => {
      const searchParams = buildEntriesQuery(validated);

      const response = await this.httpClient.get('/entries', { params: searchParams });
      const data = response.data;

      // Normalize to ALWAYS return { entries: array, total_count: number };
      // never fabricate entries or report a count for entries we can't see.
      // Search path is { entries:[...], total_count }; the include fast-path is
      // entries keyed by id ({ "123": {...} }) with no wrapper and no X-WP-Total.
      // Anything malformed (null/''/string/{entries:notArray}) → [] / 0.
      let entries = [];
      let total_count = 0;

      const hasArrayEntries = data && Array.isArray(data.entries);
      const isKeyedObject = data && typeof data === 'object' && !Array.isArray(data) && !('entries' in data);

      if (hasArrayEntries) {
        entries = data.entries;
        const headerCount = parseInt(response.headers['x-wp-total'] || '0', 10);
        total_count = typeof data.total_count === 'number' ? data.total_count : headerCount;
      } else if (isKeyedObject) {
        const values = Object.values(data);
        // Only treat values as entries when they look like entries (objects).
        const looksLikeEntries = values.length > 0 && values.every(v => v && typeof v === 'object');
        if (looksLikeEntries) {
          entries = values;
          total_count = values.length;
        }
      }

      return { entries, total_count };
    });
  }

  /**
   * Get specific entry by ID with field labels
   */
  async getEntry(params) {
    return this.validateAndCall('gf_get_entry', params, async (validated) => {
      const { id } = validated;
      const response = await this.httpClient.get(`/entries/${id}`);

      return {
        entry: response.data
      };
    });
  }

  /**
   * Normalize array values in entry data to match Gravity Forms storage patterns.
   *
   * Different field types store multi-value data differently:
   *   - Checkbox (incl. image choice checkbox): dot-notation sub-inputs ("5.1": "val")
   *   - Multiselect: JSON-encoded string ("[\"a\",\"b\"]")
   *   - Radio, dropdown, image choice radio/dropdown: single value (no arrays)
   *   - Consent: special sub-inputs (not choice-based, left untouched)
   *
   * When entry data contains array values, this method fetches the form to
   * identify the field type and applies the correct storage format.
   *
   * For checkbox fields, values are matched against choice.value first, then
   * choice.text as fallback. This ensures the correct sub-input ID is used even
   * when IDs have gaps from deleted choices.
   *
   * @param {object} entryData - Entry data, possibly containing array values.
   * @param {number} formId - The form ID to fetch field definitions from.
   * @returns {Promise<object>} Entry data with arrays normalized per field type.
   */
  async _normalizeArrayValues(entryData, formId) {
    const arrayKeys = Object.keys(entryData).filter(k => Array.isArray(entryData[k]));
    if (arrayKeys.length === 0) return entryData;

    const formResponse = await this.httpClient.get(`/forms/${formId}`);
    const fields = formResponse.data.fields || [];

    const expanded = { ...entryData };

    // Single-value field types: radio/dropdown take first element from arrays
    const singleValueTypes = new Set(['radio', 'select']);

    // Field types where arrays should not be normalized:
    // - list: REST API handles array serialization natively
    // - chainedselect: has inputs+choices but is compound (each sub-input = one dropdown),
    //   not multi-select. Nested choices are a tree, not flat checkbox choices.
    const passthroughTypes = new Set(['list', 'chainedselect']);

    for (const key of arrayKeys) {
      const fieldId = parseInt(key, 10);
      if (isNaN(fieldId)) continue;

      const field = fields.find(f => f.id === fieldId);
      if (!field) continue;

      const fieldType = field.inputType || field.type;

      // List and other passthrough types: REST API handles arrays natively
      if (passthroughTypes.has(field.type)) continue;

      // Checkbox-type fields: expand to dot-notation sub-inputs
      // Detection: has both inputs[] and choices[] (works for checkbox, quiz,
      // poll, survey, option, post_category, post_custom_field with inputType=checkbox)
      if (field.inputs && field.choices) {
        const values = expanded[key];
        delete expanded[key];

        // Clear all visible sub-inputs for this field
        for (const input of field.inputs) {
          if (input.isHidden) continue;
          expanded[String(input.id)] = '';
        }

        // Build visible-input list (hidden inputs like "Select All" shift indices)
        const visibleInputs = field.inputs.filter(input => !input.isHidden);

        // Match each value to a choice and assign to the correct sub-input.
        // GF HTML-encodes choice text (& → &amp;, etc.), so also compare
        // against decoded text for natural-language input from AI agents.
        const decodeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
        for (const val of values) {
          const choiceIndex = field.choices.findIndex(
            c => c.value === val || c.text === val || decodeHtml(c.text) === val
          );

          if (choiceIndex !== -1 && visibleInputs[choiceIndex]) {
            expanded[String(visibleInputs[choiceIndex].id)] = field.choices[choiceIndex].value;
          }
        }
        continue;
      }

      // Fields with choices but no inputs: either single-value or multi-value
      if (field.choices) {
        if (singleValueTypes.has(fieldType)) {
          // Radio/dropdown: take first element
          expanded[key] = expanded[key][0] || '';
        } else {
          // Multiselect, entry_tags, or any other multi-value field:
          // REST API v2 accepts comma-separated strings for multi-value fields
          expanded[key] = expanded[key].join(',');
        }
      }
    }

    return expanded;
  }

  /**
   * Create new entry with validation
   */
  async createEntry(params) {
    return this.validateAndCall('gf_create_entry', params, async (validated) => {
      const expanded = await this._normalizeArrayValues(validated, validated.form_id);
      const response = await this.httpClient.post('/entries', expanded);

      return {
        entry: response.data
      };
    });
  }

  /**
   * Update existing entry (fetch-then-merge, mutex-serialized).
   */
  async updateEntry(params) {
    return this.validateAndCall('gf_update_entry', params, async (validated) => {
      const { id, ...updates } = validated;

      return resourceMutex.withLock(`entry:${id}`, async () => {
        const existingEntryResponse = await this.httpClient.get(`/entries/${id}`);
        const existingEntry = existingEntryResponse.data;

        // Expand checkbox arrays before merging so stale sub-inputs are cleared
        const expandedUpdates = await this._normalizeArrayValues(updates, existingEntry.form_id);

        const updatedEntryData = {
          ...existingEntry,
          ...expandedUpdates
        };

        const response = await this.httpClient.put(`/entries/${id}`, updatedEntryData);

        return {
          entry: response.data
        };
      });
    });
  }

  /**
   * Delete/trash entry (requires ALLOW_DELETE=true)
   */
  async deleteEntry(params) {
    if (!this.allowDelete) {
      throw new Error('Delete operations are disabled. Set GRAVITY_FORMS_ALLOW_DELETE=true to enable.');
    }

    return this.validateAndCall('gf_delete_entry', params, async (validated) => {
      const { id, force = false } = validated;

      const deleteParams = {};
      if (force) {
        deleteParams.force = 'true';
      }

      await this.httpClient.delete(`/entries/${id}`, { params: deleteParams });

      return {
        deleted: true,
        entry_id: id,
        permanently: force
      };
    });
  }

  // =================================
  // FORM SUBMISSIONS (2 tools)
  // =================================

  /**
   * Submit form with complete processing pipeline
   */
  async submitFormData(params) {
    return this.validateAndCall('gf_submit_form_data', params, async (validated) => {
      const { form_id, ...submissionData } = validated;

      // GF returns HTTP 400 {is_valid:false, validation_messages, …} on a
      // REJECTED submission. That is a normal "didn't pass validation" result,
      // not a transport error —
      // catch the 400 and return it. Anything else (401/403/404/500, or a 400
      // without an is_valid body) is a real error and re-throws.
      let body;
      try {
        const response = await this.httpClient.post(`/forms/${form_id}/submissions`, submissionData);
        body = response.data;
      } catch (error) {
        const validationBody = this._gfValidationBody(error);
        if (!validationBody) throw error;
        body = validationBody;
      }

      return {
        success: body.is_valid || false,
        entry_id: body.entry_id,
        confirmation_message: body.confirmation_message || '',
        validation_messages: body.validation_messages || {},
        resume_token: body.resume_token,
        resume_url: body.resume_url
      };
    });
  }

  /**
   * Validate submission without processing
   */
  async validateSubmission(params) {
    return this.validateAndCall('gf_validate_submission', params, async (validated) => {
      const { form_id, ...submissionData } = validated;

      // Dedicated validation route: GF validates WITHOUT creating an entry or
      // firing notifications/feeds. A validation_only flag on /submissions is
      // ignored by GF (it really submits), so it must not be used.
      // GF returns the NORMAL "invalid" case as HTTP 400 with an is_valid body
      // (validation controller :88-90) — caught below as a result, not an error.
      let body;
      try {
        const response = await this.httpClient.post(`/forms/${form_id}/submissions/validation`, submissionData);
        body = response.data;
      } catch (error) {
        const validationBody = this._gfValidationBody(error);
        if (!validationBody) throw error;
        body = validationBody;
      }

      return {
        valid: body.is_valid || false,
        validation_messages: body.validation_messages || {},
        page_number: body.page_number,
        source_page_number: body.source_page_number
      };
    });
  }

  // =================================
  // NOTIFICATIONS (1 tool)
  // =================================

  /**
   * Send notifications for entry
   */
  async sendNotifications(params) {
    return this.validateAndCall('gf_send_notifications', params, async (validated) => {
      const { entry_id, notification_ids, event } = validated;

      // GF reads `_notifications` (comma-separated ids) and `_event` as query
      // params. An EMPTY _notifications string makes GF send ALL notifications
      // for the event (dangerous), so only send it with real ids: drop null/
      // empty/non-string ids. If the caller asked for specific ids but they ALL
      // drop out, throw rather than silently fall through to "send all".
      // Omitting notification_ids entirely is the legitimate "send all" request.
      const queryParams = {};
      const callerSuppliedIds = Array.isArray(notification_ids) && notification_ids.length > 0;
      if (callerSuppliedIds) {
        const validIds = notification_ids.filter(id => typeof id === 'string' && id.trim() !== '');
        if (validIds.length === 0) {
          throw new Error('notification_ids contained no valid notification id (all were null/empty/non-string)');
        }
        queryParams._notifications = validIds.join(',');
      }
      if (event) {
        queryParams._event = event;
      }

      const response = await this.httpClient.post(`/entries/${entry_id}/notifications`, {}, { params: queryParams });

      return {
        sent: true,
        notifications_sent: Array.isArray(response.data) ? response.data : []
      };
    });
  }

  // =================================
  // ADD-ON FEEDS (7 tools)
  // =================================

  /**
   * List all feeds or filter by addon
   */
  async listFeeds(params = {}) {
    return this.validateAndCall('gf_list_feeds', params, async (validated) => {
      const response = await this.httpClient.get('/feeds', { params: validated });

      // Gravity Forms signals "zero feeds" as a serialized WP_Error with
      // HTTP 200 (not_found = none match; missing_table = no feed add-on has
      // ever run). Normalize any HTTP-200 WP_Error to [] so callers always
      // get an array; real failures arrive as non-200 and throw before here.
      const data = response.data;
      const isEmptyWpError = data && !Array.isArray(data) && !!data.errors;

      return {
        feeds: isEmptyWpError ? [] : data
      };
    });
  }

  /**
   * Get specific feed by ID
   */
  async getFeed(params) {
    return this.validateAndCall('gf_get_feed', params, async (validated) => {
      const { id } = validated;
      const response = await this.httpClient.get(`/feeds/${id}`);

      return {
        feed: response.data
      };
    });
  }

  /**
   * Get all feeds for specific form
   */
  async listFormFeeds(params) {
    return this.validateAndCall('gf_list_form_feeds', params, async (validated) => {
      const { form_id } = validated;
      const response = await this.httpClient.get(`/forms/${form_id}/feeds`);

      return {
        feeds: response.data
      };
    });
  }

  /**
   * Create new add-on feed
   */
  async createFeed(params) {
    return this.validateAndCall('gf_create_feed', params, async (validated) => {
      const response = await this.httpClient.post('/feeds', validated);

      return {
        feed: response.data
      };
    });
  }

  /**
   * Update existing feed completely (fetch-then-merge, mutex-serialized).
   */
  async updateFeed(params) {
    return this.validateAndCall('gf_update_feed', params, async (validated) => {
      const { id, ...updates } = validated;

      return resourceMutex.withLock(`feed:${id}`, async () => {
        const existingFeedResponse = await this.httpClient.get(`/feeds/${id}`);
        const existingFeed = existingFeedResponse.data;

        const updatedFeedData = {
          ...existingFeed,
          ...updates
        };

        const response = await this.httpClient.put(`/feeds/${id}`, updatedFeedData);

        return {
          feed: response.data
        };
      });
    });
  }

  /**
   * Partially update feed properties
   */
  async patchFeed(params) {
    return this.validateAndCall('gf_patch_feed', params, async (validated) => {
      const { id, ...patchData } = validated;
      const response = await this.httpClient.patch(`/feeds/${id}`, patchData);

      return {
        feed: response.data
      };
    });
  }

  /**
   * Delete add-on feed
   */
  async deleteFeed(params) {
    if (!this.allowDelete) {
      throw new Error('Delete operations are disabled. Set GRAVITY_FORMS_ALLOW_DELETE=true to enable.');
    }

    return this.validateAndCall('gf_delete_feed', params, async (validated) => {
      const { id } = validated;
      await this.httpClient.delete(`/feeds/${id}`);

      return {
        deleted: true,
        feed_id: id
      };
    });
  }

  // =================================
  // UTILITIES (2 tools)
  // =================================

  /**
   * Get field filters for form (for search/filter UI)
   */
  async getFieldFilters(params) {
    return this.validateAndCall('gf_get_field_filters', params, async (validated) => {
      const { form_id } = validated;
      const response = await this.httpClient.get(`/forms/${form_id}/field-filters`);

      return {
        field_filters: response.data
      };
    });
  }

  /**
   * Get Quiz, Poll, or Survey results with analytics
   */
  async getResults(params) {
    return this.validateAndCall('gf_get_results', params, async (validated) => {
      const { form_id, ...searchParams } = validated;
      const response = await this.httpClient.get(`/forms/${form_id}/results`, { params: searchParams });

      return {
        results: response.data
      };
    });
  }

  // =================================
  // UTILITY METHODS
  // =================================

  /**
   * Test connection and capabilities
   */
  async testConnection() {
    return await this.authManager.testConnection(this.httpClient);
  }

  /**
   * Get client information
   */
  getClientInfo() {
    const authInfo = this.authManager.getAuthInfo();
    return {
      baseUrl: this.config.GRAVITY_FORMS_BASE_URL,
      apiUrl: this.baseURL,
      authMethod: authInfo.method,
      deleteAllowed: this.allowDelete,
      timeout: this.httpClient.defaults.timeout,
      version: '1.0.0'
    };
  }
}

export default GravityFormsClient;