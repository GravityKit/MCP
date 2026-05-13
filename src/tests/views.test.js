/**
 * GravityView Inspector Endpoint Tests
 *
 * Mirrors `forms.test.js` shape: MockHttpClient for the transport,
 * scenarios cover happy path, negative client-side validation, and
 * the inspector-specific behaviours (If-Match optimistic-concurrency,
 * mode replace/merge, area-key URL encoding, allowDelete guard).
 */

import { GravityViewClient } from '../gravityview-client.js';
import { ViewValidator } from '../view-operations/view-validator.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment,
} from './helpers.js';

const suite = new TestRunner('GravityView Inspector Endpoint Tests');

let client;
let mockHttpClient;
let testEnv;

suite.beforeEach(() => {
  testEnv = {
    ...setupTestEnvironment(),
    // GravityViewClient falls back to GRAVITY_FORMS_* creds, so the
    // shared setupTestEnvironment values cover both surfaces.
    GRAVITYVIEW_ALLOW_DELETE: 'true',
  };
  mockHttpClient = new MockHttpClient();
  client = new GravityViewClient(testEnv);
  client.httpClient = mockHttpClient; // bypass real network
});

// ====================================================================
// Construction + auth
// ====================================================================

suite.test('Constructor: throws without a base URL', () => {
  TestAssert.throws(() => new GravityViewClient({}), 'GRAVITYVIEW_BASE_URL');
});

suite.test('Constructor: throws without credentials', () => {
  TestAssert.throws(
    () => new GravityViewClient({ GRAVITYVIEW_BASE_URL: 'https://example.com' }),
    'WordPress credentials'
  );
});

suite.test('Constructor: builds Basic auth header from WP creds', () => {
  const c = new GravityViewClient({
    GRAVITYVIEW_BASE_URL: 'https://example.com',
    GRAVITYVIEW_WP_USERNAME: 'admin',
    GRAVITYVIEW_WP_APP_PASSWORD: 'abc def ghi jkl',
  });
  TestAssert.equal(
    c.basicAuth,
    'Basic ' + Buffer.from('admin:abc def ghi jkl').toString('base64')
  );
});

suite.test('Constructor: falls back to GRAVITY_FORMS_CONSUMER_KEY/SECRET', () => {
  const c = new GravityViewClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.com',
    GRAVITY_FORMS_CONSUMER_KEY: 'fk',
    GRAVITY_FORMS_CONSUMER_SECRET: 'fs',
  });
  TestAssert.equal(c.basicAuth, 'Basic ' + Buffer.from('fk:fs').toString('base64'));
});

// ====================================================================
// Discovery
// ====================================================================

suite.test('listTemplates: returns the templates array', async () => {
  mockHttpClient.setMockResponse(
    'GET',
    '/templates',
    new MockResponse({ templates: [{ id: 'default_list' }, { id: 'default_table' }] })
  );
  const data = await client.listTemplates();
  TestAssert.equal(data.templates.length, 2);
  TestAssert.equal(data.templates[0].id, 'default_list');
});

suite.test('getFieldTypeSchema: requires field_type', async () => {
  await TestAssert.throwsAsync(
    () => client.getFieldTypeSchema({}),
    'field_type is required'
  );
});

// ====================================================================
// Create
// ====================================================================

suite.test('createView: posts to /views and caches the version from ETag', async () => {
  mockHttpClient.setMockResponse(
    'POST',
    '/views',
    new MockResponse(
      { view_id: 42, version: 'v1', template_id: 'default_list', created: true },
      201,
      { etag: '"v1"' }
    )
  );

  const result = await client.createView({
    title: 'Smoke',
    form_id: 7,
    template_id: 'default_list',
    template_settings: { lightbox: true },
  });

  TestAssert.equal(result.view_id, 42);
  TestAssert.equal(client.versionCache.get(42), 'v1');

  const req = mockHttpClient.getRequests().find((r) => r.method === 'POST' && r.path === '/views');
  TestAssert.notEqual(req, undefined);
  TestAssert.equal(req.config.data.title, 'Smoke');
  TestAssert.equal(req.config.data.form_id, 7);
  // status / mode / search_criteria / fields / widgets shouldn't appear
  // when the caller didn't pass them — undefined is stripped.
  TestAssert.equal('status' in req.config.data, false);
  TestAssert.equal('search_criteria' in req.config.data, false);
});

