/**
 * Adversarial / edge-case hardening tests for GravityFormsClient.
 *
 * Each test pins GF-faithful behavior verified against the real Gravity Forms
 * 2.10.3 source:
 *   - /forms/{id}/submissions/validation returns HTTP 400 with
 *     {is_valid:false, validation_messages, page_number, source_page_number}
 *     for the NORMAL invalid case
 *     (class-controller-form-submissions-validation.php:88-90).
 *   - /forms/{id}/submissions returns HTTP 400 with {is_valid:false, …} on a
 *     rejected submission (class-controller-form-submissions.php:115).
 *   - search field_filters carry their own 'mode' key; GF reads
 *     $field_filters['mode'] (class-gf-query.php:301), NOT a top-level
 *     search.mode.
 *   - /forms does NOT send X-WP-Total; total_count must be the count returned.
 *   - sendNotifications with an empty _notifications query string makes GF send
 *     ALL notifications (dangerous) — must never happen for a caller-supplied
 *     non-empty notification_ids that filters down to nothing.
 *
 * These exercise the real client methods against a fake httpClient that throws
 * GF-shaped errors (err.response = { status, data }), the same shape axios
 * produces before the response interceptor runs.
 */

import test from 'node:test';
import assert from 'node:assert';
import GravityFormsClient, { buildEntriesQuery } from '../src/gravity-forms-client.js';
import { flattenParams } from '../src/config/auth.js';

const ENV = {
  GRAVITY_FORMS_BASE_URL: 'http://x',
  GRAVITY_FORMS_CONSUMER_KEY: 'u',
  GRAVITY_FORMS_CONSUMER_SECRET: 'p',
  GRAVITY_FORMS_AUTH_METHOD: 'basic',
};

function makeClient() {
  return new GravityFormsClient(ENV);
}

// Build a fake axios-style error: a rejection whose .response carries the
// GF body and status — exactly what axios exposes before any interceptor.
function gfError(status, data) {
  const err = new Error(data && data.message ? data.message : `HTTP ${status}`);
  err.response = { status, data, headers: {} };
  return err;
}

// =====================================================================
// FIX 1 — validateSubmission must RETURN on a GF 400 {is_valid:false}
// =====================================================================

test('validateSubmission: GF 400 {is_valid:false} is RETURNED, not thrown', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => {
      throw gfError(400, {
        is_valid: false,
        validation_messages: { '2': 'Email is invalid' },
        page_number: 1,
        source_page_number: 1,
      });
    },
  };

  const result = await client.validateSubmission({ form_id: 1, input_2: 'nope' });
  assert.equal(result.valid, false);
  assert.equal(result.validation_messages['2'], 'Email is invalid');
  assert.equal(result.page_number, 1);
});

test('validateSubmission: a real 401 (no is_valid body) still throws', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(401, { message: 'Bad credentials', code: 'unauthorized' }); },
  };
  await assert.rejects(() => client.validateSubmission({ form_id: 1 }), /Authentication failed|Bad credentials/);
});

test('validateSubmission: a 404 (no is_valid body) still throws', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(404, { message: 'Form not found' }); },
  };
  await assert.rejects(() => client.validateSubmission({ form_id: 999 }), /not found/i);
});

test('validateSubmission: a 500 (no is_valid body) still throws', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(500, { message: 'boom' }); },
  };
  await assert.rejects(() => client.validateSubmission({ form_id: 1 }), /Server error|boom/);
});

test('validateSubmission: 200 valid body still returns valid:true', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => ({ data: { is_valid: true, validation_messages: {}, page_number: 0 } }),
  };
  const result = await client.validateSubmission({ form_id: 1, input_1: 'ok' });
  assert.equal(result.valid, true);
});

// A 400 that genuinely lacks an is_valid body (e.g. malformed request) must
// still surface as an error — we only swallow the validation 400.
test('validateSubmission: a 400 WITHOUT is_valid body still throws (not a validation result)', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(400, { message: 'rest_missing_callback_param', code: 'rest_missing' }); },
  };
  await assert.rejects(() => client.validateSubmission({ form_id: 1 }));
});

// =====================================================================
// FIX 2 — submitFormData must RETURN on a GF 400 {is_valid:false}
// =====================================================================

test('submitFormData: GF 400 {is_valid:false} returns success:false with messages', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => {
      throw gfError(400, {
        is_valid: false,
        validation_messages: { '1': 'Name is required' },
        page_number: 1,
      });
    },
  };
  const result = await client.submitFormData({ form_id: 1, input_3: 'x' });
  assert.equal(result.success, false);
  assert.equal(result.validation_messages['1'], 'Name is required');
});

test('submitFormData: a real 404 (no is_valid body) still throws', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(404, { message: 'Form not found' }); },
  };
  await assert.rejects(() => client.submitFormData({ form_id: 999, input_1: 'x' }), /not found/i);
});

