/**
 * Unit tests for the behavior helpers in helpers.js
 * (isMainModule, feedUnavailable, settleWithReport).
 */

import test from 'node:test';
import assert from 'node:assert';
import { isMainModule, feedUnavailable, settleWithReport } from './helpers.js';

// --- isMainModule ---

test('isMainModule: matches a forward-slash argv path', () => {
  assert.equal(isMainModule('file:///a/b/auth.test.js', '/a/b/auth.test.js'), true);
});

test('isMainModule: matches a Windows backslash argv path', () => {
  assert.equal(isMainModule('file:///C:/a/b/auth.test.js', 'C:\\a\\b\\auth.test.js'), true);
});

test('isMainModule: false when the basename differs', () => {
  assert.equal(isMainModule('file:///a/b/auth.test.js', '/a/b/run.js'), false);
});

test('isMainModule: false when argv is missing', () => {
  assert.equal(isMainModule('file:///a/b/auth.test.js', undefined), false);
});

// --- feedUnavailable ---

const UNAVAILABLE = [
  'gf_create_feed failed: The wp_gf_addon_feed table does not exist.',
  'addon_slug gravityformsmailchimp is not registered',
  'Feed add-on not active',
  'The gravityformsmailchimp Add-On is not installed',
];
for (const msg of UNAVAILABLE) {
  test(`feedUnavailable: skips unavailable message — "${msg}"`, () => {
    assert.equal(feedUnavailable(msg), true);
  });
}

const GENUINE = ['Invalid feed meta', 'Validation error: feedName is required', ''];
for (const msg of GENUINE) {
  test(`feedUnavailable: re-throws genuine error — "${msg}"`, () => {
    assert.equal(feedUnavailable(msg), false);
  });
}

// --- settleWithReport ---

test('settleWithReport: reports the error and resolves on rejection', async () => {
  let reported = null;
  const result = await settleWithReport(Promise.reject(new Error('boom')), (e) => { reported = e.message; });
  assert.equal(reported, 'boom');
  assert.equal(result, undefined);
});

test('settleWithReport: returns the value and does not report on success', async () => {
  let reported = false;
  const result = await settleWithReport(Promise.resolve(42), () => { reported = true; });
  assert.equal(result, 42);
  assert.equal(reported, false);
});
