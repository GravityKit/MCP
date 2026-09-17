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