test('submitFormData: a 500 (no is_valid body) still throws', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => { throw gfError(500, { message: 'db down' }); },
  };
  await assert.rejects(() => client.submitFormData({ form_id: 1, input_1: 'x' }), /Server error|db down/);
});

test('submitFormData: 200 success body returns success:true + entry_id', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async () => ({ data: { is_valid: true, entry_id: 42, confirmation_message: 'ok' } }),
  };
  const result = await client.submitFormData({ form_id: 1, input_1: 'x' });
  assert.equal(result.success, true);
  assert.equal(result.entry_id, 42);
});

// =====================================================================
// FIX 3 — search.mode must ride INSIDE field_filters (field_filters.mode)
// =====================================================================

function wire(query) {
  return new Map(flattenParams(query));
}

test('search.mode is moved INTO field_filters.mode (GF reads $field_filters[mode])', () => {
  const q = buildEntriesQuery({
    search: { field_filters: [{ key: '1', value: 'a', operator: 'is' }], mode: 'any' },
  });
  const parsed = JSON.parse(wire(q).get('search'));
  assert.equal(parsed.field_filters.mode, 'any', 'mode must be a key on field_filters');
  assert.ok(!('mode' in parsed), 'mode must NOT sit at the search-object top level');
});

test('search.mode=all rides inside field_filters even with multiple filters', () => {
  const q = buildEntriesQuery({
    search: {
      field_filters: [
        { key: '1', value: 'a', operator: 'is' },
        { key: '2', value: 'b', operator: 'contains' },
      ],
      mode: 'all',
    },
  });
  const parsed = JSON.parse(wire(q).get('search'));
  assert.equal(parsed.field_filters.mode, 'all');
  assert.ok(!('mode' in parsed));
  // field_filters serializes as an object ({"0":…,"1":…,"mode":"all"}) so PHP
  // json_decodes the GF array it iterates after unset('mode'). The actual
  // filters (numeric keys) must still be present alongside mode.
  const onlyFilters = Object.values(parsed.field_filters).filter((f) => f && typeof f === 'object' && 'key' in f);
  assert.equal(onlyFilters.length, 2);
});

test('mode + exclude coexist: exclude id filter present AND mode on field_filters', () => {
  const q = buildEntriesQuery({
    search: { field_filters: [{ key: '1', value: 'a', operator: 'is' }], mode: 'any' },
    exclude: [9],
  });
  const parsed = JSON.parse(wire(q).get('search'));
  assert.equal(parsed.field_filters.mode, 'any');
  const idFilter = Object.values(parsed.field_filters).find((f) => f && f.key === 'id' && f.operator === 'not in');
  assert.ok(idFilter, 'exclude must still append an id not-in filter');
});

test('no mode supplied → no mode key injected', () => {
  const q = buildEntriesQuery({
    search: { field_filters: [{ key: '1', value: 'a', operator: 'is' }] },
  });
  const parsed = JSON.parse(wire(q).get('search'));
  assert.ok(!('mode' in parsed), 'no top-level mode');
  assert.ok(parsed.field_filters.mode === undefined, 'no fabricated field_filters.mode');
});

test('buildEntriesQuery does not mutate caller search when moving mode', () => {
  const input = { search: { field_filters: [{ key: '1', value: 'x', operator: 'is' }], mode: 'any' } };
  const before = JSON.stringify(input);
  buildEntriesQuery(input);
  assert.equal(JSON.stringify(input), before, 'caller input must be untouched');
});

// =====================================================================
// FIX 4 — listEntries normalization never fabricates entries
// =====================================================================

async function listWith(data, headers = {}) {
  const client = makeClient();
  client.httpClient = { get: async () => ({ data, headers }) };
  return client.listEntries();
}