suite.test('createView: rejects non-string title', async () => {
  await TestAssert.throwsAsync(
    () => client.createView({ form_id: 7 }),
    'title is required'
  );
});

suite.test('createView: rejects non-positive form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.createView({ title: 'x', form_id: 0 }),
    'form_id'
  );
});

// ====================================================================
// Bulk apply + If-Match
// ====================================================================

suite.test('applyViewConfig: posts to /views/{id}/config/_apply with the payload', async () => {
  mockHttpClient.setMockResponse(
    'POST',
    '/views/9/config/_apply',
    new MockResponse({ view_id: 9, version: 'v2', template_settings: { page_size: 25 } })
  );
  const result = await client.applyViewConfig({
    id: 9,
    template_settings: { page_size: 25 },
    mode: 'merge',
  });
  TestAssert.equal(result.template_settings.page_size, 25);
  const req = mockHttpClient.getRequests().find((r) => r.path === '/views/9/config/_apply');
  TestAssert.equal(req.config.data.mode, 'merge');
  TestAssert.equal(req.config.data.template_settings.page_size, 25);
});

suite.test('applyViewConfig: ifMatch="auto" pulls the cached version into the header', async () => {
  // Seed the cache via a read.
  mockHttpClient.setMockResponse(
    'GET',
    '/views/9/config',
    new MockResponse({ view_id: 9, version: 'cached-v3' }, 200, { etag: '"cached-v3"' })
  );
  await client.getViewConfig({ id: 9 });
  TestAssert.equal(client.versionCache.get(9), 'cached-v3');

  mockHttpClient.setMockResponse(
    'POST',
    '/views/9/config/_apply',
    new MockResponse({ view_id: 9, version: 'cached-v4' })
  );
  await client.applyViewConfig({ id: 9, template_settings: { page_size: 1 }, ifMatch: 'auto' });

  const req = mockHttpClient.getRequests().find((r) => r.path === '/views/9/config/_apply');
  TestAssert.equal(req.config.headers['If-Match'], '"cached-v3"');
});

suite.test('applyViewConfig: explicit ifMatch is wrapped in quotes', async () => {
  mockHttpClient.setMockResponse(
    'POST',
    '/views/9/config/_apply',
    new MockResponse({ view_id: 9, version: 'v5' })
  );
  await client.applyViewConfig({ id: 9, template_settings: {}, ifMatch: 'literal' });
  const req = mockHttpClient.getRequests().find((r) => r.path === '/views/9/config/_apply');
  TestAssert.equal(req.config.headers['If-Match'], '"literal"');
});

// ====================================================================
// Surgical fields
// ====================================================================

suite.test('addViewField: requires field.field_id', async () => {
  await TestAssert.throwsAsync(
    () => client.addViewField({ id: 9, area: 'directory_list-title', field: {} }),
    'field.field_id'
  );
});

suite.test('patchViewField: encodes Layout Builder area keys with ::', async () => {
  // Area keys like "directory_gravityview-layout-builder-top::100::row_uid"
  // contain `::` separators. The client should preserve them so they
  // route to the correct InspectorRoute regex.
  const area = 'directory_gravityview-layout-builder-top::100::abc123';
  mockHttpClient.setMockResponse(
    'PATCH',
    `/views/9/fields/${area}/slot1`,
    new MockResponse({ values: { custom_label: 'New' } })
  );
  await client.patchViewField({ id: 9, area, slot: 'slot1', settings: { custom_label: 'New' } });
  const req = mockHttpClient.getRequests().find((r) => r.method === 'PATCH');
  TestAssert.equal(req.path, `/views/9/fields/${area}/slot1`);
});

suite.test('moveViewField: posts to /fields/_move with from/to/position', async () => {
  mockHttpClient.setMockResponse(
    'POST',
    '/views/9/fields/_move',
    new MockResponse({ to: { area: 'directory_list-subtitle', slot: 'slot1', position: 0 } })
  );
  await client.moveViewField({
    id: 9,
    from: { area: 'directory_list-title', slot: 'slot1' },
    to: { area: 'directory_list-subtitle' },
    position: 0,
  });
  const req = mockHttpClient.getRequests().find((r) => r.path === '/views/9/fields/_move');
  TestAssert.equal(req.config.data.from.slot, 'slot1');
  TestAssert.equal(req.config.data.position, 0);
});

