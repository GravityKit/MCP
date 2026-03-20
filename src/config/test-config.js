/**
 * Test Configuration - Dual environment support for test and live
 * Enables safe testing without affecting production data
 */

export const testConfig = {
  environments: {
    test: {
      url: process.env.TEST_GF_URL || process.env.GRAVITY_FORMS_TEST_URL || process.env.GRAVITY_FORMS_TEST_BASE_URL || 'http://localhost:10003',
      consumer_key: process.env.TEST_GF_CONSUMER_KEY || process.env.GRAVITY_FORMS_TEST_CONSUMER_KEY,
      consumer_secret: process.env.TEST_GF_CONSUMER_SECRET || process.env.GRAVITY_FORMS_TEST_CONSUMER_SECRET,
      wp_user: process.env.TEST_WP_USER || 'admin',
      wp_password: process.env.TEST_WP_PASSWORD,
      formPrefix: 'TEST_',
      autoCleanup: true,
      timeout: 30000,
      retries: 3
    },
    live: {
      url: process.env.GF_URL || process.env.GRAVITY_FORMS_BASE_URL,
      consumer_key: process.env.GF_CONSUMER_KEY || process.env.GRAVITY_FORMS_CONSUMER_KEY,
      consumer_secret: process.env.GF_CONSUMER_SECRET || process.env.GRAVITY_FORMS_CONSUMER_SECRET,
      formPrefix: '',
      autoCleanup: false,
      timeout: process.env.GRAVITY_FORMS_TIMEOUT || 30000,
      retries: process.env.GRAVITY_FORMS_MAX_RETRIES || 3
    }
  },
  
  /**
   * Get configuration for specified mode
   * @param {boolean} testMode - Use test configuration if true
   * @returns {object} Configuration object
   */
  getConfig(testMode = false) {
    const envName = testMode ? 'test' : 'live';
    const config = this.environments[envName];
    
    // Validate required fields
    if (!config.url) {
      throw new Error(`Missing ${envName} URL configuration. Set ${testMode ? 'TEST_GF_URL' : 'GF_URL'} environment variable.`);
    }
    
    if (!config.consumer_key || !config.consumer_secret) {
      throw new Error(`Missing ${envName} authentication. Set consumer key and secret environment variables.`);
    }
    
    return config;
  },
  
  /**
   * Check if test mode is enabled
   */
  isTestMode() {
    return process.env.GRAVITYMCP_TEST_MODE === 'true' ||
           process.env.NODE_ENV === 'test';
  },

  /**
   * Resolve environment config for the active mode.
   *
   * When test mode is active, remaps GRAVITY_FORMS_TEST_* env vars to
   * their primary equivalents (GRAVITY_FORMS_BASE_URL, etc.) so the
   * GravityFormsClient and AuthManager work unchanged against the test site.
   *
   * Returns a shallow clone — never mutates the original config.
   *
   * @param {object} config - Raw environment config (typically process.env).
   * @returns {object} Config with test overrides applied when in test mode.
   */
  resolveEnv(config) {
    const isTest = config.GRAVITYMCP_TEST_MODE === 'true' || config.NODE_ENV === 'test';

    if (!isTest) {
      return config;
    }

    const resolved = { ...config };

    const mappings = {
      GRAVITY_FORMS_TEST_BASE_URL: 'GRAVITY_FORMS_BASE_URL',
      GRAVITY_FORMS_TEST_URL: 'GRAVITY_FORMS_BASE_URL',
      GRAVITY_FORMS_TEST_CONSUMER_KEY: 'GRAVITY_FORMS_CONSUMER_KEY',
      GRAVITY_FORMS_TEST_CONSUMER_SECRET: 'GRAVITY_FORMS_CONSUMER_SECRET',
      GRAVITY_FORMS_TEST_AUTH_METHOD: 'GRAVITY_FORMS_AUTH_METHOD',
      GRAVITY_FORMS_TEST_TIMEOUT: 'GRAVITY_FORMS_TIMEOUT',
    };

    for (const [testKey, primaryKey] of Object.entries(mappings)) {
      if (resolved[testKey]) {
        resolved[primaryKey] = resolved[testKey];
      }
    }

    return resolved;
  },
  
  /**
   * Get current environment name
   */
  getCurrentEnvironment() {
    return this.isTestMode() ? 'test' : 'live';
  },
  
  /**
   * Validate environment configuration
   */
  validateEnvironment(testMode = false) {
    try {
      const config = this.getConfig(testMode);
      
      // Check URL format
      const url = new URL(config.url);
      if (!url.protocol.startsWith('http')) {
        throw new Error('URL must use HTTP or HTTPS protocol');
      }
      
      // Check authentication
      if (config.consumer_key.length < 10 || config.consumer_secret.length < 10) {
        console.warn('Consumer key or secret seems too short. Verify your credentials.');
      }
      
      return {
        valid: true,
        environment: testMode ? 'test' : 'live',
        url: config.url,
        hasAuth: true
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        environment: testMode ? 'test' : 'live'
      };
    }
  },
  
  /**
   * Create test form name with prefix
   */
  createTestFormName(baseName) {
    const config = this.getConfig(this.isTestMode());
    return `${config.formPrefix}${baseName}`;
  },
  
  /**
   * Check if form is a test form
   */
  isTestForm(formTitle) {
    const config = this.getConfig(true);
    return formTitle.startsWith(config.formPrefix);
  },
  
  /**
   * Get cleanup configuration
   */
  getCleanupConfig() {
    const config = this.getConfig(this.isTestMode());
    return {
      enabled: config.autoCleanup,
      prefix: config.formPrefix,
      olderThanHours: 24, // Clean up test forms older than 24 hours
      keepLatest: 10 // Keep latest 10 test forms
    };
  }
};

