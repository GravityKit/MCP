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
