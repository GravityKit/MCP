/**
 * gf_send_notifications must tell the truth about what it sent.
 *
 * GF's POST /entries/{id}/notifications derives the form from the entry and
 * answers with the ids GFAPI::send_notifications returned. That function skips
 * every notification whose `event` differs from the requested one
 * (includes/api.php:2566), so [] means nothing was sent — yet the tool answered
 * `sent: true` regardless, and named a form it then ignored.
 *
 * Assertions read the wire through the recorded requests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { ValidationFactory } from '../src/config/validation.js';

function getToolDefinitions() {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js'), 'utf8');
  const start = source.indexOf('const GF_TOOL_DEFINITIONS = ');
  const end = source.indexOf('\n];', start);
  assert.ok(start !== -1 && end !== -1, 'GF_TOOL_DEFINITIONS literal not found');
  return Function(`"use strict"; return (${source.slice(start + 'const GF_TOOL_DEFINITIONS = '.length, end + 2)});`)();
}

function makeClient(routes = {}) {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass'
  });
  const requests = [];
  const answer = (method) => async (path, dataOrConfig, config) => {
    requests.push({ method, path, params: (method === 'GET' ? dataOrConfig : config)?.params });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${path}`);
    if (route instanceof Error) throw route;
    return { data: route };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  return { client, requests };
}

const ENTRY = { id: 101707, form_id: '166' }; // GF returns form_id as a string
const posts = (requests) => requests.filter((r) => r.method === 'POST');

// --- form_id is load-bearing -------------------------------------------------

test('a form_id that is not the entry\'s form is refused and nothing is sent', async () => {
  const { client, requests } = makeClient({ 'GET /entries/101707': ENTRY, 'POST /entries/101707/notifications': ['n1'] });
  await assert.rejects(
    () => client.sendNotifications({ form_id: 165, entry_id: 101707 }),
    (error) => {
      assert.match(error.message, /101707/);
      assert.match(error.message, /form 166/, 'names the form the entry is in');
      assert.match(error.message, /165/, 'names the form the caller gave');
      return true;
    }
  );
  assert.equal(posts(requests).length, 0, 'must not POST after a mismatch');
});

test('a form_id that matches the entry\'s form is sent through, whether number or string', async () => {
  for (const formId of [166, '166']) {
    const { client, requests } = makeClient({ 'GET /entries/101707': ENTRY, 'POST /entries/101707/notifications': ['n1'] });
    const result = await client.sendNotifications({ form_id: formId, entry_id: 101707 });
    assert.equal(posts(requests).length, 1);
    assert.equal(result.sent, true);
  }
});

test('form_id is optional: without it a send costs one request', async () => {
  const { client, requests } = makeClient({ 'POST /entries/101707/notifications': ['n1'] });
  await client.sendNotifications({ entry_id: 101707 });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['POST /entries/101707/notifications']);
});

test('the tool schema advertises form_id as optional', () => {
  const tool = getToolDefinitions().find((t) => t.name === 'gf_send_notifications');
  assert.ok(tool.inputSchema.properties.form_id, 'form_id is declared');
  assert.deepEqual(tool.inputSchema.required, ['entry_id']);
  assert.match(tool.inputSchema.properties.form_id.description, /entry/i);
});

test('form_id must be a positive integer when given', () => {
  assert.throws(() => ValidationFactory.validateToolInput('gf_send_notifications', { entry_id: 1, form_id: 'abc' }), /form_id/);
  assert.equal(ValidationFactory.validateToolInput('gf_send_notifications', { entry_id: 1, form_id: 166 }).form_id, 166);
});

// --- sent depends on what GF sent --------------------------------------------

test('sent is true and lists the ids when GF sent notifications', async () => {
  const { client } = makeClient({ 'POST /entries/101707/notifications': ['n1', 'n2'] });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.equal(result.sent, true);
  assert.deepEqual(result.notifications_sent, ['n1', 'n2']);
  assert.equal(result.reason, undefined, 'no reason when something was sent');
});

test('sent is true for the ids the caller named', async () => {
  const { client, requests } = makeClient({ 'POST /entries/101707/notifications': ['n1'] });
  const result = await client.sendNotifications({ entry_id: 101707, notification_ids: ['n1'] });
  assert.equal(result.sent, true);
  assert.equal(posts(requests)[0].params._notifications, 'n1');
});

test('an empty answer from GF is sent: false, and says nothing was sent', async () => {
  const { client } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: { n1: { id: 'n1', event: 'form_submission', isActive: true } } }
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.equal(result.sent, false);
  assert.deepEqual(result.notifications_sent, []);
  assert.equal(typeof result.reason, 'string');
});

test('the reason names the event that matched no notification, and the events the form does have', async () => {
  const { client, requests } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: { n1: { id: 'n1', event: 'form_saved' }, n2: { id: 'n2', isActive: true } } }
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.match(result.reason, /form_submission/, 'the requested event');
  assert.match(result.reason, /form_saved/, 'an event the form has');
  assert.match(result.reason, /no event/i, 'an event-less notification is called out');
  assert.equal(requests.filter((r) => r.method === 'GET').length, 2, 'entry then form, only on the empty path');
});

test('the reason honours a caller-supplied event', async () => {
  const { client, requests } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: { n1: { id: 'n1', event: 'form_submission' } } }
  });
  const result = await client.sendNotifications({ entry_id: 101707, event: 'form_saved' });
  assert.equal(posts(requests)[0].params._event, 'form_saved');
  assert.match(result.reason, /form_saved/);
});

test('a form with no notifications says so', async () => {
  const { client } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: {} }
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.match(result.reason, /no notifications/i);
});

test('notifications that carry the event but were not sent point at a disabling filter', async () => {
  const { client } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: { n1: { id: 'n1', event: 'form_submission' } } }
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.match(result.reason, /gform_disable_notification/);
});

test('with form_id given, the empty path reuses the entry it already read', async () => {
  const { client, requests } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: {} }
  });
  await client.sendNotifications({ form_id: 166, entry_id: 101707 });
  assert.equal(requests.filter((r) => r.path === '/entries/101707' && r.method === 'GET').length, 1);
});

test('if the form cannot be read to explain an empty answer, the answer is still sent: false', async () => {
  const { client } = makeClient({
    'POST /entries/101707/notifications': [],
    'GET /entries/101707': new Error('boom')
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.equal(result.sent, false);
  assert.match(result.reason, /could not be read/);
});

test('a response that is not a list of ids is not reported as sent', async () => {
  const { client } = makeClient({
    'POST /entries/101707/notifications': { unexpected: true },
    'GET /entries/101707': ENTRY,
    'GET /forms/166': { id: 166, notifications: {} }
  });
  const result = await client.sendNotifications({ entry_id: 101707 });
  assert.equal(result.sent, false);
});

test('the tool description says what notifications_sent does and does not promise', () => {
  const tool = getToolDefinitions().find((t) => t.name === 'gf_send_notifications');
  assert.match(tool.description, /inactive|conditional/i, 'names the notifications GF skips silently');
});
