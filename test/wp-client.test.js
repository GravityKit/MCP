/**
 * WordPressClient refuses to send Basic auth over a remote plain-HTTP URL
 * (credentials would be exposed) unless explicitly opted in — matching the
 * Gravity Forms plane's guard.
 */

import test from 'node:test';
import assert from 'node:assert';
import { WordPressClient } from '../src/wp-client.js';

const creds = { GRAVITYKIT_WP_USERNAME: 'admin', GRAVITYKIT_WP_APP_PASSWORD: 'pw' };
const make = (extra) => () => new WordPressClient({ ...creds, ...extra });

test('self-signed certs: MCP flag enables it even when GF flag is the string "false"', () => {
  const c = new WordPressClient({ ...creds, GRAVITYKIT_WP_URL: 'https://remote.example.com', GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS: 'false', MCP_ALLOW_SELF_SIGNED_CERTS: 'true' });
  assert.strictEqual(c.allowSelfSigned, true);
});

test('allows HTTPS remote URLs', () => {
  assert.doesNotThrow(make({ GRAVITYKIT_WP_URL: 'https://remote.example.com' }));
});

test('allows local plain-HTTP URLs (localhost, *.test)', () => {
  assert.doesNotThrow(make({ GRAVITYKIT_WP_URL: 'http://localhost:8892' }));
  assert.doesNotThrow(make({ GRAVITYKIT_WP_URL: 'http://mysite.test' }));
});

test('refuses Basic auth over a remote plain-HTTP URL by default', () => {
  assert.throws(make({ GRAVITYKIT_WP_URL: 'http://remote.example.com' }), /http/i);
});

test('allows remote plain-HTTP Basic when explicitly opted in', () => {
  assert.doesNotThrow(make({
    GRAVITYKIT_WP_URL: 'http://remote.example.com',
    GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH: 'true',
  }));
});

test('credentials resolve as a pair, never one source\'s user with another\'s secret', () => {
  // Resolved independently, a username set without its password silently pairs
  // with a different source's secret, and the resulting 401 reads as a wrong
  // password rather than a half-configured environment.
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:                       'https://example.test',
    GRAVITYKIT_WP_USERNAME:                  'canonical-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  const decoded = Buffer.from(c.basicAuth.replace('Basic ', ''), 'base64').toString();

  assert.strictEqual(decoded, 'local-user:local-password', 'the first COMPLETE source must win, not the first username');
});

test('a half-configured source names the half that is missing', () => {
  assert.throws(
    () => new WordPressClient({ GRAVITYKIT_WP_URL: 'https://example.test', GRAVITYKIT_WP_USERNAME: 'u' }),
    /GRAVITYKIT_WP_APP_PASSWORD/
  );
});

test('the resolved credential source is recorded, so the two planes can be told apart', () => {
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:          'https://canonical.test',
    GRAVITYKIT_WP_USERNAME:     'user',
    GRAVITYKIT_WP_APP_PASSWORD: 'password',
  });

  assert.strictEqual(c.baseUrl, 'https://canonical.test');
  assert.strictEqual(c.credentialSource, 'GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD');
});

// ---------------------------------------------------------------------------
// Which site the abilities plane resolves. The gf_* plane targets
// GRAVITY_FORMS_BASE_URL; when this plane resolves a different one, the two
// read and write different installs inside one session and no tool response
// says so.
// ---------------------------------------------------------------------------

test('the Gravity Forms target outranks the ambient local-dev URL', () => {
  const c = new WordPressClient({
    GRAVITY_FORMS_BASE_URL:     'https://staging.example.com',
    WORDPRESS_LOCAL_DEV_TEST_URL: 'https://dev.test',
    ...creds,
  });

  assert.strictEqual(c.baseUrl, 'https://staging.example.com');
});

test('the local-dev URL still answers when nothing canonical is configured', () => {
  // The control: winning the ordering by ignoring the variable would pass the
  // test above while breaking every local-dev setup that relies on it.
  const c = new WordPressClient({
    WORDPRESS_LOCAL_DEV_TEST_URL: 'https://dev.test',
    ...creds,
  });

  assert.strictEqual(c.baseUrl, 'https://dev.test');
});

