/**
 * Both API clients must report the same User-Agent, single-sourced from
 * package.json (no per-client hardcoded version that can drift).
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import GravityFormsClient from '../src/gravity-forms-client.js';
import { WordPressClient } from '../src/wp-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const expected = `GravityKit-MCP/${pkg.version}`;

const uaOf = (client) => client.httpClient.defaults.headers['User-Agent'];
const gfClient = () => new GravityFormsClient({
  GRAVITY_FORMS_BASE_URL: 'https://example.test',
  GRAVITY_FORMS_CONSUMER_KEY: 'k',
  GRAVITY_FORMS_CONSUMER_SECRET: 's',
});
const wpClient = () => new WordPressClient({
  GRAVITYKIT_WP_URL: 'https://example.test',
  GRAVITYKIT_WP_USERNAME: 'u',
  GRAVITYKIT_WP_APP_PASSWORD: 'p',
});

test('GravityFormsClient User-Agent matches package version', () => {
  assert.equal(uaOf(gfClient()), expected);
});

test('WordPressClient User-Agent matches package version', () => {
  assert.equal(uaOf(wpClient()), expected);
});

test('both clients agree on the User-Agent', () => {
  assert.equal(uaOf(gfClient()), uaOf(wpClient()));
});
