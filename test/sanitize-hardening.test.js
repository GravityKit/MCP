/**
 * Adversarial / edge-case hardening tests for src/utils/sanitize.js
 *
 * These pin two confirmed credential-leak bugs:
 *   1. [P2] sanitize() leaks common secret field names (secret, client_secret,
 *      private_key, stripe_secret_key, webhook_secret, password) because the
 *      SENSITIVE_KEYS match was `keyLower.includes(longToken)` instead of
 *      `keyLower.includes(shortToken)`.
 *   2. [P3] sanitizeUrl() does not mask oauth_signature (the OAuth crypto
 *      credential) nor any oauth_* secret query value, and does not redact
 *      HTTP Basic userinfo (user:pass@host) in the authority.
 *
 * Plus regression coverage proving the already-handled cases still behave.
 *
 * node:test style — run directly: node --test test/sanitize-hardening.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeUrl } from '../src/utils/sanitize.js';

// A value long enough that mask() returns the "abc****yz" form, so we can
// assert the full value never survives anywhere.
const SECRET_VALUE = 'PLAINTEXT-DO-NOT-LEAK-0123456789abcdef';

function assertMasked(actual, original) {
  assert.notEqual(actual, original, `value should be masked, got raw: ${actual}`);
  assert.ok(
    !String(actual).includes(original),
    `masked value must not contain the original secret (got: ${actual})`
  );
  assert.ok(String(actual).includes('****'), `masked value should contain '****' (got: ${actual})`);
}

// ---------------------------------------------------------------------------
// Bug 1 [P2] — sanitize() must mask common secret field names in full
// ---------------------------------------------------------------------------

test('sanitize(): masks common secret field names that previously leaked', () => {
  const leakyKeys = [
    'secret',
    'client_secret',
    'private_key',
    'stripe_secret_key',
    'webhook_secret',
    'password',
  ];

  for (const key of leakyKeys) {
    const result = sanitize({ [key]: SECRET_VALUE });
    assertMasked(result[key], SECRET_VALUE);
  }
});

test('sanitize(): also masks app_password / passwd / credential / authorization', () => {
  const input = {
    app_password: SECRET_VALUE,
    passwd: SECRET_VALUE,
    credential: SECRET_VALUE,
    db_credentials: SECRET_VALUE,
    authorization: SECRET_VALUE,
  };
  const result = sanitize(input);
  assertMasked(result.app_password, SECRET_VALUE);
  assertMasked(result.passwd, SECRET_VALUE);
  assertMasked(result.credential, SECRET_VALUE);
  assertMasked(result.db_credentials, SECRET_VALUE);
  assertMasked(result.authorization, SECRET_VALUE);
});

test('sanitize(): REGRESSION — previously-masked keys still masked', () => {
  const input = {
    consumer_key: 'ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e',
    consumer_secret: 'cs_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    api_key: 'sk_test_4242424242424242',
    token: 'tok_1234567890abcdef',
    oauth_signature: 'tnnArxj06cWHq44gCs1OSKk/jLY=',
    oauth_token: 'token123456789',
  };
  const result = sanitize(input);
  assert.equal(result.consumer_key, 'ck_****2e');
  assert.equal(result.consumer_secret, 'cs_****0b');
  assert.equal(result.api_key, 'sk_****42');
  assert.equal(result.token, 'tok****ef');
  assert.equal(result.oauth_signature, 'tnn****Y=');
  assert.equal(result.oauth_token, 'tok****89');
});

test('sanitize(): does NOT over-mask innocuous keys (no bare "key" token)', () => {
  const input = {
    description: 'A perfectly fine description value',
    key: 'plain-key-name-not-sensitive',
    name: 'Contact Form',
    created: '2026-06-16',
    updated: '2026-06-16',
    public_id: 'abc123',
  };
  const result = sanitize(input);
  assert.equal(result.description, input.description);
  assert.equal(result.key, input.key);
  assert.equal(result.name, input.name);
  assert.equal(result.created, input.created);
  assert.equal(result.updated, input.updated);
  assert.equal(result.public_id, input.public_id);
});

test('sanitize(): masks leaky secret keys nested deep in objects/arrays', () => {
  const input = {
    config: { stripe: { stripe_secret_key: SECRET_VALUE } },
    creds: [{ client_secret: SECRET_VALUE }, { password: SECRET_VALUE }],
  };
  const result = sanitize(input);
  assertMasked(result.config.stripe.stripe_secret_key, SECRET_VALUE);
  assertMasked(result.creds[0].client_secret, SECRET_VALUE);
  assertMasked(result.creds[1].password, SECRET_VALUE);
});

// ---------------------------------------------------------------------------
// Bug 2 [P3] — sanitizeUrl() must mask oauth_* and Basic userinfo
// ---------------------------------------------------------------------------

test('sanitizeUrl(): masks oauth_signature query value', () => {
  const url =
    'https://site.com/wp-json/gf/v2/forms?oauth_signature=tnnArxj06cWHq44gCs1OSKk%2FjLY%3D&form_id=1';
  const result = sanitizeUrl(url);
  assert.ok(result.includes('oauth_signature=****'), `got: ${result}`);
  assert.ok(!result.includes('tnnArxj06cWHq44gCs1OSKk'), `signature leaked: ${result}`);
  assert.ok(result.includes('form_id=1'), 'non-secret param preserved');
});

test('sanitizeUrl(): masks all oauth_* secret query values', () => {
  const url =
    'https://site.com/api?oauth_consumer_key=ckabc123&oauth_token=tokabc123&oauth_nonce=noncexyz&oauth_signature=SIGabc123';
  const result = sanitizeUrl(url);
  assert.ok(result.includes('oauth_consumer_key=****'), `got: ${result}`);
  assert.ok(result.includes('oauth_token=****'), `got: ${result}`);
  assert.ok(result.includes('oauth_nonce=****'), `got: ${result}`);
  assert.ok(result.includes('oauth_signature=****'), `got: ${result}`);
  assert.ok(!result.includes('SIGabc123'), `signature leaked: ${result}`);
  assert.ok(!result.includes('tokabc123'), `token leaked: ${result}`);
});

test('sanitizeUrl(): redacts HTTP Basic userinfo (user:pass@host)', () => {
  const url = 'http://admin:supersecretpw@example.com/wp-json/gf/v2/forms?form_id=1';
  const result = sanitizeUrl(url);
  assert.ok(!result.includes('supersecretpw'), `password leaked in userinfo: ${result}`);
  assert.ok(result.includes('@example.com'), `host must be preserved: ${result}`);
  assert.ok(result.includes('form_id=1'), 'query preserved');
});

test('sanitizeUrl(): redacts userinfo for https too', () => {
  const url = 'https://ck_user:cs_pass1234@site.com/wp-json/gf/v2/entries';
  const result = sanitizeUrl(url);
  assert.ok(!result.includes('cs_pass1234'), `password leaked: ${result}`);
  assert.ok(result.includes('@site.com'), `host preserved: ${result}`);
});

test('sanitizeUrl(): REGRESSION — existing masking still works', () => {
  const ckUrl =
    'https://site.com/api?consumer_key=ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e&form_id=1';
  const ckResult = sanitizeUrl(ckUrl);
  assert.ok(ckResult.includes('consumer_key=****'), `got: ${ckResult}`);
  assert.ok(ckResult.includes('form_id=1'));

  const gfKeyUrl =
    'https://site.com/wp-json/gf/v2/forms?ck_3f4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e';
  const gfKeyResult = sanitizeUrl(gfKeyUrl);
  assert.ok(gfKeyResult.includes('ck_****'), `got: ${gfKeyResult}`);
  assert.ok(!gfKeyResult.includes('ck_3f4d5e6a'), `key leaked: ${gfKeyResult}`);

  const mixedUrl =
    'https://api.example.com/v1/resource?api_key=secret123&token=tok_456789&public=true';
  const mixedResult = sanitizeUrl(mixedUrl);
  assert.ok(mixedResult.includes('api_key=****'), `got: ${mixedResult}`);
  assert.ok(mixedResult.includes('token=****'), `got: ${mixedResult}`);
  assert.ok(mixedResult.includes('public=true'), 'non-secret param preserved');
});

test('sanitizeUrl(): leaves clean URLs untouched', () => {
  const url = 'https://site.com/wp-json/gf/v2/forms/1/entries?page=2&per_page=10';
  assert.equal(sanitizeUrl(url), url);
});
