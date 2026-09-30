/**
 * gf_create_entry / gf_update_entry accept the date format Gravity Forms itself
 * stores and returns ("Y-m-d H:i:s", UTC). It used to be refused as not ISO 8601,
 * so an entry read with gf_get_entry could not be written back.
 *
 * GF source: GFAPI::add_entry / update_entry store date_created verbatim
 * (esc_sql) into a DATETIME column, "expected to be in 'Y-m-d H:i:s' format (UTC)".
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

const FORM = { id: 161, fields: [{ id: 1, type: 'text', label: 'Name' }] };

// --- 2. dates ---------------------------------------------------------------

const GF_STAMP = '2026-01-01 00:00:00';

test('gf_create_entry accepts the date format Gravity Forms stores and sends it unchanged', async () => {
  const { client, requests } = makeClient({
    'GET /forms/161': FORM,
    'POST /entries': (b) => ({ ...b, id: 9 }),
    'GET /entries/9': { id: 9, form_id: 161, date_created: GF_STAMP }
  });
  await client.createEntry({ form_id: 161, '1': 'Ada', date_created: GF_STAMP });
  assert.equal(requests.find((r) => r.method === 'POST').body.date_created, GF_STAMP);
});

test('round trip: an entry read from GF can be written back with its own dates', async () => {
  const stored = { id: 9, form_id: 161, '1': 'Ada', date_created: '2025-09-09 22:00:29', date_updated: '2025-09-10 08:15:00' };
  const { client, requests } = makeClient({
    'GET /entries/9': stored,
    'GET /forms/161': FORM,
    'PUT /entries/9': (b) => b
  });
  await client.updateEntry({ id: 9, date_created: stored.date_created, date_updated: stored.date_updated, '1': 'Grace' });
  const put = requests.find((r) => r.method === 'PUT').body;
  assert.equal(put.date_created, stored.date_created);
  assert.equal(put.date_updated, stored.date_updated);
});

test('ISO 8601 with Z or an offset is converted to the UTC stamp GF stores', () => {
  const out = (value) => validate('gf_create_entry', { form_id: 1, '1': 'x', date_created: value }).date_created;
  assert.equal(out('2026-01-01T00:00:00Z'), '2026-01-01 00:00:00');
  assert.equal(out('2026-01-01T00:00:00.123Z'), '2026-01-01 00:00:00');
  assert.equal(out('2026-01-01T02:30:00+02:00'), '2026-01-01 00:30:00');
  assert.equal(out('2025-12-31T19:00:00-05:00'), '2026-01-01 00:00:00');
  assert.equal(out('2026-01-01'), '2026-01-01 00:00:00');
});

test('dates that GF would store as a different moment, or not at all, are refused', () => {
  for (const bad of [
    '2026-01-01T00:00:00',        // no zone: GF cannot know whose clock
    '2026-01-01 00:00:00Z',       // GF format is UTC by definition
    '2026-01-01 00:00:00+02:00',
    '2026-13-01 00:00:00',
    '2026-02-30 00:00:00',
    '2026-01-01 25:00:00',
    'yesterday',
    '01/02/2026'
  ]) {
    assert.throws(
      () => validate('gf_create_entry', { form_id: 1, '1': 'x', date_created: bad }),
      /date_created must be/,
      `${bad} must be refused`
    );
  }
});

test('date_updated gets the same treatment as date_created', () => {
  assert.equal(validate('gf_update_entry', { id: 9, '1': 'x', date_updated: '2026-01-01T02:30:00+02:00' }).date_updated, '2026-01-01 00:30:00');
  assert.throws(() => validate('gf_update_entry', { id: 9, '1': 'x', date_updated: 'soon' }), /date_updated must be/);
});

test('the entry tool schemas name the accepted date formats', () => {
  const tools = getToolDefinitions();
  for (const name of ['gf_create_entry', 'gf_update_entry']) {
    const tool = tools.find((t) => t.name === name);
    for (const prop of ['date_created', 'date_updated']) {
      const description = tool.inputSchema.properties[prop]?.description || '';
      assert.match(description, /Y-m-d H:i:s|YYYY-MM-DD HH:MM:SS/, `${name}.${prop} names GF's format`);
      assert.match(description, /UTC/, `${name}.${prop} says UTC`);
    }
  }
});


// --- 3. date_updated on update -----------------------------------------------
//
// GFAPI::update_entry fills date_updated with utc_timestamp() only when the value
// it is given is empty (includes/api.php:904). updateEntry fetch-then-merges, so
// the stored stamp rode along in the PUT body and GF kept it: every entry changed
// through the tool looked untouched since creation.

const STORED = { id: 9, form_id: 161, '1': 'Ada', date_created: '2026-09-30 23:41:13', date_updated: '2026-09-30 23:41:13' };

test('an update that names no date_updated does not resend the stored one, so GF stamps the change', async () => {
  const { client, requests } = makeClient({
    'GET /entries/9': STORED,
    'GET /forms/161': FORM,
    'PUT /entries/9': (b) => b
  });
  await client.updateEntry({ id: 9, '1': 'Grace' });
  const put = requests.find((r) => r.method === 'PUT').body;
  assert.equal(put['1'], 'Grace');
  assert.equal(put.date_created, STORED.date_created, 'date_created still round-trips');
  assert.ok(!('date_updated' in put) || put.date_updated === '' || put.date_updated == null,
    `stored date_updated must not be resent, got ${JSON.stringify(put.date_updated)}`);
});

test('an explicit date_updated on an update still wins', async () => {
  const { client, requests } = makeClient({
    'GET /entries/9': STORED,
    'GET /forms/161': FORM,
    'PUT /entries/9': (b) => b
  });
  await client.updateEntry({ id: 9, '1': 'Grace', date_updated: '2027-01-02 03:04:05' });
  assert.equal(requests.find((r) => r.method === 'PUT').body.date_updated, '2027-01-02 03:04:05');
});

test('an explicit date_updated equal to the stored one is still sent', async () => {
  const { client, requests } = makeClient({
    'GET /entries/9': STORED,
    'GET /forms/161': FORM,
    'PUT /entries/9': (b) => b
  });
  await client.updateEntry({ id: 9, '1': 'Grace', date_updated: STORED.date_updated });
  assert.equal(requests.find((r) => r.method === 'PUT').body.date_updated, STORED.date_updated);
});
