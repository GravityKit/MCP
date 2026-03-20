/**
 * Tests for sanitization utility
 * Ensures sensitive data is properly obfuscated in logs
 */

import { TestRunner, TestAssert } from './helpers.js';
import { sanitize, sanitizeUrl, sanitizeHeaders } from '../utils/sanitize.js';

const suite = new TestRunner('Sanitization Tests');

// Test masking of sensitive keys
suite.test('Should mask consumer_key values', () => {
  const input = {
    consumer_key: 'ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e',
    other_field: 'visible'
  };

  const result = sanitize(input);
  TestAssert.equal(result.consumer_key, 'ck_****2e');
  TestAssert.equal(result.other_field, 'visible');
});

suite.test('Should mask consumer_secret values', () => {
  const input = {
    consumer_secret: 'cs_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    name: 'Test Form'
  };

  const result = sanitize(input);
  TestAssert.equal(result.consumer_secret, 'cs_****0b');
  TestAssert.equal(result.name, 'Test Form');
});

suite.test('Should mask password fields', () => {
  const input = {
    password: 'MySecretPassword123!',
    wp_password: 'WordPressPass456',
    user: 'admin'
  };

  const result = sanitize(input);
  TestAssert.equal(result.password, 'MyS****3!');
  TestAssert.equal(result.wp_password, 'Wor****56');
  TestAssert.equal(result.user, 'admin');
});

suite.test('Should mask authorization tokens', () => {
  const input = {
    authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    api_key: 'sk_test_4242424242424242',
    token: 'tok_1234567890abcdef'
  };

  const result = sanitize(input);
  TestAssert.equal(result.authorization, 'Bea****J9');
  TestAssert.equal(result.api_key, 'sk_****42');
  TestAssert.equal(result.token, 'tok****ef');
});

suite.test('Should mask OAuth signatures', () => {
  const input = {
    oauth_signature: 'tnnArxj06cWHq44gCs1OSKk/jLY=',
    oauth_token: 'token123456789',
    normal_field: 'unchanged'
  };

  const result = sanitize(input);
  TestAssert.equal(result.oauth_signature, 'tnn****Y=');
  TestAssert.equal(result.oauth_token, 'tok****89');
  TestAssert.equal(result.normal_field, 'unchanged');
});

suite.test('Should handle short sensitive values', () => {
  const input = {
    api_key: 'short',
    password: '123',
    token: ''
  };

  const result = sanitize(input);
  TestAssert.equal(result.api_key, '****');
  TestAssert.equal(result.password, '****');
  TestAssert.equal(result.token, '');
});

suite.test('Should sanitize nested objects', () => {
  const input = {
    form: {
      title: 'Contact Form',
      settings: {
        api_key: 'sk_live_123456789',
        consumer_secret: 'cs_secret_value_here'
      }
    },
    entries: [
      { id: 1, password: 'userpass' },
      { id: 2, email: 'user@example.com' }
    ]
  };

  const result = sanitize(input);
  TestAssert.equal(result.form.title, 'Contact Form');
  TestAssert.equal(result.form.settings.api_key, 'sk_****89');
  TestAssert.equal(result.form.settings.consumer_secret, 'cs_****re');
  TestAssert.equal(result.entries[0].password, '****'); // 8 chars = masked fully
  TestAssert.equal(result.entries[1].email, 'user@example.com'); // emails not masked in objects
});

suite.test('Should handle arrays correctly', () => {
  const input = [
    { consumer_key: 'ck_12345', name: 'Item 1' },
    { consumer_secret: 'cs_67890', name: 'Item 2' }
  ];

  const result = sanitize(input);
  TestAssert.equal(result[0].consumer_key, '****');
  TestAssert.equal(result[0].name, 'Item 1');
  TestAssert.equal(result[1].consumer_secret, '****');
  TestAssert.equal(result[1].name, 'Item 2');
});

// Test URL sanitization
suite.test('Should sanitize consumer keys in URLs', () => {
  const url = 'https://site.com/api?consumer_key=ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e&form_id=1';
  const result = sanitizeUrl(url);

  TestAssert.includes(result, 'consumer_key=****');
  TestAssert.includes(result, 'form_id=1');
});

suite.test('Should sanitize consumer secrets in URLs', () => {
  const url = 'https://site.com/api?consumer_secret=cs_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
  const result = sanitizeUrl(url);

  TestAssert.includes(result, 'consumer_secret=****');
});