/**
 * Test Form Manager - Helper for test form lifecycle
 */
export class TestFormManager {
  constructor(apiClient, config = testConfig) {
    this.client = apiClient;
    this.config = config;
    this.trackedForms = new Set();
  }
  
  /**
   * Create a test form with automatic tracking
   */
  async createTestForm(name, fields = []) {
    const testName = this.config.createTestFormName(name);
    
    const form = await this.client.createForm({
      title: testName,
      fields,
      is_active: true,
      description: `Automated test form created at ${new Date().toISOString()}`
    });
    
    this.trackForm(form.form.id);
    return form.form;
  }
  
  /**
   * Delete a test form
   */
  async deleteTestForm(formId) {
    try {
      await this.client.deleteForm({ 
        id: formId, 
        force: true 
      });
      this.untrackForm(formId);
      return true;
    } catch (error) {
      console.error(`Failed to delete test form ${formId}:`, error.message);
      return false;
    }
  }
  
  /**
   * Clean up all tracked test forms
   */
  async cleanupTrackedForms() {
    const cleanupPromises = Array.from(this.trackedForms).map(formId => 
      this.deleteTestForm(formId)
    );
    
    const results = await Promise.allSettled(cleanupPromises);
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.filter(r => r.status === 'rejected' || !r.value).length;
    
    return {
      succeeded,
      failed,
      total: this.trackedForms.size
    };
  }
  
  /**
   * Clean up all test forms (not just tracked)
   */
  async cleanupAllTestForms() {
    const cleanupConfig = this.config.getCleanupConfig();
    
    if (!cleanupConfig.enabled) {
      console.log('Test form cleanup is disabled');
      return { succeeded: 0, failed: 0, total: 0 };
    }
    
    // Get all forms
    const forms = await this.client.listForms();
    
    // Filter test forms
    const testForms = forms.forms.filter(form => 
      this.config.isTestForm(form.title)
    );
    
    // Sort by date created (oldest first)
    testForms.sort((a, b) => 
      new Date(a.date_created) - new Date(b.date_created)
    );
    
    // Keep latest N forms
    const formsToDelete = testForms.slice(0, -cleanupConfig.keepLatest);
    
    // Delete old test forms
    let succeeded = 0;
    let failed = 0;
    
    for (const form of formsToDelete) {
      const deleted = await this.deleteTestForm(form.id);
      if (deleted) {
        succeeded++;
      } else {
        failed++;
      }
    }
    
    return {
      succeeded,
      failed,
      total: formsToDelete.length,
      kept: cleanupConfig.keepLatest
    };
  }
  
  /**
   * Track a form for cleanup
   */
  trackForm(formId) {
    this.trackedForms.add(formId);
  }
  
  /**
   * Untrack a form
   */
  untrackForm(formId) {
    this.trackedForms.delete(formId);
  }
  
  /**
   * Get tracked forms
   */
  getTrackedForms() {
    return Array.from(this.trackedForms);
  }
}