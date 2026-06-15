/**
 * Test Helpers and Utilities for Gravity MCP
 * Provides mock data, test utilities, and common test functions
 */

import crypto from 'crypto';

/**
 * Generate random ID
 */
export function generateId() {
  return Math.floor(Math.random() * 10000) + 1;
}

/**
 * Generate random string
 */
export function generateString(prefix = 'test') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generate mock form data
 */
export function generateMockForm(overrides = {}) {
  return {
    id: generateId(),
    title: generateString('Test Form'),
    description: 'This is a test form description',
    fields: [
      {
        id: 1,
        type: 'text',
        label: 'Name',
        isRequired: true
      },
      {
        id: 2,
        type: 'email',
        label: 'Email',
        isRequired: true
      },
      {
        id: 3,
        type: 'textarea',
        label: 'Message',
        isRequired: false
      }
    ],
    button: {
      type: 'text',
      text: 'Submit'
    },
    is_active: true,
    date_created: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Generate mock entry data
 */
export function generateMockEntry(formId = 1, overrides = {}) {
  return {
    id: generateId(),
    form_id: formId,
    '1': 'John Doe',
    '2': 'john@example.com',
    '3': 'This is a test message',
    status: 'active',
    created_by: 1,
    date_created: new Date().toISOString(),
    source_url: 'https://example.com/contact',
    ip: '127.0.0.1',
    ...overrides
  };
}

/**
 * Generate mock feed data
 */
export function generateMockFeed(formId = 1, addonSlug = 'gravityformsmailchimp', overrides = {}) {
  return {
    id: generateId(),
    form_id: formId,
    addon_slug: addonSlug,
    is_active: true,
    meta: {
      feedName: generateString('Test Feed'),
      mailchimpList: 'abc123',
      mappedFields_EMAIL: '2',
      mappedFields_FNAME: '1.3',
      mappedFields_LNAME: '1.6',
      double_optin: '1',
      ...overrides.meta
    },
    ...overrides
  };
}

/**
 * Generate mock notification data
 */
export function generateMockNotification(overrides = {}) {
  return {
    id: generateString('notification'),
    name: 'Admin Notification',
    to: 'admin@example.com',
    subject: 'New Form Submission',
    message: 'You have a new form submission.',
    from: 'noreply@example.com',
    fromName: 'Example Site',
    isActive: true,
    ...overrides
  };
}

/**
 * Generate field filter data
 */
export function generateFieldFilter(fieldId = '1', value = 'test', operator = 'CONTAINS') {
  return {
    key: String(fieldId),
    value: String(value),
    operator: operator
  };
}

/**
 * Generate search parameters
 */
export function generateSearchParams(filters = [], mode = 'all') {
  return {
    field_filters: filters.length > 0 ? filters : [generateFieldFilter()],
    mode: mode
  };
}

/**
 * Generate paging parameters
 */
export function generatePagingParams(pageSize = 20, currentPage = 1) {
  return {
    page_size: pageSize,
    current_page: currentPage
  };
}

/**
 * Generate sorting parameters
 */
export function generateSortingParams(key = 'date_created', direction = 'desc') {
  return {
    key: key,
    direction: direction
  };
}

/**
 * Mock HTTP Response
 */
export class MockResponse {
  constructor(data = {}, status = 200, headers = {}) {
    this.data = data;
    this.status = status;
    this.headers = {
      'x-wp-total': '100',
      'x-wp-totalpages': '5',
      ...headers
    };
  }
}

/**
 * Mock HTTP Client
 */
export class MockHttpClient {
  constructor() {
    this.requests = [];
    this.responses = new Map();
    this.defaultResponse = new MockResponse();
    this.defaults = { baseURL: 'https://test.example.com' };
  }

  /**
   * Set mock response for a specific endpoint
   */
  setMockResponse(method, path, response) {
    const key = `${method.toUpperCase()}:${path}`;
    this.responses.set(key, response);
  }

  /**
   * Set default response for all unmatched requests
   */
  setDefaultResponse(response) {
    this.defaultResponse = response;
  }

  /**
   * Mock GET request
   */
  async get(path, config = {}) {
    return this._handleRequest('GET', path, config);
  }

  /**
   * Mock POST request
   */
  async post(path, data = {}, config = {}) {
    return this._handleRequest('POST', path, { ...config, data });
  }

  /**
   * Mock PUT request
   */
  async put(path, data = {}, config = {}) {
    return this._handleRequest('PUT', path, { ...config, data });
  }

  /**
   * Mock PATCH request
   */
  async patch(path, data = {}, config = {}) {
    return this._handleRequest('PATCH', path, { ...config, data });
  }

  /**
   * Mock DELETE request
   */
  async delete(path, config = {}) {
    return this._handleRequest('DELETE', path, config);
  }

  /**
   * Handle mock request
   */
  async _handleRequest(method, path, config) {
    // Record request
    this.requests.push({ method, path, config });

    // Get mock response
    const key = `${method}:${path}`;
    const response = this.responses.get(key) || this.defaultResponse;

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Return response or throw error
    if (response.status >= 400 || response.status === 0) {
      const error = new Error(response.data.message || 'Request failed');
      error.response = response;
      throw error;
    }

    return response;
  }

  /**
   * Get all recorded requests
   */
  getRequests() {
    return this.requests;
  }

  /**
   * Clear recorded requests
   */
  clearRequests() {
    this.requests = [];
  }

  /**
   * Check if a specific request was made
   */
  hasRequest(method, path) {
    return this.requests.some(req =>
      req.method === method && req.path === path
    );
  }
}

/**
 * Test Environment Setup
 */
export function setupTestEnvironment() {
  return {
    GRAVITY_FORMS_CONSUMER_KEY: 'ck_test_key',
    GRAVITY_FORMS_CONSUMER_SECRET: 'cs_test_secret',
    GRAVITY_FORMS_BASE_URL: 'https://test.example.com',
    GRAVITY_FORMS_ALLOW_DELETE: 'true',
    GRAVITY_FORMS_AUTH_METHOD: 'basic',
    GRAVITY_FORMS_DEBUG: 'false',
    GRAVITY_FORMS_TIMEOUT: '5000'
  };
}

/**
 * Assert helper for tests
 */
export class TestAssert {
  static equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
  }

  static notEqual(actual, expected, message) {
    if (actual === expected) {
      throw new Error(message || `Expected values to be different, but both are ${actual}`);
    }
  }

  static deepEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message || `Objects are not equal`);
    }
  }

  static isTrue(value, message) {
    if (value !== true) {
      throw new Error(message || `Expected true, got ${value}`);
    }
  }

  static isFalse(value, message) {
    if (value !== false) {
      throw new Error(message || `Expected false, got ${value}`);
    }
  }

  static isNull(value, message) {
    if (value !== null) {
      throw new Error(message || `Expected null, got ${value}`);
    }
  }

  static isNotNull(value, message) {
    if (value === null) {
      throw new Error(message || `Expected non-null value`);
    }
  }

  static throws(fn, expectedError, message) {
    let threw = false;
    let actualError = null;

    try {
      fn();
    } catch (error) {
      threw = true;
      actualError = error;
    }

    if (!threw) {
      throw new Error(message || 'Expected function to throw');
    }

    if (expectedError && !actualError.message.includes(expectedError)) {
      throw new Error(message || `Expected error containing "${expectedError}", got "${actualError.message}"`);
    }
  }

  static async throwsAsync(fn, expectedError, message) {
    let threw = false;
    let actualError = null;

    try {
      await fn();
    } catch (error) {
      threw = true;
      actualError = error;
    }

    if (!threw) {
      throw new Error(message || 'Expected async function to throw');
    }

    if (expectedError && !actualError.message.includes(expectedError)) {
      throw new Error(message || `Expected error containing "${expectedError}", got "${actualError.message}"`);
    }
  }

  static includes(array, item, message) {
    if (!array.includes(item)) {
      throw new Error(message || `Array does not include ${item}`);
    }
  }

  static lengthOf(array, length, message) {
    if (array.length !== length) {
      throw new Error(message || `Expected array length ${length}, got ${array.length}`);
    }
  }

  static exists(value, message) {
    if (value === undefined || value === null) {
      throw new Error(message || `Expected value to exist, got ${value}`);
    }
  }
}