suite.test('Should sanitize Gravity Forms keys in URLs', () => {
  const url = 'https://site.com/wp-json/gf/v2/forms?ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e';
  const result = sanitizeUrl(url);

  TestAssert.includes(result, 'ck_****');
  TestAssert.equal(result.includes('ck_3f4d5e6a'), false); // Check key is masked
});

suite.test('Should sanitize API keys and tokens in URLs', () => {
  const url = 'https://api.example.com/v1/resource?api_key=secret123&token=tok_456789&public=true';
  const result = sanitizeUrl(url);

  TestAssert.includes(result, 'api_key=****');
  TestAssert.includes(result, 'token=****');
  TestAssert.includes(result, 'public=true');
});

suite.test('Should handle URLs without sensitive data', () => {
  const url = 'https://site.com/wp-json/gf/v2/forms/1/entries?page=2&per_page=10';
  const result = sanitizeUrl(url);

  TestAssert.equal(result, url); // Should remain unchanged
});

// Test header sanitization
suite.test('Should sanitize Authorization headers', () => {
  const headers = {
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
    'Content-Type': 'application/json'
  };

  const result = sanitizeHeaders(headers);
  TestAssert.equal(result.Authorization, 'Bea****re');
  TestAssert.equal(result['Content-Type'], 'application/json');
});

suite.test('Should sanitize API key headers', () => {
  const headers = {
    'X-API-Key': 'sk_live_1234567890abcdef',
    'x-api-key': 'another_secret_key',
    'User-Agent': 'Gravity MCP/1.0'
  };

  const result = sanitizeHeaders(headers);
  TestAssert.equal(result['X-API-Key'], 'sk_****ef');
  TestAssert.equal(result['x-api-key'], 'ano****ey');
  TestAssert.equal(result['User-Agent'], 'Gravity MCP/1.0');
});

suite.test('Should sanitize Basic auth headers', () => {
  const headers = {
    'authorization': 'Basic Y2tfMTIzNDU2Nzg5MDpjc185ODc2NTQzMjEw',
    'Accept': 'application/json'
  };

  const result = sanitizeHeaders(headers);
  TestAssert.equal(result.authorization, 'Bas****Ew');
  TestAssert.equal(result.Accept, 'application/json');
});

suite.test('Should handle headers without sensitive data', () => {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Gravity MCP/1.0'
  };

  const result = sanitizeHeaders(headers);
  TestAssert.deepEqual(result, headers); // Should remain unchanged
});

// Test edge cases
suite.test('Should handle null and undefined values', () => {
  const input = {
    consumer_key: null,
    password: undefined,
    normal: 'value'
  };

  const result = sanitize(input);
  TestAssert.equal(result.consumer_key, null);
  TestAssert.equal(result.password, undefined);
  TestAssert.equal(result.normal, 'value');
});

suite.test('Should handle non-string sensitive values', () => {
  const input = {
    consumer_key: 12345,
    password: true,
    api_key: 'actual_key'
  };

  const result = sanitize(input);
  TestAssert.equal(result.consumer_key, '****'); // 5 chars = fully masked
  TestAssert.equal(result.password, '****'); // Boolean (4 chars) = fully masked
  TestAssert.equal(result.api_key, 'act****ey'); // String masked normally
});

suite.test('Should handle empty objects and arrays', () => {
  TestAssert.deepEqual(sanitize({}), {});
  TestAssert.deepEqual(sanitize([]), []);
  TestAssert.equal(sanitize(null), null);
  TestAssert.equal(sanitize(undefined), undefined);
  TestAssert.equal(sanitize('string'), 'string');
  TestAssert.equal(sanitize(123), 123);
});

// Test case sensitivity
suite.test('Should handle case variations of sensitive keys', () => {
  const input = {
    CONSUMER_KEY: 'uppercase_key',
    Consumer_Secret: 'mixed_case',
    API_KEY: 'api_uppercase',
    Password: 'cap_password'
  };

  const result = sanitize(input);
  TestAssert.equal(result.CONSUMER_KEY, 'upp****ey');
  TestAssert.equal(result.Consumer_Secret, 'mix****se');
  TestAssert.equal(result.API_KEY, 'api****se');
  TestAssert.equal(result.Password, 'cap****rd');
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  suite.run().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}

export default suite;