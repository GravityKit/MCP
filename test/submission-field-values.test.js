/**
 * field_values is refused on the submission tools: it populates nothing on the
 * API path, in any shape. See the field_values comment in validation.js for the
 * Gravity Forms and WordPress code this rests on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { ValidationFactory } from '../src/config/validation.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// src/index.js starts the stdio server on import, so read the tool array as text
// (a pure literal, closed by the first `];` at column 0) and evaluate only that.
function getToolDefinitions() {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js'), 'utf8');
  const start = source.indexOf('const GF_TOOL_DEFINITIONS = ');
  const end = source.indexOf('\n];', start);
  assert.ok(start !== -1 && end !== -1, 'GF_TOOL_DEFINITIONS literal not found');
  return Function(`"use strict"; return (${source.slice(start + 'const GF_TOOL_DEFINITIONS = '.length, end + 2)});`)();
}

const validate = (tool, input) => ValidationFactory.validateToolInput(tool, input);

function makeClient(routes = {}) {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass'
  });
  const requests = [];
  const answer = (method) => async (path, data) => {
    const body = method === 'GET' ? undefined : data;
    requests.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    return { data: typeof route === 'function' ? route(body) : route, headers: {} };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  return { client, requests };
}

// --- 3. field_values --------------------------------------------------------

for (const tool of ['gf_submit_form_data', 'gf_validate_submission', 'gf_validate_form']) {
  test(`${tool} refuses every shape of field_values and points at input_N`, () => {
    for (const value of ['p1=a&p2=b', '', 'x', ['a'], [], { p1: 'a' }, '{"1":"x"}']) {
      assert.throws(
        () => validate(tool, { form_id: 1, input_1: 'Ada', field_values: value }),
        (error) => {
          assert.match(error.message, /field_values/);
          assert.match(error.message, /does nothing/);
          assert.match(error.message, /input_N/);
          return true;
        },
        `${JSON.stringify(value)} must be refused`
      );
    }
  });
}

test('field_values is not in any submission tool schema', () => {
  const tools = getToolDefinitions();
  for (const name of ['gf_submit_form_data', 'gf_validate_submission', 'gf_validate_form']) {
    const tool = tools.find((t) => t.name === name);
    assert.equal('field_values' in tool.inputSchema.properties, false, `${name} must not advertise field_values`);
    assert.match(tool.description, /field_values. is refused/, `${name} description says it is refused`);
  }
});

test('a submission without field_values is unaffected', async () => {
  const { client, requests } = makeClient({
    'GET /forms/1': { id: 1, fields: [{ id: 1, type: 'text' }] },
    'POST /forms/1/submissions': { is_valid: true, entry_id: 5 }
  });
  await client.submitFormData({ form_id: 1, input_1: 'Ada' });
  assert.deepEqual(requests.find((r) => r.method === 'POST').body, { input_1: 'Ada' });
});
