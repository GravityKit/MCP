/**
 * API error details must survive to the tool response for gf_* tools.
 *
 * The response interceptor standardizes every HTTP failure into an apiError
 * carrying `.status` / `.code` / `.details` (the WordPress error body). But
 * validateAndCall's catch only recognized raw axios errors (`error.response`),
 * so the standardized apiError fell through to `new Error(...)` and reached
 * wrapHandler with no status, no code, and no details — the agent lost the
 * per-parameter detail WordPress returned (the gv_* plane preserves it).
 *
 * These tests route a real HTTP failure through the REAL axios adapter path
 * (custom adapter → response interceptor → handleApiError → validateAndCall),
 * not a monkey-patched httpClient.get, so the interceptor actually runs.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';

function makeClient(status, body) {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass',
  });
  // Real axios pipeline: a custom adapter must reject non-2xx itself (axios
  // does not apply validateStatus to a resolving custom adapter). Rejecting
  // with the axios error shape routes through the response interceptor
  // (handleApiError), exactly like a live HTTP failure.
  client.httpClient.defaults.adapter = async (config) => {
    const error = new Error(body?.message || `Request failed with status code ${status}`);
    error.config = config;
    error.response = { status, statusText: 'Error', data: body, headers: {}, config };
    throw error;
  };
  return client;
}

const invalidParamBody = {
  code: 'rest_invalid_param',
  message: 'Invalid parameter(s): fields',
  data: {
    status: 400,
    params: { fields: 'fields is not of type array.' },
  },
};

test('gf_* API errors keep status/code/details through validateAndCall', async () => {
  const client = makeClient(400, invalidParamBody);

  await assert.rejects(
    () => client.getForm({ id: 1 }),
    (error) => {
      assert.equal(error.status, 400, `status must survive; got ${error.status}`);
      assert.equal(error.code, 'rest_invalid_param', `code must survive; got ${error.code}`);
      assert.deepEqual(
        error.details,
        invalidParamBody,
        'the WordPress error body must survive as error.details'
      );
      return true;
    }
  );
});

test('gf_* 404 errors keep the WordPress code and body', async () => {
  const notFoundBody = { code: 'gform_not_found', message: 'Form not found', data: { status: 404 } };
  const client = makeClient(404, notFoundBody);

  await assert.rejects(
    () => client.getForm({ id: 99999 }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'gform_not_found');
      assert.deepEqual(error.details, notFoundBody);
      return true;
    }
  );
});

test('client-side validation errors are still wrapped with the tool name', async () => {
  const client = makeClient(200, {});

  await assert.rejects(
    () => client.getForm({}),
    (error) => {
      assert.match(error.message, /^gf_get_form failed:/);
      assert.equal(error.status, undefined, 'validation errors carry no HTTP status');
      return true;
    }
  );
});
