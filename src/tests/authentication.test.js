/**
 * Authentication Tests for Gravity MCP
 * Tests Basic Auth (primary) and OAuth 1.0a (secondary) authentication methods
 */

import { AuthManager, BasicAuthHandler, OAuth1Handler, validateRestApiAccess } from '../config/auth.js';
import { TestRunner, TestAssert, MockHttpClient, MockResponse, setupTestEnvironment } from './helpers.js';

const suite = new TestRunner('Authentication Tests');

// Test environment
let testEnv;
let mockHttpClient;

suite.beforeEach(() => {
  testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();
});

// =================================
// BASIC AUTHENTICATION TESTS
// =================================

suite.test('Basic Auth: Should create BasicAuthHandler with valid HTTPS URL', () => {
  const handler = new BasicAuthHandler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  TestAssert.isNotNull(handler);
  TestAssert.equal(handler.consumerKey, 'ck_test_key');
  TestAssert.equal(handler.consumerSecret, 'cs_test_secret');
});

suite.test('Basic Auth: Should reject HTTP URLs for security', () => {
  TestAssert.throws(
    () => new BasicAuthHandler('key', 'secret', 'http://insecure.com'),
    'HTTPS connection',
    'Should require HTTPS for Basic Auth'
  );
});

suite.test('Basic Auth: Should generate correct Authorization header', () => {
  const handler = new BasicAuthHandler('ck_test', 'cs_secret', 'https://example.com');
  const headers = handler.getAuthHeaders();

  const expectedAuth = Buffer.from('ck_test:cs_secret').toString('base64');
  TestAssert.equal(headers.Authorization, `Basic ${expectedAuth}`);
  TestAssert.equal(headers['Content-Type'], 'application/json');
});

suite.test('Basic Auth: Should test connection successfully', async () => {
  const handler = new BasicAuthHandler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isTrue(result.success);
  TestAssert.equal(result.method, 'Basic Authentication');
  TestAssert.includes(result.message, 'Successfully connected');
});

suite.test('Basic Auth: Should handle invalid credentials (401)', async () => {
  const handler = new BasicAuthHandler('invalid_key', 'invalid_secret', 'https://example.com');

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Invalid credentials' },
    401
  ));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isFalse(result.success);
  TestAssert.equal(result.error, 'Invalid credentials');
});

// =================================
// OAUTH 1.0a AUTHENTICATION TESTS
// =================================

suite.test('OAuth 1.0a: Should create OAuth1Handler with any URL', () => {
  const handler = new OAuth1Handler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    'http://example.com' // OAuth works over HTTP
  );

  TestAssert.isNotNull(handler);
  TestAssert.equal(handler.consumerKey, 'ck_test_key');
});

suite.test('OAuth 1.0a: Should generate valid OAuth signature', () => {
  const handler = new OAuth1Handler('ck_test', 'cs_secret', 'https://example.com');

  const signature = handler.generateOAuthSignature(
    'GET',
    'https://example.com/wp-json/gf/v2/forms',
    { per_page: 10 },
    '1234567890',
    'test_nonce'
  );

  TestAssert.isNotNull(signature);
  TestAssert.isTrue(signature.length > 0);
});

suite.test('OAuth 1.0a: Should generate correct OAuth headers', () => {
  const handler = new OAuth1Handler('ck_test', 'cs_secret', 'https://example.com');
  const headers = handler.getAuthHeaders('GET', 'https://example.com/wp-json/gf/v2/forms');

  TestAssert.includes(headers.Authorization, 'OAuth');
  TestAssert.includes(headers.Authorization, 'oauth_consumer_key');
  TestAssert.includes(headers.Authorization, 'oauth_signature');
  TestAssert.includes(headers.Authorization, 'oauth_nonce');
  TestAssert.includes(headers.Authorization, 'oauth_timestamp');
});

suite.test('OAuth 1.0a: Should test connection successfully', async () => {
  const handler = new OAuth1Handler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isTrue(result.success);
  TestAssert.equal(result.method, 'OAuth 1.0a');
});

// =================================
// AUTH MANAGER TESTS
// =================================

suite.test('AuthManager: Should validate required environment variables', () => {
  const invalidConfig = {};

  TestAssert.throws(
    () => new AuthManager(invalidConfig),
    'Missing required environment variables',
    'Should require all environment variables'
  );
});

suite.test('AuthManager: Should validate base URL format', () => {
  const invalidConfig = {
    GRAVITY_FORMS_CONSUMER_KEY: 'key',
    GRAVITY_FORMS_CONSUMER_SECRET: 'secret',
    GRAVITY_FORMS_BASE_URL: 'not-a-url'
  };

  TestAssert.throws(
    () => new AuthManager(invalidConfig),
    'must start with http',
    'Should require valid URL'
  );
});

suite.test('AuthManager: Should default to Basic Auth (recommended)', () => {
  const manager = new AuthManager(testEnv);
  const info = manager.getAuthInfo();

  TestAssert.equal(info.method, 'Basic Authentication');
  TestAssert.isTrue(info.recommended);
  TestAssert.isTrue(info.secure);
});

suite.test('AuthManager: Should use OAuth when specified', () => {
  const config = {
    ...testEnv,
    GRAVITY_FORMS_AUTH_METHOD: 'oauth'
  };

  const manager = new AuthManager(config);
  const info = manager.getAuthInfo();

  TestAssert.equal(info.method, 'OAuth 1.0a');
  TestAssert.isFalse(info.recommended);
});