/**
 * Wait utility for async tests
 */
export async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry utility for eventually consistent operations
 */
export async function retry(fn, times = 3, delay = 100) {
  let lastError;

  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < times - 1) {
        await wait(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Test Suite Runner
 */
export class TestRunner {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.beforeEachFn = null;
    this.afterEachFn = null;
    this.beforeAllFn = null;
    this.afterAllFn = null;
  }

  beforeAll(fn) {
    this.beforeAllFn = fn;
  }

  afterAll(fn) {
    this.afterAllFn = fn;
  }

  beforeEach(fn) {
    this.beforeEachFn = fn;
  }

  afterEach(fn) {
    this.afterEachFn = fn;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log(`\n🧪 Running ${this.name}`);
    console.log('='.repeat(50));

    let passed = 0;
    let failed = 0;
    const failures = [];

    // Run beforeAll
    if (this.beforeAllFn) {
      try {
        await this.beforeAllFn();
      } catch (error) {
        console.error('❌ beforeAll failed:', error.message);
        return { passed: 0, failed: this.tests.length };
      }
    }

    // Run tests
    for (const test of this.tests) {
      try {
        // Run beforeEach
        if (this.beforeEachFn) {
          await this.beforeEachFn();
        }

        // Run test
        await test.fn();

        console.log(`✅ ${test.name}`);
        passed++;

        // Run afterEach
        if (this.afterEachFn) {
          await this.afterEachFn();
        }
      } catch (error) {
        console.log(`❌ ${test.name}`);
        console.error(`   ${error.message}`);
        failed++;
        failures.push({ test: test.name, error: error.message });
      }
    }

    // Run afterAll
    if (this.afterAllFn) {
      try {
        await this.afterAllFn();
      } catch (error) {
        console.error('❌ afterAll failed:', error.message);
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach(f => {
        console.log(`  - ${f.test}: ${f.error}`);
      });
    }

    return { passed, failed, failures };
  }
}

export default {
  generateId,
  generateString,
  generateMockForm,
  generateMockEntry,
  generateMockFeed,
  generateMockNotification,
  generateFieldFilter,
  generateSearchParams,
  generatePagingParams,
  generateSortingParams,
  MockResponse,
  MockHttpClient,
  setupTestEnvironment,
  TestAssert,
  wait,
  retry,
  TestRunner
};