test('an explicit GRAVITYKIT_WP_URL outranks the Gravity Forms target', () => {
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:      'https://wp-root.example.com',
    GRAVITY_FORMS_BASE_URL: 'https://forms.example.com',
    ...creds,
  });

  assert.strictEqual(c.baseUrl, 'https://wp-root.example.com');
});

test('the Gravity Forms credentials outrank the ambient local-dev admin', () => {
  const c = new WordPressClient({
    GRAVITY_FORMS_BASE_URL:                  'https://staging.example.com',
    GRAVITY_FORMS_CONSUMER_KEY:              'gf-user',
    GRAVITY_FORMS_CONSUMER_SECRET:           'gf-password',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  const decoded = Buffer.from(c.basicAuth.replace('Basic ', ''), 'base64').toString();

  assert.strictEqual(decoded, 'gf-user:gf-password');
  assert.strictEqual(c.credentialSource, 'GRAVITY_FORMS_CONSUMER_KEY + GRAVITY_FORMS_CONSUMER_SECRET');
});

test('a half-configured Gravity Forms pair falls through whole, to the next whole source', () => {
  // Pairing halves across sources sends a username from one site with a secret
  // from another, and the 401 reads as a wrong password.
  const c = new WordPressClient({
    GRAVITY_FORMS_BASE_URL:                  'https://staging.example.com',
    GRAVITY_FORMS_CONSUMER_KEY:              'gf-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  const decoded = Buffer.from(c.basicAuth.replace('Basic ', ''), 'base64').toString();

  assert.strictEqual(decoded, 'local-user:local-password');
});

test('the local-dev admin still answers when nothing else is configured', () => {
  const c = new WordPressClient({
    WORDPRESS_LOCAL_DEV_TEST_URL:            'https://dev.test',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  assert.strictEqual(c.credentialSource, 'WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER + WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD');
});

test('a generic WP_USERNAME outranks the local-dev admin', () => {
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:                       'https://example.test',
    WP_USERNAME:                             'wp-user',
    WP_APP_PASSWORD:                         'wp-password',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  assert.strictEqual(c.credentialSource, 'WP_USERNAME + WP_APP_PASSWORD');
});

test('two planes on one host report no split', () => {
  const c = new WordPressClient({
    GRAVITY_FORMS_BASE_URL: 'https://staging.example.com',
    ...creds,
  });

  assert.strictEqual(c.gravityFormsBaseUrl, 'https://staging.example.com');
  assert.strictEqual(c.hostMismatch, null);
});

test('a WordPress root under the Gravity Forms host is not a split', () => {
  // The documented reason to set GRAVITYKIT_WP_URL: a subdirectory install. Both
  // planes still act on one site, so warning here would train the warning away.
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:      'https://example.com/wp',
    GRAVITY_FORMS_BASE_URL: 'https://example.com',
    ...creds,
  });

  assert.strictEqual(c.hostMismatch, null);
});

test('two planes on different hosts name both sites', () => {
  const c = new WordPressClient({
    GRAVITYKIT_WP_URL:      'https://dev.test',
    GRAVITY_FORMS_BASE_URL: 'https://staging.example.com',
    ...creds,
  });

  assert.deepStrictEqual(c.hostMismatch, {
    abilities_site:      'https://dev.test',
    gravity_forms_site:  'https://staging.example.com',
  });
});

test('test mode sends both planes to the same test site', () => {
  // The Gravity Forms client resolves its target through testConfig.resolveEnv,
  // which remaps GRAVITY_FORMS_TEST_* onto the primary names. Reading raw env
  // here instead left this plane on whatever the ambient local-dev vars named.
  const c = new WordPressClient({
    GRAVITYKIT_MCP_TEST_MODE:                'true',
    GRAVITY_FORMS_TEST_BASE_URL:             'https://test-site.example.com',
    GRAVITY_FORMS_TEST_CONSUMER_KEY:         'test-user',
    GRAVITY_FORMS_TEST_CONSUMER_SECRET:      'test-password',
    WORDPRESS_LOCAL_DEV_TEST_URL:            'https://dev.test',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER:     'local-user',
    WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD: 'local-password',
  });

  const decoded = Buffer.from(c.basicAuth.replace('Basic ', ''), 'base64').toString();

  assert.strictEqual(c.baseUrl, 'https://test-site.example.com');
  assert.strictEqual(decoded, 'test-user:test-password');
  assert.strictEqual(c.hostMismatch, null);
});
