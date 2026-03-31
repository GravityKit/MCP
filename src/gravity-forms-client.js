/**
 * Gravity Forms REST API v2 Client
 * Comprehensive client for all Gravity Forms endpoints
 * Uses Basic Authentication as primary method per Gravity Forms v2 recommendations
 */

import axios from 'axios';
import https from 'https';
import { AuthManager, validateRestApiAccess } from './config/auth.js';
import { ValidationFactory } from './config/validation.js';
import logger from './utils/logger.js';
import { sanitizeUrl, sanitizeHeaders } from './utils/sanitize.js';
import { generateCompoundInputs } from './field-definitions/field-registry.js';
import { testConfig } from './config/test-config.js';
import { resourceMutex } from './utils/mutex.js';

export class GravityFormsClient {
  constructor(config) {
    this.config = testConfig.resolveEnv(config);
    this.authManager = new AuthManager(this.config);
    this.baseURL = `${this.config.GRAVITY_FORMS_BASE_URL}/wp-json/gf/v2`;

    // Initialize HTTP client with Basic Auth as primary method
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: parseInt(config.GRAVITY_FORMS_TIMEOUT) || 30000,
      headers: {
        'User-Agent': 'GravityKit-MCP/2.0.0',
        'Accept': 'application/json'
      },
      // Allow self-signed certificates for local development
      // Set MCP_ALLOW_SELF_SIGNED_CERTS=true in .env for local dev environments
      httpsAgent: new https.Agent({
        rejectUnauthorized: config.MCP_ALLOW_SELF_SIGNED_CERTS !== 'true'
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

      return {
        forms: response.data,
        total_count: parseInt(response.headers['x-wp-total'] || '0'),
        total_pages: parseInt(response.headers['x-wp-totalpages'] || '1')
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

      const response = await this.httpClient.post(`/forms/${form_id}/submissions`, {
        ...submissionData,
        validation_only: true
      });

      return {
        valid: response.data.is_valid || false,
        validation_messages: response.data.validation_messages || {}
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
      // Convert search parameters to Gravity Forms format
      const searchParams = { ...validated };

      if (validated.search) {
        searchParams.search = JSON.stringify(validated.search);
      }

      if (validated.sorting) {
        searchParams.sorting = JSON.stringify(validated.sorting);
      }

      if (validated.paging) {
        searchParams.paging = JSON.stringify(validated.paging);
      }

      const response = await this.httpClient.get('/entries', { params: searchParams });

      return {
        entries: response.data.entries || response.data,
        total_count: response.data.total_count || parseInt(response.headers['x-wp-total'] || '0')
      };
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

      const response = await this.httpClient.post(`/forms/${form_id}/submissions`, submissionData);

      return {
        success: response.data.is_valid || false,
        entry_id: response.data.entry_id,
        confirmation_message: response.data.confirmation_message || '',
        validation_messages: response.data.validation_messages || {},
        resume_token: response.data.resume_token,
        resume_url: response.data.resume_url
      };
    });
  }

  /**
   * Validate submission without processing
   */
  async validateSubmission(params) {
    return this.validateAndCall('gf_validate_submission', params, async (validated) => {
      const { form_id, ...submissionData } = validated;

      const response = await this.httpClient.post(`/forms/${form_id}/submissions`, {
        ...submissionData,
        validation_only: true
      });

      return {
        valid: response.data.is_valid || false,
        validation_messages: response.data.validation_messages || {},
        field_errors: response.data.field_errors || []
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
      const { entry_id, notification_ids } = validated;

      const requestData = {};
      if (notification_ids) {
        requestData.notification_ids = notification_ids;
      }

      const response = await this.httpClient.post(`/entries/${entry_id}/notifications`, requestData);

      return {
        sent: true,
        notifications_sent: response.data.notifications_sent || []
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

      return {
        feeds: response.data
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