test('listEntries: data=null → entries:[] total_count:0 (no header fabrication)', async () => {
  const r = await listWith(null, { 'x-wp-total': '999' });
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

test('listEntries: data="" → entries:[] total_count:0', async () => {
  const r = await listWith('');
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

test('listEntries: data is a plain string → entries:[] total_count:0', async () => {
  const r = await listWith('notarray');
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

test('listEntries: {entries:"notarray"} → entries:[] total_count:0 (never Object.values it)', async () => {
  const r = await listWith({ entries: 'notarray' });
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

test('listEntries: proper {entries:[…], total_count} → used verbatim', async () => {
  const r = await listWith({ entries: [{ id: 1 }, { id: 2 }], total_count: 27774 });
  assert.equal(r.entries.length, 2);
  assert.equal(r.total_count, 27774);
});

test('listEntries: {entries:[…]} without total_count falls back to header', async () => {
  const r = await listWith({ entries: [{ id: 1 }] }, { 'x-wp-total': '5' });
  assert.equal(r.entries.length, 1);
  assert.equal(r.total_count, 5);
});

test('listEntries: include keyed-by-id object normalizes to a list', async () => {
  const r = await listWith({ '11': { id: 11 }, '22': { id: 22 } });
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].id, 11);
  assert.equal(r.total_count, 2);
});

test('listEntries: empty object {} → entries:[] total_count:0', async () => {
  const r = await listWith({});
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

test('listEntries: total_count is ALWAYS a number', async () => {
  for (const data of [null, '', 'x', { entries: 'bad' }, {}, { entries: [] }]) {
    const r = await listWith(data);
    assert.equal(typeof r.total_count, 'number', `total_count must be a number for ${JSON.stringify(data)}`);
    assert.ok(Array.isArray(r.entries), `entries must be an array for ${JSON.stringify(data)}`);
  }
});

// A keyed-by-id object whose values are NOT entry-like objects must not be
// treated as entries (e.g. a stray scalar map). Guard against junk.
test('listEntries: object whose values are scalars → entries:[] total_count:0', async () => {
  const r = await listWith({ a: 1, b: 2 });
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_count, 0);
});

// =====================================================================
// FIX 5 — listForms total_count = number of forms returned (no X-WP-Total)
// =====================================================================

async function listFormsWith(data, headers = {}) {
  const client = makeClient();
  client.httpClient = { get: async () => ({ data, headers }) };
  return client.listForms();
}

test('listForms: keyed object → total_count = number of forms (not X-WP-Total)', async () => {
  const r = await listFormsWith({ '1': { id: '1' }, '2': { id: '2' } }, { 'x-wp-total': '0' });
  assert.equal(r.total_count, 2);
});

test('listForms: empty object → total_count 0', async () => {
  const r = await listFormsWith({}, { 'x-wp-total': '0' });
  assert.equal(r.total_count, 0);
});

test('listForms: array of forms → total_count = array length', async () => {
  const r = await listFormsWith([{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(r.total_count, 3);
});

test('listForms: does not report a bogus X-WP-Total of 0 while returning forms', async () => {
  // The exact bug: GF never sends X-WP-Total for /forms, so the old code
  // always reported 0 even when forms came back.
  const r = await listFormsWith({ '5': { id: '5' } });
  assert.notEqual(r.total_count, 0, 'a returned form must count');
  assert.equal(r.total_count, 1);
});

test('listForms: total_pages is not bogus (absent or 1)', async () => {
  const r = await listFormsWith({ '1': { id: '1' }, '2': { id: '2' } }, { 'x-wp-totalpages': '99' });
  assert.ok(r.total_pages === undefined || r.total_pages === 1, 'no fabricated multi-page count');
});

// =====================================================================
// FIX 6 — sendNotifications must never silently "send all" after filtering
// =====================================================================

async function sendWith(params, captured) {
  const client = makeClient();
  client.httpClient = {
    post: async (path, body, config) => {
      captured.path = path;
      captured.body = body;
      captured.params = (config && config.params) || {};
      return { data: ['sent_one'] };
    },
  };
  return client.sendNotifications(params);
}

test('sendNotifications: null/empty ids are filtered out of _notifications', async () => {
  const captured = {};
  await sendWith({ entry_id: 100, notification_ids: ['admin', null, '', 'user'] }, captured);
  assert.equal(captured.params._notifications, 'admin,user');
});

test('sendNotifications: caller-supplied ids that all filter out THROWS (never sends all)', async () => {
  const client = makeClient();
  let posted = false;
  client.httpClient = { post: async () => { posted = true; return { data: [] }; } };
  await assert.rejects(
    () => client.sendNotifications({ entry_id: 100, notification_ids: [null, '', 0, false] }),
    /notification/i,
  );
  assert.equal(posted, false, 'must NOT POST when the caller asked for specific ids that all dropped out');
});

test('sendNotifications: empty _notifications is never sent (would trigger GF send-all)', async () => {
  const client = makeClient();
  client.httpClient = {
    post: async (_path, _body, config) => {
      const p = (config && config.params) || {};
      assert.ok(!('_notifications' in p) || p._notifications.length > 0,
        '_notifications must never be an empty string');
      return { data: [] };
    },
  };
  // No notification_ids at all → legitimately send-all (no _notifications param).
  await client.sendNotifications({ entry_id: 100 });
});

test('sendNotifications: no notification_ids at all → send-all (no _notifications param)', async () => {
  const captured = {};
  await sendWith({ entry_id: 100 }, captured);
  assert.ok(!('_notifications' in captured.params), 'omitting ids means GF send-all by event — allowed');
});

test('sendNotifications: non-string ids are dropped, valid ones kept', async () => {
  const captured = {};
  await sendWith({ entry_id: 100, notification_ids: ['a', 5, 'b', {}, 'c'] }, captured);
  // Non-string ids (5, {}) dropped; valid string ids preserved.
  assert.equal(captured.params._notifications, 'a,b,c');
});