suite.test('AuthManager: remote HTTP with default method falls back to OAuth', () => {
  const config = {
    ...testEnv,
    GRAVITY_FORMS_BASE_URL: 'http://insecure.com'
  };
  delete config.GRAVITY_FORMS_AUTH_METHOD;

  const manager = new AuthManager(config);
  const info = manager.getAuthInfo();

  TestAssert.equal(info.method, 'OAuth 1.0a');
  TestAssert.isFalse(info.secure);
});

suite.test('AuthManager: explicit basic is honored over remote HTTP', () => {
  const config = {
    ...testEnv,
    GRAVITY_FORMS_BASE_URL: 'http://insecure.com',
    GRAVITY_FORMS_AUTH_METHOD: 'basic'
  };

  const manager = new AuthManager(config);
  const info = manager.getAuthInfo();

  TestAssert.equal(info.method, 'Basic Authentication');
  TestAssert.isFalse(info.secure);
});

suite.test('AuthManager: ck_/cs_ key pair over HTTP auto-selects OAuth (GF only checks key Basic over SSL)', () => {
  for (const baseUrl of ['http://localhost:8893', 'http://dev.test', 'http://remote.example.com']) {
    const config = { ...testEnv, GRAVITY_FORMS_BASE_URL: baseUrl };
    delete config.GRAVITY_FORMS_AUTH_METHOD; // ck_test_key / cs_test_secret from testEnv

    const manager = new AuthManager(config);
    const info = manager.getAuthInfo();

    TestAssert.equal(info.method, 'OAuth 1.0a', `${baseUrl} with a key pair should sign with OAuth`);
  }
});

suite.test('AuthManager: app-password credentials get Basic on local HTTP (WP core auth path)', () => {
  for (const baseUrl of ['http://localhost:8893', 'http://dev.test', 'http://127.0.0.1:8080', 'http://mysite.local']) {
    const config = {
      ...testEnv,
      GRAVITY_FORMS_BASE_URL: baseUrl,
      GRAVITY_FORMS_CONSUMER_KEY: 'admin',
      GRAVITY_FORMS_CONSUMER_SECRET: 'abcd efgh ijkl mnop qrst uvwx'
    };
    delete config.GRAVITY_FORMS_AUTH_METHOD;

    const manager = new AuthManager(config);
    const info = manager.getAuthInfo();

    TestAssert.equal(info.method, 'Basic Authentication', `${baseUrl} with app-password creds should use Basic`);
  }
});

suite.test('AuthManager: Should remove trailing slash from base URL', () => {
  const config = {
    ...testEnv,
    GRAVITY_FORMS_BASE_URL: 'https://example.com/'
  };

  const manager = new AuthManager(config);
  TestAssert.equal(manager.config.GRAVITY_FORMS_BASE_URL, 'https://example.com');
});

// =================================
// REST API VALIDATION TESTS
// =================================

suite.test('REST API Validation: Should validate full API access', async () => {
  const manager = new AuthManager(testEnv);

  // Mock successful responses for all endpoints
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse({ entries: [] }));
  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse({ feeds: [] }));

  const validation = await validateRestApiAccess(mockHttpClient, manager);

  TestAssert.isTrue(validation.available);
  TestAssert.isTrue(validation.fullAccess);
  TestAssert.equal(validation.coverage, '3/3');
  TestAssert.includes(validation.message, 'Full REST API access confirmed');
});

suite.test('REST API Validation: Should handle partial access', async () => {
  const manager = new AuthManager(testEnv);

  // Mock mixed responses
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
  mockHttpClient.setMockResponse('GET', '/entries', new MockResponse(
    { message: 'Forbidden' },
    403
  ));
  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse({ feeds: [] }));

  const validation = await validateRestApiAccess(mockHttpClient, manager);

  TestAssert.isTrue(validation.available);
  TestAssert.isFalse(validation.fullAccess);
  TestAssert.equal(validation.coverage, '2/3');
  TestAssert.includes(validation.message, 'Partial access');
});

suite.test('REST API Validation: Should handle authentication failure', async () => {
  const manager = new AuthManager(testEnv);

  // Mock auth failure
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Invalid credentials' },
    401
  ));

  const validation = await validateRestApiAccess(mockHttpClient, manager);

  TestAssert.isFalse(validation.available);
  TestAssert.equal(validation.error, 'Authentication failed');
});

// =================================
// EDGE CASES AND FAILURE MODES
// =================================

suite.test('Edge Case: Should handle network timeouts', async () => {
  const handler = new BasicAuthHandler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  // Simulate network error
  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Network timeout' },
    0
  ));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isFalse(result.success);
});

suite.test('Edge Case: Should handle rate limiting (429)', async () => {
  const handler = new BasicAuthHandler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Rate limit exceeded' },
    429
  ));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isFalse(result.success);
});

suite.test('Edge Case: Should handle server errors (500)', async () => {
  const handler = new BasicAuthHandler(
    testEnv.GRAVITY_FORMS_CONSUMER_KEY,
    testEnv.GRAVITY_FORMS_CONSUMER_SECRET,
    testEnv.GRAVITY_FORMS_BASE_URL
  );

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse(
    { message: 'Internal server error' },
    500
  ));

  const result = await handler.testConnection(mockHttpClient);
  TestAssert.isFalse(result.success);
});

suite.test('Failure Mode: Should handle malformed OAuth signature', () => {
  const handler = new OAuth1Handler('', '', 'https://example.com');

  TestAssert.throws(
    () => handler.generateOAuthSignature('GET', '', {}, '', ''),
    null,
    'Should handle empty parameters'
  );
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
suite.run().then(results => {
  process.exit(results.failed > 0 ? 1 : 0);
});

}

export default suite;