suite.test('removeViewField: rejected when allowDelete is false', async () => {
  client.allowDelete = false;
  await TestAssert.throwsAsync(
    () => client.removeViewField({ id: 9, area: 'directory_list-title', slot: 'slot1' }),
    'GRAVITYVIEW_ALLOW_DELETE'
  );
});

suite.test('removeViewField: deletes when allowDelete is true', async () => {
  client.allowDelete = true;
  mockHttpClient.setMockResponse(
    'DELETE',
    '/views/9/fields/directory_list-title/slot1',
    new MockResponse({ deleted: true })
  );
  const result = await client.removeViewField({ id: 9, area: 'directory_list-title', slot: 'slot1' });
  TestAssert.equal(result.deleted, true);
});

// ====================================================================
// renderViewField
// ====================================================================

suite.test('renderViewField: GET when no settings overrides supplied', async () => {
  mockHttpClient.setMockResponse(
    'GET',
    '/views/9/fields/directory_list-title/slot1/render',
    new MockResponse({ html: '<div>rendered</div>' })
  );
  const r = await client.renderViewField({ id: 9, area: 'directory_list-title', slot: 'slot1' });
  TestAssert.equal(r.html, '<div>rendered</div>');
});

suite.test('renderViewField: POST when settings overrides supplied (no persistence)', async () => {
  mockHttpClient.setMockResponse(
    'POST',
    '/views/9/fields/directory_list-title/slot1/render',
    new MockResponse({ html: '<div>preview</div>' })
  );
  await client.renderViewField({
    id: 9,
    area: 'directory_list-title',
    slot: 'slot1',
    settings: { custom_label: 'Preview' },
  });
  const req = mockHttpClient.getRequests().find(
    (r) => r.method === 'POST' && r.path === '/views/9/fields/directory_list-title/slot1/render'
  );
  TestAssert.equal(req.config.data.settings.custom_label, 'Preview');
});

// ====================================================================
// Validator
// ====================================================================

suite.test('Validator: validateApplyPayload accepts a clean payload', () => {
  const v = new ViewValidator(client);
  v.validateApplyPayload({
    template_id: 'default_list',
    template_settings: { page_size: 25 },
    fields: { 'directory_list-title': [{ field_id: '1' }] },
    mode: 'replace',
  });
});

suite.test('Validator: rejects unknown mode', () => {
  const v = new ViewValidator(client);
  TestAssert.throws(() => v.validateApplyPayload({ mode: 'append' }), 'mode must be one of');
});

suite.test('Validator: rejects fields[area] that isn\'t an array', () => {
  const v = new ViewValidator(client);
  TestAssert.throws(
    () => v.validateApplyPayload({ fields: { 'directory_list-title': { field_id: '1' } } }),
    'must be an array'
  );
});

suite.test('Validator: rejects field entries missing field_id', () => {
  const v = new ViewValidator(client);
  TestAssert.throws(
    () => v.validateApplyPayload({ fields: { 'directory_list-title': [{ label: 'oops' }] } }),
    'missing required key "field_id"'
  );
});

suite.test('Validator: validateAgainstSchemas rejects unknown setting keys', async () => {
  // Fake schema for the "custom" field type.
  client.getFieldTypeSchema = async () => ({
    field_type: 'custom',
    schema: [
      { slug: 'show_label' },
      { slug: 'custom_class' },
      { slug: 'content' },
    ],
  });
  const v = new ViewValidator(client);
  await TestAssert.throwsAsync(
    () =>
      v.validateAgainstSchemas({
        fields: {
          'directory_list-title': [{ field_id: 'custom', made_up_setting: 'nope' }],
        },
      }),
    'unknown setting "made_up_setting"'
  );
});

suite.test('Validator: validateAgainstSchemas skips numeric field ids (form fields)', async () => {
  // Numeric ids can't be validated via field-type schema — they're
  // form fields, not GravityView meta-fields. Validator should
  // silently skip them rather than throwing.
  let called = 0;
  client.getFieldTypeSchema = async () => {
    called++;
    return { schema: [] };
  };
  const v = new ViewValidator(client);
  await v.validateAgainstSchemas({
    fields: { 'directory_list-title': [{ field_id: '1' }, { field_id: '5.2' }] },
  });
  TestAssert.equal(called, 0);
});

suite.run();
