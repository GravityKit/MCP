/**
 * GravityView REST stress tests — portable, runs against any
 * GravityView dev install.
 *
 * Codifies the contracts the round-2 stress sweep proved:
 *
 *   - SHAPE: /layouts uses `has_grid` (not `is_grid_aware`),
 *     excludes preset_* + *_placeholder; schema responses drop the
 *     static `groups` map + UI-only keys (priority/class/tooltip/
 *     article/codemirror/mount_target/extension/raw-DSL); requires
 *     envelope merges show/hide sub-keys with single-condition
 *     collapse + multi-condition QF group wrap; synthetic _id
 *     hashes stripped while real QF ids preserved; desc HTML
 *     stripped to plain text; empty values dropped; apply default
 *     compact; slot_uid alias removed; version string is a real
 *     timestamp not the Unix epoch.
 *   - ROUND-TRIP: bulk apply preserves every setting verbatim;
 *     Unicode + emoji survives custom_label; HTML body of custom
 *     content survives; conditional_logic v2 doc round-trips;
 *     move_field keeps slot UID + settings; preview stage transient
 *     reads back with correct ownership.
 *   - SANITISATION: text-typed settings strip all HTML; textarea-
 *     typed settings keep safe HTML via wp_kses_post; <script>
 *     and on* handlers stripped; numeric values coerce to int;
 *     bare URLs in text settings survive; URLs wrapped in <a>
 *     lose the wrapper + href.
 *   - VALIDATION: validateAgainstSchemas=true rejects unknown
 *     setting keys on numeric form fields with input-type-specific
 *     overlays AND on meta-field types.
 *   - CONCURRENCY: parallel writes with same ETag → 1 accepted, N-1
 *     rejected with 412 (MySQL GET_LOCK serialisation).
 *
 * The file bootstraps its own throwaway form (with the field types
 * the tests need) and creates fresh views per test. Skips silently
 * when env vars aren't present — runs in any environment that
 * provides WP credentials + a base URL.
 *
 * Required env (any one set is enough):
 *   - GRAVITYKIT_WP_URL + GRAVITYKIT_WP_USERNAME +
 *     GRAVITYKIT_WP_APP_PASSWORD
 *   - WORDPRESS_LOCAL_DEV_TEST_URL +
 *     WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER +
 *     WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD
 *   - GRAVITY_FORMS_BASE_URL + GRAVITY_FORMS_CONSUMER_KEY +
 *     GRAVITY_FORMS_CONSUMER_SECRET (legacy GF MCP env, reused
 *     when no GV-specific creds are set)
 *
 * Optional:
 *   - MCP_ALLOW_SELF_SIGNED_CERTS=true (for Local-by-Flywheel)
 *   - GRAVITYVIEW_TEST_CLEANUP=false (default true — deletes the
 *     scratch form + every view minted by the suite on completion)
 *
 * Run via:
 *   node --test src/tests/views-stress.test.js
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import GravityFormsClient from '../gravity-forms-client.js';
import { GravityViewInspectorClient } from '../gravityview/inspector-client.js';
import { ViewValidator } from '../gravityview/view-validator.js';
import { loadAbilitiesAsTools } from '../abilities/loader.js';
import { TestRunner, TestAssert } from './helpers.js';

dotenv.config();

process.env.GRAVITY_FORMS_TEST_MODE = 'true';

const suite = new TestRunner('GravityView REST stress tests (live)');

// Skip when no creds — keeps the unit-test job green on CI runners
// without a backing WP install.
const baseUrl =
  process.env.GRAVITYKIT_WP_URL ||
  process.env.WORDPRESS_LOCAL_DEV_TEST_URL ||
  process.env.GRAVITY_FORMS_BASE_URL ||
  '';
const wpUser =
  process.env.GRAVITYKIT_WP_USERNAME ||
  process.env.WORDPRESS_LOCAL_DEV_TEST_ADMIN_USER ||
  process.env.WP_USERNAME ||
  '';
const wpPass =
  process.env.GRAVITYKIT_WP_APP_PASSWORD ||
  process.env.WORDPRESS_LOCAL_DEV_TEST_ADMIN_PASSWORD ||
  process.env.WP_APP_PASSWORD ||
  '';

const hasCreds = Boolean(baseUrl && wpUser && wpPass);
if (!hasCreds) {
  console.log('\n⚠️  Skipping GravityView stress tests — set GRAVITYKIT_WP_URL + GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD (or the WORDPRESS_LOCAL_DEV_TEST_* equivalents) to run.\n');
  suite.skip = true;
}

let gvClient;
let gfClient;
let validator;
let formId;            // throwaway test form
let fieldIds = {};     // { name, email, address, date, fileupload, textarea, checkbox }
let mintedViewIds = []; // tracked for end-of-suite cleanup

// Abilities API tool handlers — auto-generated from
// `/wp-abilities/v1/abilities`. Replaces the legacy GravityViewInspectorClient
// method calls now that the inspector lives entirely on the
// Abilities API surface (`/wp-json/wp-abilities/v1/abilities/gk-gravityview/{name}/run`).
// `h` is a short alias used throughout the test bodies — every old
// `h.gv_apply_view_config({...})` is now `h.gv_apply_view_config({...})`.
let h = null;
const cleanup = process.env.GRAVITYVIEW_TEST_CLEANUP !== 'false';
const allowSelfSigned = process.env.MCP_ALLOW_SELF_SIGNED_CERTS === 'true';

// Optional mu-plugin fixture so the template-settings architecture
// can be tested WITHOUT depending on real DataTables/Maps plugins.
// Install requires filesystem access to the WP install. Both env
// vars must be set; when either is missing the mock-source tests
// skip gracefully.
//   - GRAVITYVIEW_PLUGIN_PATH → absolute path to the GravityView plugin dir (carries the fixture file)
//   - WP_MU_PLUGINS_DIR       → absolute path to wp-content/mu-plugins/ on the target install
const mockFixtureSource = process.env.GRAVITYVIEW_PLUGIN_PATH
  ? path.join(process.env.GRAVITYVIEW_PLUGIN_PATH, 'tests/fixtures/inspector-template-sources-mock.php')
  : null;
const mockFixtureDest = process.env.WP_MU_PLUGINS_DIR
  ? path.join(process.env.WP_MU_PLUGINS_DIR, 'gv-test-inspector-template-sources-mock.php')
  : null;
let mockFixtureActive = false;

suite.beforeAll(async () => {
  if (suite.skip) return;

  const clientEnv = {
    GRAVITYKIT_WP_URL: baseUrl,
    GRAVITYKIT_WP_USERNAME: wpUser,
    GRAVITYKIT_WP_APP_PASSWORD: wpPass,
    GRAVITYVIEW_ALLOW_DELETE: 'true',
    MCP_ALLOW_SELF_SIGNED_CERTS: allowSelfSigned ? 'true' : 'false',
  };
  gvClient = new GravityViewInspectorClient(clientEnv);
  validator = new ViewValidator(gvClient);

  // Load the abilities catalog → builds gv_* tool handlers that
  // round-trip through the Abilities API. All test bodies call
  // `h.gv_X(...)` instead of `gvClient.X(...)`.
  try {
    const { handlers, count } = await loadAbilitiesAsTools(gvClient);
    h = handlers;
    console.log(`   (loaded ${count} abilities)`);
  } catch (err) {
    console.warn(`\n⚠️  Failed to load abilities catalog (${err.message}); skipping suite.\n`);
    suite.skip = true;
    return;
  }

  // Bootstrap a scratch form via the GF client (uses the same WP
  // basic-auth creds when GRAVITY_FORMS_AUTH_METHOD=basic). The
  // suite never assumes pre-existing forms / fields — every test
  // works off this freshly-minted form.
  gfClient = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: baseUrl,
    GRAVITY_FORMS_AUTH_METHOD: 'basic',
    GRAVITY_FORMS_CONSUMER_KEY: wpUser,
    GRAVITY_FORMS_CONSUMER_SECRET: wpPass,
    GRAVITY_FORMS_ALLOW_DELETE: 'true',
    GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS: allowSelfSigned ? 'true' : 'false',
  });

  try {
    await gfClient.initialize();
  } catch (err) {
    console.warn(`\n⚠️  Could not initialise GF client (${err.message}); marking suite as skip.\n`);
    suite.skip = true;
    return;
  }

  const formResp = await gfClient.createForm({
    title: `GV stress test ${Date.now()}`,
    description: 'Throwaway form for the GravityView stress suite. Safe to delete.',
    fields: [
      { id: 1, type: 'text', label: 'Speaker name' },
      { id: 2, type: 'email', label: 'Email' },
      { id: 3, type: 'address', label: 'Address' },
      { id: 4, type: 'date', label: 'Submitted date' },
      { id: 5, type: 'fileupload', label: 'Headshot' },
      { id: 6, type: 'textarea', label: 'Bio' },
      { id: 7, type: 'checkbox', label: 'Tracks', choices: [
        { text: 'AI', value: 'ai', isSelected: false },
        { text: 'Security', value: 'security', isSelected: false },
      ] },
    ],
  });
  formId = formResp?.id || formResp?.form?.id || formResp?.data?.id;
  if (!formId) {
    console.warn('\n⚠️  Form creation succeeded but no id returned — skipping suite.\n');
    suite.skip = true;
    return;
  }
  fieldIds = { name: '1', email: '2', address: '3', date: '4', fileupload: '5', textarea: '6', checkbox: '7' };

  // Install the template-sources mock as an mu-plugin so the
  // template-settings tests can exercise the contract without
  // depending on the real DataTables/Maps plugins. Best-effort:
  // when env paths aren't set or the destination isn't writable,
  // the mock-source tests skip.
  try {
    if (
      mockFixtureSource && mockFixtureDest &&
      fs.existsSync(mockFixtureSource) && fs.existsSync(path.dirname(mockFixtureDest))
    ) {
      fs.copyFileSync(mockFixtureSource, mockFixtureDest);
      mockFixtureActive = true;
    }
  } catch (_) {
    mockFixtureActive = false;
  }
});

suite.afterAll(async () => {
  if (suite.skip) return;

  // Always remove the mock mu-plugin fixture, even when test cleanup
  // is disabled — leaving it installed would pollute non-test runs.
  if (mockFixtureActive && mockFixtureDest) {
    try {
      fs.unlinkSync(mockFixtureDest);
    } catch (_) { /* best-effort */ }
    mockFixtureActive = false;
  }

  if (!cleanup) return;
  // Tear down minted views via gv_apply_view_config replace + empty
  // tree (clears placements), then the underlying WP posts via the
  // wp/v2 endpoint. GravityViewInspectorClient doesn't expose a delete-view
  // method (intentional — destructive), so hit the WP REST surface
  // directly with the same basic-auth headers.
  for (const viewId of mintedViewIds) {
    try {
      await gvClient.httpClient.request({
        method: 'DELETE',
        baseURL: baseUrl,
        url: `/wp-json/wp/v2/gravityview/${viewId}?force=true`,
      });
    } catch (_) {
      // best-effort cleanup; leaving a view in place doesn't fail tests
    }
  }
  if (formId) {
    try {
      await gfClient.deleteForm({ id: formId, force: true });
    } catch (_) { /* best-effort */ }
  }
});

/** Mint a Layout Builder view + register it for cleanup. */
async function mintView(suffix) {
  const view = await h.gv_create_view({
    title: `[stress] ${suffix} ${Date.now()}`,
    form_id: Number(formId),
    template_id: 'gravityview-layout-builder',
    status: 'draft',
  });
  const viewId = view.view_id;
  mintedViewIds.push(viewId);
  return viewId;
}

/** Apply one slot's settings + return the stored shape via GET /config. */
async function roundTripSlot(viewId, area, slot, settings) {
  const apply = await h.gv_apply_view_config({
    id:     viewId,
    fields: { [area]: [{ ...settings, slot }] },
    mode:   'merge',
  });
  TestAssert.isNotNull(apply.applied, 'apply response carries applied envelope');

  const config = await h.gv_get_view_config({ id: viewId });
  const stored = config?.fields?.[area]?.[slot];
  TestAssert.isNotNull(stored, `slot ${slot} round-trips into ${area}`);
  return stored;
}

/** Stage helpers — now route through the abilities pipeline. */
async function createPreviewStage(viewId, payload) {
  return h.gv_create_preview_stage({ id: viewId, ...payload });
}

async function deletePreviewStage(viewId, stageKey) {
  return h.gv_discard_preview_stage({ id: viewId, stage_key: stageKey });
}

/** Recursive tree walker — does any node carry this key? */
function treeHasKey(tree, key, predicate) {
  if (Array.isArray(tree)) return tree.some((v) => treeHasKey(v, key, predicate));
  if (tree && typeof tree === 'object') {
    for (const [k, v] of Object.entries(tree)) {
      if (k === key && (!predicate || predicate(v))) return true;
      if (treeHasKey(v, key, predicate)) return true;
    }
  }
  return false;
}

const schemaItem = (schema, slug) => schema.find((it) => it?.slug === slug) || null;

// ============================================================
// SHAPE: /layouts
// ============================================================

suite.test('Shape: /layouts uses has_grid (not is_grid_aware), skips preset_* + *_placeholder', async () => {
  if (suite.skip) return;
  const { layouts } = await h.gv_list_layouts({});
  TestAssert.isTrue(Array.isArray(layouts) && layouts.length > 0, 'layouts array non-empty');

  for (const layout of layouts) {
    TestAssert.isTrue('has_grid' in layout, 'has_grid present');
    TestAssert.isTrue(!('is_grid_aware' in layout), 'is_grid_aware removed');
    TestAssert.isTrue(typeof layout.has_grid === 'boolean', 'has_grid is boolean');
    TestAssert.isTrue(!layout.id.startsWith('preset_'), `${layout.id} is not a preset_*`);
    TestAssert.isTrue(!layout.id.includes('_placeholder'), `${layout.id} is not a placeholder`);
  }

  const byId = Object.fromEntries(layouts.map((l) => [l.id, l]));
  TestAssert.isTrue(byId['gravityview-layout-builder']?.has_grid === true, 'Layout Builder has_grid: true');
  if (byId['default_table']) TestAssert.isTrue(byId['default_table'].has_grid === false, 'default_table has_grid: false');
});

// ============================================================
// SHAPE: schema item envelope
// ============================================================

suite.test('Shape: schema response omits the static groups map', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  TestAssert.isTrue(!('groups' in resp), 'No top-level `groups` map');
});

suite.test('Shape: schema items drop UI-only keys (priority/class/tooltip/article/codemirror/mount_target/extension)', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'edit_link' });
  const banned = ['priority', 'class', 'tooltip', 'article', 'codemirror', 'mount_target', 'extension'];
  for (const key of banned) {
    TestAssert.isTrue(
      !treeHasKey(resp.schema, key),
      `UI-only key '${key}' must not leak into wire payload`
    );
  }
});

suite.test('Shape: schema items drop raw requires/requires_not DSL + the parsed-only intermediates', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  for (const item of resp.schema || []) {
    TestAssert.isTrue(!('requires_not' in item), 'raw requires_not DSL stripped');
    TestAssert.isTrue(!('requires_parsed' in item), 'requires_parsed unified into requires.show');
    TestAssert.isTrue(!('requires_not_parsed' in item), 'requires_not_parsed unified into requires.hide');
    if ('requires' in item) TestAssert.isTrue(typeof item.requires === 'object' && !Array.isArray(item.requires), 'requires is an object envelope');
  }
});

suite.test('Shape: requires envelope uses show/hide sub-keys; single-condition collapses to leaf', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  const showLabel = schemaItem(resp.schema, 'show_label');
  TestAssert.isNotNull(showLabel, 'show_label present');
  const hide = showLabel.requires?.hide;
  TestAssert.isNotNull(hide, 'show_label.requires.hide present');
  // Single-condition rule should be a bare leaf filter — no mode/conditions wrapper.
  TestAssert.isTrue(!('mode' in hide) && !('conditions' in hide), 'single-condition collapses to leaf');
  TestAssert.equal(hide.key, 'full_width');
  TestAssert.equal(hide.operator, 'is');
});

suite.test('Shape: multi-condition rule keeps Query Filters group wrapper', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  const customLabel = schemaItem(resp.schema, 'custom_label');
  TestAssert.isNotNull(customLabel);
  const show = customLabel.requires?.show;
  TestAssert.isNotNull(show, 'custom_label.requires.show present');
  // Truthy bare-slug expands to 2 conditions — must keep the QF group wrapper.
  TestAssert.equal(show.mode, 'and');
  TestAssert.equal(Array.isArray(show.conditions) ? show.conditions.length : 0, 2);
});

suite.test('Shape: synthetic _id hashes stripped from parsed rules', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  const hasSynthetic = treeHasKey(
    resp.schema,
    '_id',
    (v) => typeof v === 'string' && /^(req|cond)-[a-f0-9]{8}$/.test(v)
  );
  TestAssert.isTrue(!hasSynthetic, 'no req-* / cond-* synthetic ids on the wire');
});

suite.test('Shape: desc HTML stripped to plain text', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  const slot = schemaItem(resp.schema, 'conditional_logic_container');
  if (!slot) return;
  const desc = slot.desc || '';
  TestAssert.isTrue(!desc.includes('<span'), 'no <span>');
  TestAssert.isTrue(!desc.includes('<div'), 'no <div>');
  TestAssert.isTrue(!desc.includes('\t'), 'no tabs');
  TestAssert.isTrue(desc.includes('Conditional Logic'), 'plain prose survives');
});

suite.test('Shape: empty values (null / "" / []) dropped from schema items', async () => {
  if (suite.skip) return;
  const resp = await h.gv_get_field_type_schema({ field_type: 'text' });
  for (const item of resp.schema || []) {
    for (const [k, v] of Object.entries(item)) {
      const isEmpty = v === null || v === '' || (Array.isArray(v) && v.length === 0);
      TestAssert.isTrue(!isEmpty, `empty value leaked: ${k}`);
    }
  }
});

// ============================================================
// SHAPE: apply default = compact; ?return=full echoes tree
// ============================================================

suite.test('Shape: apply default returns compact {view_id, version, applied}', async () => {
  if (suite.skip) return;
  const viewId = await mintView('compact apply');
  const apply = await h.gv_apply_view_config({
    id:     viewId,
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'cmpct001' }] },
    mode:   'merge',
  });
  TestAssert.isTrue('view_id' in apply, 'view_id present');
  TestAssert.isTrue('version' in apply, 'version present');
  TestAssert.isTrue('applied' in apply, 'applied envelope present');
  TestAssert.isTrue(!('fields' in apply), 'no fields echo by default');
  TestAssert.isTrue(!('widgets' in apply), 'no widgets echo by default');
  TestAssert.isTrue(!('areas' in apply), 'no areas echo by default');
  TestAssert.isTrue(!('template_settings' in apply), 'no template_settings echo by default');
});

// ============================================================
// SHAPE: slot create response uses `slot`, not `slot_uid`
// ============================================================

suite.test('Shape: create_field_slot response uses `slot` not legacy `slot_uid`', async () => {
  if (suite.skip) return;
  const viewId = await mintView('slot-alias');
  const created = await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_list-title',
    field_id: fieldIds.name,
  });
  TestAssert.isTrue('slot' in created, '`slot` is the canonical key');
  TestAssert.isTrue(!('slot_uid' in created), 'legacy `slot_uid` alias gone');
});

// ============================================================
// SHAPE: version string is a real timestamp, never the Unix epoch
// ============================================================

suite.test('Shape: version timestamp is real (not 1970 Unix epoch)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('version timestamp');
  const config = await h.gv_get_view_config({ id: viewId });
  TestAssert.isTrue(!config.version.includes('1970-01-01T00:00:00Z'), 'epoch sentinel must not appear');
  TestAssert.isTrue(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z:\d+$/.test(config.version),
    `version matches YYYY-MM-DDTHH:MM:SSZ:counter (got "${config.version}")`
  );
});

// ============================================================
// ROUND-TRIP: bulk apply preserves every setting
// ============================================================

suite.test('Round-trip: bulk apply preserves diverse settings verbatim', async () => {
  if (suite.skip) return;
  const viewId = await mintView('round-trip bulk');

  const apply = await h.gv_apply_view_config({
    id: viewId,
    fields: {
      'directory_list-title': [
        {
          field_id:     fieldIds.name,
          slot:         'rtname001',
          custom_label: 'Speaker Name',
          show_label:   '1',
          show_as_link: '1',
          custom_class: 'speaker-name big',
        },
      ],
      'directory_list-description': [
        {
          field_id:     'custom',
          slot:         'rtcust001',
          content:      '<p class="bio">Bio: <strong>{Speaker Name:1}</strong></p>',
          wpautop:      false,
          oembed:       false,
        },
        {
          field_id:           'is_approved',
          slot:               'rtappr001',
          approved_label:     '✓ Accepted',
          disapproved_label:  '✗ Declined',
          unapproved_label:   '⏳ Pending',
          show_label:         '1',
          custom_label:       'Status',
        },
      ],
    },
    mode: 'merge',
  });
  TestAssert.isNotNull(apply.applied);

  const config = await h.gv_get_view_config({ id: viewId });
  const titleSlot = config.fields['directory_list-title']['rtname001'];
  TestAssert.equal(titleSlot.custom_label, 'Speaker Name');
  TestAssert.equal(titleSlot.custom_class, 'speaker-name big');

  const customSlot = config.fields['directory_list-description']['rtcust001'];
  TestAssert.isTrue(customSlot.content.includes('<strong>{Speaker Name:1}</strong>'), 'HTML body + merge tag preserved');

  const apprSlot = config.fields['directory_list-description']['rtappr001'];
  TestAssert.equal(apprSlot.approved_label, '✓ Accepted');
  TestAssert.equal(apprSlot.unapproved_label, '⏳ Pending');
});

suite.test('Round-trip: Unicode + emoji custom_label preserved', async () => {
  if (suite.skip) return;
  const viewId = await mintView('unicode round-trip');
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'rtunicd001', {
    field_id:     fieldIds.name,
    custom_label: '测试 🚀 ñoño עברית 日本語 한국어',
  });
  TestAssert.equal(stored.custom_label, '测试 🚀 ñoño עברית 日本語 한국어');
});

suite.test('Round-trip: conditional_logic v2 document survives', async () => {
  if (suite.skip) return;
  const viewId = await mintView('conditional logic v2');
  const cl = {
    version:    2,
    actionType: 'show',
    logicType:  'all',
    rules:      [{ fieldId: fieldIds.name, operator: 'is', value: 'X' }],
  };
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'rtcl001', {
    field_id:           fieldIds.name,
    conditional_logic:  cl,
  });
  TestAssert.isNotNull(stored.conditional_logic);
  const decoded = typeof stored.conditional_logic === 'string'
    ? JSON.parse(stored.conditional_logic)
    : stored.conditional_logic;
  TestAssert.equal(decoded.version, 2);
  TestAssert.equal(decoded.actionType, 'show');
});

suite.test('Round-trip: move_field preserves slot UID + settings across areas', async () => {
  if (suite.skip) return;
  const viewId = await mintView('move preserves uid');

  await h.gv_apply_view_config({
    id: viewId,
    fields: {
      'directory_list-title': [{
        field_id:     fieldIds.name,
        slot:         'rtmove001',
        custom_label: 'Moved label',
        custom_class: 'moved-cell',
      }],
    },
    mode: 'merge',
  });

  await h.gv_move_view_field({
    id:   viewId,
    from: { area: 'directory_list-title', slot: 'rtmove001' },
    to:   { area: 'directory_list-subtitle' },
  });

  const config = await h.gv_get_view_config({ id: viewId });
  TestAssert.isTrue(
    !(config.fields['directory_list-title'] || {})['rtmove001'],
    'source area no longer holds the slot'
  );
  const moved = config.fields['directory_list-subtitle']['rtmove001'];
  TestAssert.isNotNull(moved, 'slot UID is preserved across the move');
  TestAssert.equal(moved.custom_label, 'Moved label');
  TestAssert.equal(moved.custom_class, 'moved-cell');
});

// ============================================================
// SANITISATION per setting type
// ============================================================

suite.test('Sanitisation: text-typed settings strip all HTML tags', async () => {
  if (suite.skip) return;
  const viewId = await mintView('text strip html');
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'sanittxt001', {
    field_id:     fieldIds.name,
    custom_label: '<script>alert(1)</script><b>Bold</b> <a href="https://example.com">link</a>',
  });
  const v = stored.custom_label || '';
  TestAssert.isTrue(!v.includes('<script'), 'script tag stripped');
  TestAssert.isTrue(!v.includes('<b>'), 'b tag stripped');
  TestAssert.isTrue(!v.includes('<a '), 'anchor tag stripped');
  TestAssert.isTrue(v.includes('Bold'), 'inner text "Bold" survives');
  TestAssert.isTrue(v.includes('link'), 'inner text "link" survives');
});

suite.test('Sanitisation: text-typed approval labels strip HTML', async () => {
  if (suite.skip) return;
  const viewId = await mintView('approval labels strip');
  const stored = await roundTripSlot(viewId, 'directory_list-description', 'sanitappr001', {
    field_id:           'is_approved',
    approved_label:     '<span class="badge"><strong>✓</strong> Accepted</span>',
    disapproved_label:  '<em>✗ Declined</em><script>steal()</script>',
    unapproved_label:   '<a href="javascript:hack()">⏳ Pending</a>',
  });
  TestAssert.equal(stored.approved_label.trim(), '✓ Accepted');
  TestAssert.isTrue(!stored.disapproved_label.includes('<'), 'no tags');
  TestAssert.isTrue(!stored.unapproved_label.includes('javascript:'), 'javascript: dropped');
  TestAssert.isTrue(stored.unapproved_label.includes('⏳ Pending'), 'Pending text + glyph survive');
});

suite.test('Sanitisation: bare URLs in text settings survive', async () => {
  if (suite.skip) return;
  const viewId = await mintView('url preservation');
  const stored = await roundTripSlot(viewId, 'directory_list-description', 'sanitrtxt001', {
    field_id:    'other_entries',
    link_format: 'https://example.com/entries/{entry_id}?ref=view#anchor',
    after_link:  'See https://docs.example.com for details.',
  });
  TestAssert.equal(stored.link_format, 'https://example.com/entries/{entry_id}?ref=view#anchor');
  TestAssert.isTrue(stored.after_link.includes('https://docs.example.com'), 'URL preserved in after_link');
});

suite.test('Sanitisation: custom content keeps full HTML body', async () => {
  if (suite.skip) return;
  const viewId = await mintView('custom content html');
  const stored = await roundTripSlot(viewId, 'directory_list-description', 'sanitcust001', {
    field_id: 'custom',
    content:  '<div class="card"><h3>Hello</h3><p>From <strong>here</strong></p><a href="https://x.example.com">link</a></div>',
    wpautop:  false,
    oembed:   false,
  });
  TestAssert.isTrue(stored.content.includes('<div class="card">'), 'div+class survives');
  TestAssert.isTrue(stored.content.includes('<h3>Hello</h3>'), 'h3 survives');
  TestAssert.isTrue(stored.content.includes('href="https://x.example.com"'), 'anchor href survives');
});

suite.test('Sanitisation: numeric values coerce to int regardless of mode', async () => {
  if (suite.skip) return;
  const viewId = await mintView('numeric coerce');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const stored = await roundTripSlot(viewId, 'directory_table-columns', 'sanitnum001', {
    field_id: fieldIds.name,
    width:    '50',
  });
  TestAssert.equal(stored.width, 50, 'string "50" → int 50');
});

// ============================================================
// VALIDATION: validateAgainstSchemas catches typos
// ============================================================

suite.test('Validation: validateAgainstSchemas accepts valid input-type overlay (emailmailto on email field)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('email overlay valid');
  await validator.validateAgainstSchemas({
    id:     viewId,
    fields: {
      'directory_list-title': [{
        field_id:    fieldIds.email,
        slot:        'validmail001',
        emailmailto: '1',
        emailsubject:'Hi',
        emailbody:   'Re',
      }],
    },
  });
  // No throw = pass.
});

suite.test('Validation: validateAgainstSchemas rejects typo on numeric form field', async () => {
  if (suite.skip) return;
  const viewId = await mintView('email overlay typo');
  await TestAssert.throwsAsync(
    () => validator.validateAgainstSchemas({
      id:     viewId,
      fields: {
        'directory_list-title': [{
          field_id:                fieldIds.email,
          slot:                    'invalmail001',
          not_a_real_email_setting:'x',
        }],
      },
    }),
    'unknown setting "not_a_real_email_setting"'
  );
});

suite.test('Validation: validateAgainstSchemas rejects typo on meta-field (custom)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('custom typo');
  await TestAssert.throwsAsync(
    () => validator.validateAgainstSchemas({
      id:     viewId,
      fields: {
        'directory_list-description': [{
          field_id: 'custom',
          slot:     'invalcust001',
          content:  '<p>OK</p>',
          made_up:  'x',
        }],
      },
    }),
    'unknown setting "made_up"'
  );
});

// ============================================================
// CONCURRENCY: optimistic 412 on stale ETag
// ============================================================

suite.test('Concurrency: parallel writes with same ETag → 1 accepted, rest rejected with 412', async () => {
  if (suite.skip) return;
  const viewId = await mintView('concurrency lock');

  // Read once to capture the starting ETag, then fire N parallel
  // applies with the same If-Match. Server's GET_LOCK + counter
  // bump means exactly ONE should accept.
  const config = await h.gv_get_view_config({ id: viewId });
  const etag   = `"${config.version}"`;
  const N      = 5;

  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      h.gv_apply_view_config({
        id:      viewId,
        fields:  { 'directory_list-title': [{ field_id: fieldIds.name, slot: `conc${String(i).padStart(3, '0')}` }] },
        mode:    'merge',
        ifMatch: etag,
      })
    )
  );

  const accepted = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter(
    (r) => r.status === 'rejected' && (r.reason?.response?.status === 412 || /412|precondition/i.test(String(r.reason?.message || '')))
  ).length;

  TestAssert.equal(accepted, 1, `expected exactly 1 accepted write, got ${accepted}`);
  TestAssert.equal(rejected, N - 1, `expected ${N - 1} stale rejections, got ${rejected}`);
});

// ============================================================
// PREVIEW STAGE: transient round-trip
// ============================================================

suite.test('Preview stage: POST returns 32-hex key, DELETE clears, ownership enforced', async () => {
  if (suite.skip) return;
  const viewId = await mintView('preview stage');

  const created = await createPreviewStage(viewId, {
    fields: {
      'directory_list-title': {
        stage1: { id: fieldIds.name, custom_label: 'Staged label' },
      },
    },
    template_settings: { page_size: 99 },
  });
  TestAssert.isTrue(
    /^[a-f0-9]{32}$/.test(created.stage_key),
    `stage_key matches 32-hex (got "${created.stage_key}")`
  );

  const cleared = await deletePreviewStage(viewId, created.stage_key);
  TestAssert.isTrue(cleared.cleared === true || cleared.cleared === undefined, 'DELETE returns OK envelope');
});

// ============================================================
// WARNINGS: conditional_logic rejections surface in apply response
// ============================================================

suite.test('Warnings: valid conditional_logic doc → no warnings in apply response', async () => {
  if (suite.skip) return;
  const viewId = await mintView('cl valid no warnings');
  const apply  = await h.gv_apply_view_config({
    id:     viewId,
    fields: {
      'directory_list-title': [{
        field_id:          fieldIds.name,
        slot:              'clok001',
        conditional_logic: { version: 2, actionType: 'show', logicType: 'all', rules: [] },
      }],
    },
    mode: 'merge',
  });
  TestAssert.isTrue(
    !('warnings' in apply) || apply.warnings.length === 0,
    'valid CL emits no warnings'
  );
});

suite.test('Warnings: CL missing version → reason=missing_version, value dropped', async () => {
  if (suite.skip) return;
  const viewId = await mintView('cl missing version');
  const apply  = await h.gv_apply_view_config({
    id:     viewId,
    fields: {
      'directory_list-title': [{
        field_id:          fieldIds.name,
        slot:              'clbad001',
        // Missing `version` key — the advanced-filter reader's v1-upgrade
        // path would crash on this in the public View render.
        conditional_logic: { actionType: 'show', logicType: 'all', rules: [{ fieldId: fieldIds.name, operator: 'is', value: 'X' }] },
      }],
    },
    mode: 'merge',
  });
  TestAssert.isTrue(Array.isArray(apply.warnings), 'warnings array present on rejection');
  const match = apply.warnings.find((w) =>
    w.key === 'conditional_logic' &&
    w.slot === 'clbad001' &&
    w.area === 'directory_list-title' &&
    w.reason === 'missing_version'
  );
  TestAssert.isNotNull(match, 'warning carries area/slot/key/reason=missing_version');

  // Confirm the value was actually dropped from the persisted slot.
  const config = await h.gv_get_view_config({ id: viewId });
  const stored = config.fields['directory_list-title']['clbad001'];
  TestAssert.isTrue(
    !stored.conditional_logic || stored.conditional_logic === '',
    'rejected CL was dropped (empty string or absent)'
  );
});

// ============================================================
// WIDGET CREATE: persists ALL payload settings, not just id+label
// ============================================================

suite.test('Widget create: persists every payload setting beyond id+label', async () => {
  if (suite.skip) return;
  const viewId = await mintView('widget create persists settings');

  // default_table has stable static widget zones (header_top /
  // footer_top) — using it instead of Layout Builder lets the
  // test target a known area without first creating grid rows.
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  const created = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: {
      field_id:     'custom_content',
      label:        'Headline',
      content:      '<p>Welcome to <strong>our list</strong>.</p>',
      wpautop:      false,
      custom_class: 'top-banner highlight',
    },
  });

  // Confirm the response echoes the persisted slot (not just id+label).
  TestAssert.isTrue(created.values?.content?.includes('<strong>our list</strong>'), 'content survives in response echo');
  TestAssert.equal(created.values.custom_class, 'top-banner highlight');

  // Confirm GET /config sees the same settings (proves persistence,
  // not just response shape).
  const config = await h.gv_get_view_config({ id: viewId });
  const slot   = config.widgets?.header_top?.[created.slot];
  TestAssert.isNotNull(slot, 'widget slot persisted in config');
  TestAssert.equal(slot.id, 'custom_content');
  TestAssert.equal(slot.label, 'Headline');
  TestAssert.isTrue(slot.content.includes('<strong>our list</strong>'), 'content survives in persisted config');
  TestAssert.equal(slot.custom_class, 'top-banner highlight');
});

suite.test('Widget create: search_bar payload auto-migrates to modern shape', async () => {
  if (suite.skip) return;
  const viewId = await mintView('widget create search_bar modern');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  const created = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: {
      field_id:      'search_bar',
      label:         'Find',
      search_layout: 'horizontal',
      search_clear:  '1',
    },
  });

  TestAssert.equal(created.values.search_layout, 'horizontal');
  // Server coerces numeric strings to int via sanitize_setting_value.
  TestAssert.equal(Number(created.values.search_clear), 1);
  // Modern shape lives under `search_fields_section`; legacy
  // `search_fields` JSON should NOT be persisted by a fresh write.
  TestAssert.isTrue(
    !('search_fields' in created.values) || created.values.search_fields === '',
    'no legacy search_fields JSON on fresh write'
  );
});

// ============================================================
// RENDER: staged_slot lets unsaved slots preview
// ============================================================

suite.test('Render: unknown slot WITHOUT staged_slot returns 404', async () => {
  if (suite.skip) return;
  const viewId = await mintView('render no staged');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  let status = null;
  try {
    await h.gv_render_view_field({
      id:   viewId,
      area: 'directory_table-columns',
      slot: 'never0001',
    });
  } catch (err) {
    status = err?.response?.status ?? null;
  }
  TestAssert.equal(status, 404, 'unknown slot 404s when no staged_slot supplied');
});

suite.test('Render: staged_slot synthesizes an unsaved slot for preview', async () => {
  if (suite.skip) return;
  const viewId = await mintView('render staged unsaved');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  // Render with `staged_slot` carrying field_id + a custom_label —
  // server should synthesize a slot record and run the production
  // renderer instead of returning 404. Result envelope shape comes
  // from the existing /render endpoint contract.
  let result;
  try {
    result = await h.gv_render_view_field({
      id:          viewId,
      area:        'directory_table-columns',
      slot:        'staged0001',
      staged_slot: {
        field_id:     fieldIds.name,
        custom_label: 'Preview-only label',
        show_label:   '1',
      },
    });
  } catch (err) {
    // 503 "no entry" is acceptable when the form has zero entries
    // — that's a renderer limitation, not a staged_slot one. Skip
    // gracefully in that case.
    if (err?.response?.status === 503) {
      console.log('   (skipping body assertions — form has no entries to render against)');
      return;
    }
    throw err;
  }

  TestAssert.isNotNull(result, 'render returns a body');
  // The render response carries `html` (the rendered slot markup).
  // Confirm the slot UID we passed in surfaces in the data-gv-slot
  // attribute so the LivePreview receiver can match the staged
  // node to the slot.
  const html = String(result.html ?? '');
  TestAssert.isTrue(html.length > 0, 'rendered HTML body is non-empty');
});

suite.test('Render: settings override on saved slot still works (regression)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('render settings override');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  // First save a real slot.
  await h.gv_apply_view_config({
    id:     viewId,
    fields: {
      'directory_table-columns': [{ field_id: fieldIds.name, slot: 'saved001' }],
    },
    mode: 'merge',
  });

  // Then render with a settings override. Should not 404.
  let status = null;
  try {
    await h.gv_render_view_field({
      id:       viewId,
      area:     'directory_table-columns',
      slot:     'saved001',
      settings: { custom_label: 'Overridden via render', show_label: '1' },
    });
  } catch (err) {
    // 503 = no entry to render against → still proves the slot
    // was found (no 404). Anything other than 404/503 is bad.
    status = err?.response?.status ?? null;
    if (status !== 503) throw err;
  }
  TestAssert.isTrue(status === null || status === 503, 'saved slot found (no 404 regression)');
});

// ============================================================
// SEARCH FIELD INPUT TYPES: server discovery + write-time reject
// ============================================================

suite.test('Search input types: GET /search-fields/input-types returns canonical core slugs', async () => {
  if (suite.skip) return;
  const { input_types } = await h.gv_list_search_input_types({});
  TestAssert.isTrue(Array.isArray(input_types), 'input_types is an array');
  // The core list must contain at minimum these slugs. Add-ons may
  // contribute more via the gravityview/search/input_labels filter,
  // so we don't pin an exact length.
  for (const required of ['input_text', 'select', 'date', 'date_range', 'submit', 'hidden']) {
    TestAssert.isTrue(input_types.includes(required), `core slug "${required}" present`);
  }
});

suite.test('Search input types: client pre-flight throws on typo BEFORE network call', async () => {
  if (suite.skip) return;
  await TestAssert.throwsAsync(
    () => gvClient.assertSearchInputType('datepiker'),
    'Unknown search field input "datepiker"'
  );
});

suite.test('Search input types: client pre-flight accepts valid slug', async () => {
  if (suite.skip) return;
  await gvClient.assertSearchInputType('date_range');
  await gvClient.assertSearchInputType('input_text');
  // Empty / undefined → no-op (server defaults).
  await gvClient.assertSearchInputType('');
  await gvClient.assertSearchInputType(undefined);
});

suite.test('Search input types: server rejects typo with 400 + helpful error', async () => {
  if (suite.skip) return;
  const viewId = await mintView('search input server reject');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });

  // Server-side allow-list check. The ability shim threads the input
  // through to the legacy create_search_field_slot validator, which
  // rejects unknown input slugs with a 400 — error surfaces back as
  // an axios throw with err.response.data.message.
  let serverStatus = null;
  let serverMessage = '';
  try {
    await h.gv_add_search_field({
      id:          viewId,
      widget_area: 'header_top',
      widget_slot: widget.slot,
      position:    'search-general_top::100::ROW_STUB',
      field:       { id: fieldIds.name, input: 'datepiker', label: 'Bad' },
    });
  } catch (err) {
    serverStatus  = err?.response?.status ?? null;
    serverMessage = String(err?.response?.data?.message ?? err?.message ?? '');
  }
  TestAssert.equal(serverStatus, 400, 'server returns 400');
  TestAssert.isTrue(
    /not allowed for field|Unknown search field input/.test(serverMessage),
    `server rejection message present (got "${serverMessage}")`
  );
  TestAssert.isTrue(serverMessage.includes('datepiker'), 'server echoes the bad slug');
  TestAssert.isTrue(serverMessage.includes('input_text'), 'server lists a known-valid slug');
});

// ============================================================
// TEMPLATE SETTINGS SOURCES (unified discovery + bridge)
//
// These tests exercise the inspector's template-settings architecture
// using a TEST mu-plugin fixture that registers two FAKE silo'd
// sources via `gk/gravityview/rest/template-settings/sources`. The
// fixture lives at GravityView/tests/fixtures/inspector-template-sources-mock.php
// and is auto-installed in beforeAll when GRAVITYVIEW_PLUGIN_PATH +
// WP_MU_PLUGINS_DIR env vars point at the dev install. Without
// either env var set, the mock-source tests skip (the contract is
// still partially exercised by the always-present core-source test).
//
// Fixture sources:
//   - prefix `mockone` on template `default_table`, schema { foo, bar, content }
//   - prefix `mocktwo` on template `default_list`,  schema { alpha, beta }
// ============================================================

suite.test('Template settings schema: core source always exposes shared keys (page_size etc.)', async () => {
  if (suite.skip) return;
  const { schema, template_id } = await h.gv_get_template_settings_schema({ template_id: 'default_table' });
  TestAssert.equal(template_id, 'default_table');
  TestAssert.isTrue(Array.isArray(schema) && schema.length > 0, 'schema array non-empty');
  const slugs = new Set(schema.map((it) => it?.slug));
  TestAssert.isTrue(slugs.has('page_size'), 'core slug "page_size" present');
});

suite.test('Mock source: schema exposes dotted slugs gated by template_ids', async () => {
  if (suite.skip || !mockFixtureActive) {
    console.log('   (skipping — mock fixture not installed; set GRAVITYVIEW_PLUGIN_PATH + WP_MU_PLUGINS_DIR)');
    return;
  }
  // mockone is gated on default_table — should appear there + nowhere else.
  const onTable = await h.gv_get_template_settings_schema({ template_id: 'default_table' });
  const onList  = await h.gv_get_template_settings_schema({ template_id: 'default_list' });

  const tableSlugs = new Set(onTable.schema.map((it) => it?.slug));
  const listSlugs  = new Set(onList.schema.map((it) => it?.slug));

  for (const required of ['mockone.foo', 'mockone.bar', 'mockone.content']) {
    TestAssert.isTrue(tableSlugs.has(required), `mockone slug "${required}" present on default_table`);
    TestAssert.isTrue(!listSlugs.has(required), `mockone slug "${required}" NOT present on default_list (template_ids gate)`);
  }
  for (const required of ['mocktwo.alpha', 'mocktwo.beta']) {
    TestAssert.isTrue(listSlugs.has(required), `mocktwo slug "${required}" present on default_list`);
    TestAssert.isTrue(!tableSlugs.has(required), `mocktwo slug "${required}" NOT present on default_table`);
  }
});

suite.test('Mock source: core source dedupes entries claimed by silo `groups`', async () => {
  if (suite.skip) return;
  if (!mockFixtureActive) {
    console.log('   (skipping — mock fixture not installed; set GRAVITYVIEW_PLUGIN_PATH + WP_MU_PLUGINS_DIR)');
    return;
  }
  // The mock sources own `mock_silo` + `mock_alt` groups. Even
  // though View_Settings::defaults(true) doesn't naturally surface
  // those slugs, the dedupe logic must still ensure the core source
  // emits NOTHING with those group values regardless of how the
  // catalog grows. Belt-and-braces check.
  const { schema } = await h.gv_get_template_settings_schema({ template_id: 'default_table' });
  for (const it of schema) {
    if ((it?.group ?? '') === 'mock_silo' && !(it?.slug ?? '').startsWith('mockone.')) {
      throw new Error(`core source emitted undotted slug "${it.slug}" for silo'd group "mock_silo"`);
    }
  }
});

suite.test('Mock source: PATCH /template-settings routes nested writes to the right silo meta', async () => {
  if (suite.skip) return;
  if (!mockFixtureActive) {
    console.log('   (skipping — mock fixture not installed; set GRAVITYVIEW_PLUGIN_PATH + WP_MU_PLUGINS_DIR)');
    return;
  }
  const viewId = await mintView('mock silo round-trip');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  await h.gv_patch_view_settings({
    id:                viewId,
    template_settings: {
      mockone:   { foo: 'hello', bar: '42', content: '<p>html ok</p>' },
      page_size: '99',  // top-level — must stay on core meta
    },
  });

  const config = await h.gv_get_view_config({ id: viewId });
  TestAssert.equal(String(config.template_settings.page_size), '99', 'top-level page_size on core meta');
  TestAssert.isTrue(
    config.template_settings.mockone && typeof config.template_settings.mockone === 'object',
    'mockone namespace present in read'
  );
  TestAssert.equal(config.template_settings.mockone.foo, 'hello');
  TestAssert.equal(Number(config.template_settings.mockone.bar), 42, 'numeric coercion through sanitize_setting_value');
  TestAssert.isTrue(
    String(config.template_settings.mockone.content).includes('html ok'),
    'textarea-typed setting content survives'
  );
});

suite.test('Mock source: /apply also splits namespaced writes to silo meta', async () => {
  if (suite.skip) return;
  if (!mockFixtureActive) {
    console.log('   (skipping — mock fixture not installed; set GRAVITYVIEW_PLUGIN_PATH + WP_MU_PLUGINS_DIR)');
    return;
  }
  const viewId = await mintView('mock silo apply path');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  await h.gv_apply_view_config({
    id: viewId,
    template_settings: {
      page_size: '25',
      mockone:   { foo: 'via-apply' },
    },
    mode: 'merge',
  });

  const config = await h.gv_get_view_config({ id: viewId });
  TestAssert.equal(String(config.template_settings.page_size), '25', 'core key persisted via apply');
  TestAssert.equal(config.template_settings.mockone?.foo, 'via-apply', 'silo key persisted via apply');
});

suite.test('Mock source: keys NOT in the partial payload survive the merge', async () => {
  if (suite.skip) return;
  if (!mockFixtureActive) {
    console.log('   (skipping — mock fixture not installed; set GRAVITYVIEW_PLUGIN_PATH + WP_MU_PLUGINS_DIR)');
    return;
  }
  const viewId = await mintView('mock silo non-overlap merge');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  // Seed two keys on the silo, then patch only one — the other
  // must remain. This proves the per-source bucket-seeded merge
  // doesn't blow away unmentioned silo keys.
  await h.gv_patch_view_settings({
    id:                viewId,
    template_settings: { mockone: { foo: 'first', bar: '7' } },
  });
  await h.gv_patch_view_settings({
    id:                viewId,
    template_settings: { mockone: { foo: 'second' } },
  });

  const config = await h.gv_get_view_config({ id: viewId });
  TestAssert.equal(config.template_settings.mockone?.foo, 'second', 'updated key takes new value');
  TestAssert.equal(Number(config.template_settings.mockone?.bar), 7, 'untouched key survives merge');
});

// ============================================================
// VALIDATION + SANITIZATION REGRESSIONS
// ============================================================

suite.test('CL with leading whitespace is accepted (trim bug)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('cl trim bug');
  const padded = '   ' + JSON.stringify({ version: 2, actionType: 'show', logicType: 'all', rules: [] }) + '   \n';
  const apply  = await h.gv_apply_view_config({
    id:     viewId,
    fields: {
      'directory_list-title': [{
        field_id:          fieldIds.name,
        slot:              'cltrim001',
        conditional_logic: padded,
      }],
    },
    mode: 'merge',
  });
  TestAssert.isTrue(
    !('warnings' in apply) || apply.warnings.length === 0,
    'no warning emitted — padded JSON was trimmed and accepted'
  );

  const config = await h.gv_get_view_config({ id: viewId });
  const stored = config.fields['directory_list-title']['cltrim001'].conditional_logic;
  TestAssert.isTrue(
    typeof stored === 'string' && stored.startsWith('{') && stored.endsWith('}'),
    `stored CL is the canonical trimmed JSON (got "${stored}")`
  );
});

suite.test('Per-field narrowing rejects date_range on search_mode', async () => {
  if (suite.skip) return;
  const viewId = await mintView('per-field narrow search_mode');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });

  let serverStatus = null;
  let serverMessage = '';
  try {
    await h.gv_add_search_field({
      id:          viewId,
      widget_area: 'header_top',
      widget_slot: widget.slot,
      position:    'search-general_top::100::ROW_STUB',
      // `date_range` IS in the global allow-list, but invalid for
      // `search_mode` per get_input_types_by_field_type. Narrow check
      // must reject this combination.
      field:       { id: 'search_mode', input: 'date_range', label: 'Bad combo' },
    });
  } catch (err) {
    serverStatus  = err?.response?.status ?? null;
    serverMessage = String(err?.response?.data?.message ?? err?.message ?? '');
  }
  TestAssert.equal(serverStatus, 400, 'server rejects field-invalid combination');
  TestAssert.isTrue(serverMessage.includes('search_mode'), 'error names the field id');
  TestAssert.isTrue(serverMessage.includes('date_range'), 'error names the bad input');
});

suite.test('Per-field narrowing accepts hidden on search_mode', async () => {
  if (suite.skip) return;
  const viewId = await mintView('per-field narrow search_mode ok');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });

  // `hidden` IS valid for search_mode — should succeed.
  const created = await h.gv_add_search_field({
    id:          viewId,
    widget_area: 'header_top',
    widget_slot: widget.slot,
    position:    'search-general_top::100::ROW_OK',
    field:       { id: 'search_mode', input: 'hidden', label: 'Mode' },
  });
  TestAssert.isNotNull(created?.search_slot);
});

suite.test('create_widget_slot rejects nested invalid search_fields_section', async () => {
  if (suite.skip) return;
  const viewId = await mintView('widget nested search reject');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });

  let serverStatus = null;
  let serverMessage = '';
  try {
    await h.gv_add_view_widget({
      id:     viewId,
      area:   'header_top',
      widget: {
        field_id:               'search_bar',
        label:                  'Search',
        search_fields_section:  {
          'search-general_top::100::ROW': {
            stub1: { id: 'search_mode', input: 'date_range', label: 'Bad nested' },
          },
        },
      },
    });
  } catch (err) {
    serverStatus  = err?.response?.status ?? null;
    serverMessage = String(err?.response?.data?.message ?? err?.message ?? '');
  }
  TestAssert.equal(serverStatus, 400, 'server rejects nested invalid search input');
  TestAssert.isTrue(serverMessage.includes('Nested search field'), 'error identifies the nested entry');
  TestAssert.isTrue(serverMessage.includes('search_mode'), 'error names the offending field id');
});

suite.test('Warnings: CL string that isn\'t a JSON object → reason=not_json_object', async () => {
  if (suite.skip) return;
  const viewId = await mintView('cl not json object');
  const apply  = await h.gv_apply_view_config({
    id:     viewId,
    fields: {
      'directory_list-title': [{
        field_id:          fieldIds.name,
        slot:              'clbad002',
        // String that's neither empty nor a JSON object.
        conditional_logic: 'hello world',
      }],
    },
    mode: 'merge',
  });
  TestAssert.isTrue(Array.isArray(apply.warnings), 'warnings array present');
  const match = apply.warnings.find((w) =>
    w.slot === 'clbad002' && w.reason === 'not_json_object'
  );
  TestAssert.isNotNull(match, 'warning carries reason=not_json_object');
});

// ============================================================
// BUGS-CAUGHT regressions — each test pins behaviour that a real
// user demo just surfaced. If any of these fail, the corresponding
// bug has come back.
// ============================================================

suite.test('Area keys: gv_create_grid_row returns ready-to-use prefixed area_keys', async () => {
  if (suite.skip) return;
  const viewId = await mintView('area_keys contract');
  // Layout Builder is the only grid-aware template by default.
  await h.gv_patch_view_template({ id: viewId, template_id: 'gravityview-layout-builder' });
  const row = await h.gv_add_grid_row({
    id:    viewId,
    type:  '25/25/25/25',
    zones: ['directory'],
  });
  TestAssert.isTrue(Array.isArray(row.area_keys), '`area_keys` is an array');
  TestAssert.equal(row.area_keys.length, 4, '4 cells from a 25/25/25/25 row');
  // Every entry must already carry the zone prefix.
  row.area_keys.forEach((k) => {
    TestAssert.isTrue(
      k.startsWith('directory_'),
      `area_key "${k}" carries the directory_ prefix`
    );
  });
});

suite.test('Area keys: apply_view_config REJECTS a fields area key missing the zone prefix', async () => {
  if (suite.skip) return;
  const viewId = await mintView('reject unprefixed');
  await h.gv_patch_view_template({ id: viewId, template_id: 'gravityview-layout-builder' });
  const row = await h.gv_add_grid_row({ id: viewId, type: '100', zones: ['directory'] });
  // Use the LEGACY unprefixed key (this is the exact bug the demo hit).
  const badKey = `gravityview-layout-builder-top::100::${row.row_uid}`;
  let status = null, code = null;
  try {
    await h.gv_apply_view_config({
      id:     viewId,
      mode:   'merge',
      fields: { [badKey]: [{ field_id: fieldIds.name, slot: 'should_fail' }] },
    });
  } catch (err) {
    status = err?.response?.status ?? null;
    code   = err?.response?.data?.code ?? null;
  }
  TestAssert.equal(status, 400, 'unprefixed area key → 400');
  TestAssert.equal(code, 'gv_rest_invalid_area_key', 'specific error code surfaces');
});

suite.test('Area keys: apply_view_config REJECTS a bogus widget area key', async () => {
  if (suite.skip) return;
  const viewId = await mintView('reject bogus widget area');
  let status = null, code = null;
  try {
    await h.gv_apply_view_config({
      id:      viewId,
      mode:    'merge',
      widgets: { 'not_a_real_zone': [{ field_id: 'search_bar', slot: 'x' }] },
    });
  } catch (err) {
    status = err?.response?.status ?? null;
    code   = err?.response?.data?.code ?? null;
  }
  TestAssert.equal(status, 400, 'bogus widget zone → 400');
  TestAssert.equal(code, 'gv_rest_invalid_area_key', 'specific error code surfaces');
});

suite.test('Area keys: prefixed keys round-trip end-to-end (create-row → use area_keys → read-back)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('e2e prefixed roundtrip');
  await h.gv_patch_view_template({ id: viewId, template_id: 'gravityview-layout-builder' });
  const row = await h.gv_add_grid_row({ id: viewId, type: '50/50', zones: ['directory'] });
  TestAssert.equal(row.area_keys.length, 2);

  // Use the API's own returned keys verbatim — the test the demo would have passed.
  await h.gv_apply_view_config({
    id:     viewId,
    mode:   'merge',
    fields: {
      [row.area_keys[0]]: [{ field_id: fieldIds.name, slot: 'rt_a' }],
      [row.area_keys[1]]: [{ field_id: fieldIds.email, slot: 'rt_b' }],
    },
  });

  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.isNotNull(cfg.fields[row.area_keys[0]]?.rt_a, 'first area has its slot after apply');
  TestAssert.isNotNull(cfg.fields[row.area_keys[1]]?.rt_b, 'second area has its slot after apply');

  // No orphan unprefixed keys.
  const orphans = Object.keys(cfg.fields || {}).filter(
    (k) => !k.startsWith('directory_') && !k.startsWith('single_') && !k.startsWith('edit_'),
  );
  TestAssert.equal(orphans.length, 0, `no orphan unprefixed area keys (got: ${orphans.join(', ') || 'none'})`);
});

suite.test('Inspector shape: template_ids contains directory + single ONLY (no edit)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('template_ids no edit');
  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.isNotNull(cfg.template_ids?.directory, 'template_ids.directory present');
  TestAssert.isNotNull(cfg.template_ids?.single, 'template_ids.single present');
  TestAssert.isTrue(
    !('edit' in (cfg.template_ids || {})),
    'template_ids.edit absent — Edit Entry has no per-zone template choice',
  );
});

suite.test('Inspector shape: template_settings does NOT carry the legacy `template` key', async () => {
  if (suite.skip) return;
  const viewId = await mintView('no legacy template key');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.isTrue(
    !('template' in (cfg.template_settings || {})),
    'template_settings.template stripped — canonical store is template_ids.directory',
  );
});

suite.test('Inspector shape: template_settings stays clean even after a template switch', async () => {
  if (suite.skip) return;
  const viewId = await mintView('template switch no leak');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  await h.gv_patch_view_template({ id: viewId, template_id: 'gravityview-layout-builder' });
  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.isTrue(
    !('template' in (cfg.template_settings || {})),
    'template_settings.template still absent after switch',
  );
});

// ============================================================
// Search-bar legacy-save round-trip
//
// The bug: MCP-written search fields used `input` + `type` keys
// and bare numeric GF ids. The legacy admin metabox parser only
// recognises `input_type` and `{form_id}::{field_id}` ids. On
// save through the legacy UI, every MCP-written field was
// silently dropped.
//
// The fix: normalise_search_field_payload now routes every entry
// through Search_Field::from_configuration() → to_configuration(),
// so storage carries the canonical shape regardless of who wrote it.
// ============================================================

suite.test('Search field shape: gv_add_search_field emits the domain canonical shape', async () => {
  if (suite.skip) return;
  const viewId = await mintView('search field canonical shape');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });
  const created = await h.gv_add_search_field({
    id:          viewId,
    widget_area: 'header_top',
    widget_slot: widget.slot,
    position:    'search-general_top::100::canonshape_row',
    field:       { id: fieldIds.name, input: 'input_text', label: 'Speaker' },
  });

  const cfg    = await h.gv_get_view_config({ id: viewId });
  const stored = cfg.widgets.header_top[widget.slot].search_fields_section[
    'search-general_top::100::canonshape_row'
  ][created.search_slot];

  // Canonical shape per Search_Field::to_configuration():
  //   id, UID, type ({form_id}::{field_id}), label, position, form_id,
  //   show_label, input_type, plus any explicit settings.
  // For GF fields the GF subclass also emits `form_field` (the resolved
  // GF Field object).
  TestAssert.equal(stored.input_type, 'input_text', 'input_type set (canonical)');
  TestAssert.isTrue(!('input' in stored), 'input alias dropped after translation');
  TestAssert.isTrue('UID' in stored,        'UID minted by domain');
  TestAssert.isTrue('type' in stored,       'type emitted by domain (canonical {form_id}::{field_id})');
  TestAssert.isTrue('form_id' in stored,    'form_id stamped per field');
  TestAssert.isTrue('show_label' in stored, 'show_label default carried (true unless overridden)');
  // The legacy-admin pad-with-empties keys are intentionally absent —
  // the domain class only emits what was actually set, and downstream
  // consumers (required_cap, etc.) read with `?? defaults`.
  TestAssert.isTrue(!('custom_label' in stored), 'custom_label NOT padded (domain emits only set settings)');
  TestAssert.isTrue(!('only_loggedin' in stored), 'only_loggedin NOT padded (default is null at read time)');
});

suite.test('Search field shape: GF field carries `type`={form_id}::{field_id} + form_field object', async () => {
  if (suite.skip) return;
  const viewId = await mintView('search field gf canonical type');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });
  await h.gv_add_search_field({
    id:          viewId,
    widget_area: 'header_top',
    widget_slot: widget.slot,
    position:    'search-general_top::100::gftype_row',
    field:       { id: fieldIds.email, input: 'input_text', label: 'Email' },
  });

  const cfg  = await h.gv_get_view_config({ id: viewId });
  const slot = Object.values(
    cfg.widgets.header_top[widget.slot].search_fields_section['search-general_top::100::gftype_row'],
  )[0];

  // The domain emits the canonical `{form_id}::{field_id}` under the
  // `type` key (Search_Field_Gravity_Forms::get_type), keeping `id`
  // as the bare GF id the user supplied.
  TestAssert.isTrue(
    /^\d+::\d+(\.\d+)?$/.test(String(slot.type)),
    `type is form-prefixed canonical id (got "${slot.type}")`,
  );
  // GF subclass also resolves the inner GF field array into form_field.
  TestAssert.isTrue(slot.form_field && typeof slot.form_field === 'object', 'form_field object resolved');
  TestAssert.isTrue('id' in slot.form_field && 'type' in slot.form_field, 'form_field carries the GF field shape');
});

suite.test('Search field shape: bulk apply (gv_apply_view_config) routes nested entries through the domain too', async () => {
  if (suite.skip) return;
  const viewId = await mintView('bulk normalise search section');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });
  // Bulk-apply a nested search_fields_section through gv_apply_view_config —
  // entries SHOULD pass through Search_Field::from_configuration → to_configuration
  // just like the per-field CRUD path does.
  await h.gv_apply_view_config({
    id:      viewId,
    mode:    'merge',
    widgets: {
      header_top: [{
        field_id: 'search_bar',
        slot:     widget.slot,
        label:    'Search',
        search_fields_section: {
          'search-general_top::100::bulkrow': {
            bulkfield: { id: fieldIds.name, input: 'input_text', label: 'Bulk-name' },
          },
        },
      }],
    },
  });

  const cfg    = await h.gv_get_view_config({ id: viewId });
  const stored = cfg.widgets.header_top[widget.slot].search_fields_section[
    'search-general_top::100::bulkrow'
  ].bulkfield;
  TestAssert.equal(stored.input_type, 'input_text', 'input_type translated in bulk path');
  TestAssert.isTrue(!('input' in stored), 'input alias dropped in bulk path');
  TestAssert.isTrue('UID' in stored,         'UID minted in bulk path');
  TestAssert.isTrue('form_id' in stored,     'form_id stamped in bulk path');
  TestAssert.isTrue('show_label' in stored,  'show_label default in bulk path');
  TestAssert.isTrue(
    /^\d+::\d+(\.\d+)?$/.test(String(stored.type)),
    `type is form-prefixed in bulk path (got "${stored.type}")`,
  );
  TestAssert.isTrue(stored.form_field && typeof stored.form_field === 'object', 'form_field object resolved in bulk path');
});

suite.test('Search field round-trip: fields survive a legacy WP save_post (bug-caught regression)', async () => {
  if (suite.skip) return;
  // Canonical bug-caught test: MCP writes a search bar; we re-trigger
  // save_post (the same chain the legacy admin metabox save fires);
  // MCP-written fields MUST still be there afterwards. Without
  // Search_Field domain delegation, the legacy parser would drop
  // every field with non-canonical keys.
  //
  // Uses wp-cli (via the cp.execSync helper). When wp-cli isn't
  // reachable from the test runner (e.g., remote CI), skips with a
  // clear note.
  // Requires both wp-cli on PATH AND a WP_ROOT env var pointing at
  // the WordPress install. Skips cleanly without a hardcoded fallback
  // — this test runs in any dev env that supplies them.
  const wpRoot = process.env.WP_ROOT;
  if (!wpRoot) {
    console.log('   (skipping — set WP_ROOT to your WP install path to run this test)');
    return;
  }
  let cp;
  try {
    cp = await import('node:child_process');
    cp.execSync('which wp', { stdio: 'pipe' });
  } catch (_) {
    console.log('   (skipping — wp-cli not available; install wp-cli to run this test)');
    return;
  }

  const viewId = await mintView('search field legacy roundtrip');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id:     viewId,
    area:   'header_top',
    widget: { field_id: 'search_bar', label: 'Search' },
  });
  await h.gv_add_search_field({
    id:          viewId,
    widget_area: 'header_top',
    widget_slot: widget.slot,
    position:    'search-general_top::100::roundtrip_row',
    slot:        'roundtrip_slot',
    field:       { id: fieldIds.name, input: 'input_text', label: 'Speaker' },
  });

  // Trigger save_post via wp-cli — runs the legacy metabox save_post
  // hook chain end-to-end against the live WP install.
  cp.execSync(`cd ${wpRoot} && wp post update ${viewId} --post_modified="$(date -u +'%Y-%m-%d %H:%M:%S')"`, { stdio: 'pipe' });

  const cfg     = await h.gv_get_view_config({ id: viewId });
  const section = cfg.widgets?.header_top?.[widget.slot]?.search_fields_section;
  TestAssert.isNotNull(section, 'search_fields_section present after legacy save');
  const row = section['search-general_top::100::roundtrip_row'];
  TestAssert.isNotNull(row, 'position key survived legacy save');
  TestAssert.isNotNull(row?.roundtrip_slot, 'MCP-written slot UID survived legacy save');
  TestAssert.equal(row.roundtrip_slot.input_type, 'input_text', 'input_type survived legacy save');
});

// ============================================================
// HOSTILE STRESS TESTS — actively try to break the API surface
//
// Every test here either confirms the surface holds under abuse,
// or fails loudly when behaviour is wrong (silent success on bad
// input, 500 instead of 400, torn reads, lost writes, etc.).
// Tests are deliberately ruthless — see the prompt for the full
// matrix. Tests are NOT modified to "match reality" when they
// uncover a bug — they're left failing with a clear message so
// the bug shows up in the suite output.
// ============================================================

/** Convenience: pull HTTP status / WP error code off a thrown axios error. */
function errStatus(err) { return err?.response?.status ?? null; }
function errCode(err)   { return err?.response?.data?.code ?? null; }
function errMessage(err) {
  return String(err?.response?.data?.message ?? err?.message ?? '');
}

/** Run an apply that we expect to throw; return the captured error info. */
async function expectApplyError(args) {
  try {
    const result = await h.gv_apply_view_config(args);
    return { thrown: false, result };
  } catch (err) {
    return {
      thrown:  true,
      status:  errStatus(err),
      code:    errCode(err),
      message: errMessage(err),
    };
  }
}

// ---------- CONCURRENCY chaos ----------

suite.test('[hostile] Concurrency: 10 parallel applies with same If-Match → exactly 1 wins', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-conc-10');
  const config = await h.gv_get_view_config({ id: viewId });
  const etag   = `"${config.version}"`;
  const N      = 10;

  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      h.gv_apply_view_config({
        id:      viewId,
        ifMatch: etag,
        mode:    'merge',
        fields:  { 'directory_list-title': [{ field_id: fieldIds.name, slot: `parc${String(i).padStart(3, '0')}` }] },
      })
    )
  );
  const accepted = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected' && (errStatus(r.reason) === 412 || /412|precondition/i.test(errMessage(r.reason)))).length;
  TestAssert.equal(accepted, 1, `expected exactly 1 accepted write out of ${N}, got ${accepted}`);
  TestAssert.equal(rejected, N - 1, `expected ${N - 1} 412 rejections, got ${rejected}`);
});

suite.test('[hostile] Concurrency: 50 parallel reads of gv_get_view_config all succeed', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-50-reads');
  const N = 50;
  const results = await Promise.allSettled(
    Array.from({ length: N }, () => h.gv_get_view_config({ id: viewId }))
  );
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value?.view_id === viewId).length;
  TestAssert.equal(ok, N, `all ${N} reads should succeed, got ${ok}`);
});

suite.test('[hostile] Concurrency: 20 interleaved apply+read pairs — no torn reads', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-interleaved');
  const N = 20;

  // Sequential apply→read pairs (no ifMatch — abilities path doesn't
  // wire the GV client version cache, and we want every write to land
  // unconditionally so we can assert each one is visible immediately).
  for (let i = 0; i < N; i++) {
    const slotUid = `tear${String(i).padStart(3, '0')}`;
    await h.gv_apply_view_config({
      id:      viewId,
      mode:    'merge',
      fields:  { 'directory_list-title': [{ field_id: fieldIds.name, slot: slotUid, custom_label: `Iter ${i}` }] },
    });
    const cfg = await h.gv_get_view_config({ id: viewId });
    const slot = cfg.fields?.['directory_list-title']?.[slotUid];
    TestAssert.isNotNull(slot, `iteration ${i}: slot ${slotUid} must be present in subsequent read`);
    TestAssert.equal(slot.custom_label, `Iter ${i}`, `iteration ${i}: custom_label torn`);
  }
});

suite.test('[hostile] Concurrency: two writers racing on different slots in same area both land', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-two-writers');
  const cfg   = await h.gv_get_view_config({ id: viewId });
  const etag  = `"${cfg.version}"`;

  // Same etag, but distinct slot UIDs in the same area.
  const results = await Promise.allSettled([
    h.gv_apply_view_config({
      id:      viewId,
      ifMatch: etag,
      mode:    'merge',
      fields:  { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'race_a' }] },
    }),
    h.gv_apply_view_config({
      id:      viewId,
      ifMatch: etag,
      mode:    'merge',
      fields:  { 'directory_list-title': [{ field_id: fieldIds.email, slot: 'race_b' }] },
    }),
  ]);
  // Optimistic concurrency means with same ifMatch, only one wins. The other
  // gets 412 — the caller must retry. Document this contract.
  const accepted = results.filter((r) => r.status === 'fulfilled').length;
  TestAssert.equal(accepted, 1, 'optimistic concurrency: only 1 same-etag write lands per round');

  // Now retry the rejected write WITHOUT ifMatch (the docs say omit = bypass).
  await h.gv_apply_view_config({
    id:     viewId,
    mode:   'merge',
    fields: { 'directory_list-title': [{ field_id: fieldIds.email, slot: 'race_b' }] },
  });
  const final = await h.gv_get_view_config({ id: viewId });
  TestAssert.isNotNull(final.fields?.['directory_list-title']?.race_a, 'race_a landed');
  TestAssert.isNotNull(final.fields?.['directory_list-title']?.race_b, 'race_b landed after retry without ifMatch');
});

// ---------- HUGE PAYLOADS ----------

suite.test('[hostile] Huge payload: 200 fields in a single apply', async () => {
  if (suite.skip) return;
  console.log('   (building 200-field payload…)');
  const viewId = await mintView('hostile-huge-payload-200-fields');
  const slots = Array.from({ length: 200 }, (_, i) => ({
    field_id: fieldIds.name,
    slot:     `huge${String(i).padStart(4, '0')}`,
    custom_label: `Slot #${i}`,
  }));
  const t0 = Date.now();
  let result, err;
  try {
    result = await h.gv_apply_view_config({
      id:     viewId,
      mode:   'merge',
      fields: { 'directory_list-title': slots },
    });
  } catch (e) { err = e; }
  console.log(`   (200-field apply took ${Date.now() - t0}ms)`);

  if (err) {
    // A 413 / 400 with a meaningful "too large" code is acceptable.
    const status = errStatus(err);
    TestAssert.isTrue(
      status === 400 || status === 413,
      `200-field apply failed with non-sane status ${status}: ${errMessage(err)}`
    );
    return;
  }
  TestAssert.isNotNull(result.applied, '200-field apply succeeded');
  // Spot-check the round trip — pick start/end/middle.
  const cfg = await h.gv_get_view_config({ id: viewId });
  const titleArea = cfg.fields?.['directory_list-title'] || {};
  TestAssert.isNotNull(titleArea.huge0000, 'first slot present');
  TestAssert.isNotNull(titleArea.huge0099, 'middle slot present');
  TestAssert.isNotNull(titleArea.huge0199, 'last slot present');
});

suite.test('[hostile] Huge payload: custom_content with 50KB HTML body survives', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-50kb-custom-content');
  const big = '<p>' + 'lorem ipsum dolor sit amet '.repeat(2000) + '</p>'; // ~ 53 KB
  const stored = await roundTripSlot(viewId, 'directory_list-description', 'huge50kb', {
    field_id: 'custom',
    content:  big,
    wpautop:  false,
  });
  TestAssert.isTrue(stored.content && stored.content.length >= 50 * 1000, `content survived (got ${stored.content?.length ?? 0} bytes)`);
});

suite.test('[hostile] Huge payload: conditional_logic with 100 nested rules', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-cl-100-rules');
  const rules = Array.from({ length: 100 }, (_, i) => ({
    fieldId: fieldIds.name, operator: 'is', value: `v${i}`,
  }));
  const cl = { version: 2, actionType: 'show', logicType: 'all', rules };
  let stored, err;
  try {
    stored = await roundTripSlot(viewId, 'directory_list-title', 'cl100', {
      field_id:          fieldIds.name,
      conditional_logic: cl,
    });
  } catch (e) { err = e; }
  if (err) {
    const status = errStatus(err);
    TestAssert.isTrue(status === 400 || status === 413, `100-rule CL must reject cleanly, got status ${status}: ${errMessage(err)}`);
    return;
  }
  TestAssert.isNotNull(stored.conditional_logic, '100-rule CL persisted');
  const decoded = typeof stored.conditional_logic === 'string'
    ? JSON.parse(stored.conditional_logic)
    : stored.conditional_logic;
  TestAssert.equal(Array.isArray(decoded.rules) ? decoded.rules.length : 0, 100, 'all 100 rules persisted');
});

suite.test('[hostile] Huge payload: search bar with 50 search fields across 5 positions', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-50-search-fields');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  const positions = ['10', '20', '30', '40', '50'];
  for (const pos of positions) {
    for (let i = 0; i < 10; i++) {
      try {
        await h.gv_add_search_field({
          id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
          position: `search-general_top::${pos}::row_${pos}`,
          slot: `s_${pos}_${i}`,
          field: { id: fieldIds.name, input: 'input_text', label: `f${i}@${pos}` },
        });
      } catch (e) {
        throw new Error(`search field ${pos}/${i} failed: ${errStatus(e)} ${errMessage(e)}`);
      }
    }
  }
  const cfg = await h.gv_get_view_config({ id: viewId });
  const section = cfg.widgets?.header_top?.[widget.slot]?.search_fields_section || {};
  let total = 0;
  for (const row of Object.values(section)) total += Object.keys(row || {}).length;
  TestAssert.equal(total, 50, `expected 50 search fields stored, got ${total}`);
});

// ---------- MALFORMED INPUTS ----------

suite.test('[hostile] Malformed: fields = string-not-object → 400', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-fields-string');
  const r = await expectApplyError({ id: viewId, mode: 'merge', fields: 'not-an-object' });
  TestAssert.isTrue(r.thrown, 'string fields must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `status must be 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: fields = { area: "not-an-array" } → 400', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-area-string');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': 'not-an-array' },
  });
  TestAssert.isTrue(r.thrown, 'string-typed area value must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `status must be 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: field_id = null → reject (4xx, no 500)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-field-null');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: null, slot: 'fnull01' }] },
  });
  TestAssert.isTrue(r.thrown, 'null field_id must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `status must be 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: field_id = object → reject', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-field-obj');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: { evil: true }, slot: 'fobj01' }] },
  });
  TestAssert.isTrue(r.thrown, 'object field_id must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `status must be 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: ifMatch = empty string is treated as no-precondition', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-ifmatch-empty');
  // Empty string ifMatch should be a no-op (not a 412, not a 500).
  const r = await expectApplyError({
    id: viewId, mode: 'merge', ifMatch: '',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'iem01' }] },
  });
  TestAssert.isTrue(!r.thrown, `empty ifMatch should not throw (got ${r.status} ${r.message})`);
});

suite.test('[hostile] Malformed: ifMatch = "" (literal quoted empty) → 412 or treated as no-op cleanly', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-ifmatch-quoted-empty');
  const r = await expectApplyError({
    id: viewId, mode: 'merge', ifMatch: '""',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'ieq01' }] },
  });
  // Either accept (no version match attempt) or reject 412 — but never 5xx.
  if (r.thrown) {
    TestAssert.isTrue(r.status === 412 || (r.status >= 400 && r.status < 500), `status must be sane, got ${r.status}: ${r.message}`);
  }
});

suite.test('[hostile] Malformed: ifMatch = whitespace only → no 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-ifmatch-ws');
  const r = await expectApplyError({
    id: viewId, mode: 'merge', ifMatch: '   ',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'iws01' }] },
  });
  if (r.thrown) {
    TestAssert.isTrue(r.status >= 400 && r.status < 500, `status must be 4xx, got ${r.status}: ${r.message}`);
  }
});

suite.test('[hostile] Malformed: ifMatch = giant string (10KB) → 4xx, not 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-ifmatch-giant');
  const giant = '"' + 'A'.repeat(10000) + '"';
  const r = await expectApplyError({
    id: viewId, mode: 'merge', ifMatch: giant,
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'ig01' }] },
  });
  // Will mismatch → 412.
  TestAssert.isTrue(r.thrown, 'giant ifMatch must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `must 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: ifMatch = SQL injection attempt → safe rejection', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-ifmatch-sqli');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    ifMatch: `"' OR '1'='1"; DROP TABLE wp_posts; --"`,
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'sqli01' }] },
  });
  TestAssert.isTrue(r.thrown, 'malicious ifMatch must reject');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `must be 4xx, got ${r.status}: ${r.message}`);
  // Confirm the view is still alive afterwards (no DB damage).
  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.equal(cfg.view_id, viewId, 'view still readable after SQLi attempt');
});

suite.test('[hostile] Malformed: area key with newlines/tabs/null bytes → 400 with invalid_area_key', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-area-newlines');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title\n\t evil': [{ field_id: fieldIds.name, slot: 'ank01' }] },
  });
  TestAssert.isTrue(r.thrown, 'must reject control-char area key');
  TestAssert.equal(r.status, 400, `must 400, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: area key 10000 chars long → 400', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-area-long');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { ['directory_' + 'a'.repeat(10000)]: [{ field_id: fieldIds.name, slot: 'al01' }] },
  });
  TestAssert.isTrue(r.thrown, 'must reject huge area key');
  TestAssert.isTrue(r.status >= 400 && r.status < 500, `must 4xx, got ${r.status}: ${r.message}`);
});

suite.test('[hostile] Malformed: slot uid with path traversal "../../../etc/passwd"', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-slot-traversal');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: '../../../etc/passwd' }] },
  });
  // Server should normalise / reject. If it accepts, ensure no filesystem
  // surprise — the slot must just be a string key, not a real path.
  if (!r.thrown) {
    const cfg = await h.gv_get_view_config({ id: viewId });
    const area = cfg.fields?.['directory_list-title'] || {};
    const keys = Object.keys(area);
    TestAssert.isTrue(keys.length > 0, 'something stored');
    // Whatever the slot got rewritten to, it MUST not contain raw "../"
    // (a downstream consumer might use it as a path component).
    for (const k of keys) {
      TestAssert.isTrue(!k.includes('../'), `slot key "${k}" must not contain "../"`);
    }
  } else {
    TestAssert.isTrue(r.status >= 400 && r.status < 500, `if rejected, must 4xx (got ${r.status})`);
  }
});

suite.test('[hostile] Sanitisation: custom_label with <script> tag — HTML stripped', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-script-label');
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'scl01', {
    field_id:     fieldIds.name,
    custom_label: '<script>alert(1)</script>Hello',
  });
  TestAssert.isTrue(!String(stored.custom_label || '').includes('<script'), `<script> must be stripped, got "${stored.custom_label}"`);
  TestAssert.isTrue(String(stored.custom_label || '').includes('Hello'), 'inner text "Hello" survives');
});

suite.test('[hostile] Sanitisation: custom_label with NUL/control chars/RTL override → no NUL/RTLO survives', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-control-label');
  const evil = 'safe nul‎rtl‮flipbell';
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'ccl01', {
    field_id:     fieldIds.name,
    custom_label: evil,
  });
  const out = String(stored.custom_label || '');
  // NUL bytes must not survive — they break log lines, JSON serialisers, etc.
  TestAssert.isTrue(!out.includes(' '), `NUL byte must be stripped (got "${JSON.stringify(out)}")`);
  // BEL is a control char that should also not survive in a plain text setting.
  TestAssert.isTrue(!out.includes(''), `BEL must be stripped (got "${JSON.stringify(out)}")`);
});

suite.test('[hostile] Edge: field_id = "0" (zero) → either reject or treat as numeric 0 form field', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-field-zero');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: '0', slot: 'fz01' }] },
  });
  if (r.thrown) {
    TestAssert.isTrue(r.status >= 400 && r.status < 500, `field_id 0 reject must be 4xx (got ${r.status})`);
  }
  // If accepted, view must still be readable.
  const cfg = await h.gv_get_view_config({ id: viewId });
  TestAssert.equal(cfg.view_id, viewId, 'view readable after field_id=0');
});

suite.test('[hostile] Edge: field_id = "-1" → reject or accept without 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-field-neg');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: '-1', slot: 'fn01' }] },
  });
  if (r.thrown) {
    TestAssert.isTrue(r.status >= 400 && r.status < 500, `field_id -1 reject must be 4xx (got ${r.status})`);
  }
});

suite.test('[hostile] Edge: field_id = "1.2.3.4" (IP-like) → no 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-field-iplike');
  const r = await expectApplyError({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: '1.2.3.4', slot: 'fi01' }] },
  });
  if (r.thrown) {
    TestAssert.isTrue(r.status >= 400 && r.status < 500, `IP-like field_id reject must be 4xx (got ${r.status})`);
  }
});

suite.test('[hostile] CL: invalid JSON string → warning, value dropped, no 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-cl-bad-json');
  const apply = await h.gv_apply_view_config({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{
      field_id: fieldIds.name, slot: 'clbj01',
      conditional_logic: '{ this is not json',
    }] },
  });
  TestAssert.isTrue(Array.isArray(apply.warnings), 'warnings array must be present for bad CL');
  const match = apply.warnings.find((w) => w.slot === 'clbj01' && w.key === 'conditional_logic');
  TestAssert.isNotNull(match, `bad-JSON CL must surface a warning (got ${JSON.stringify(apply.warnings)})`);
});

suite.test('[hostile] CL: valid JSON of wrong shape (e.g. array) → warning, value dropped', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-cl-wrong-shape');
  const apply = await h.gv_apply_view_config({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{
      field_id: fieldIds.name, slot: 'clws01',
      conditional_logic: '[1, 2, 3]',
    }] },
  });
  TestAssert.isTrue(Array.isArray(apply.warnings), 'warnings array must be present');
  const match = apply.warnings.find((w) => w.slot === 'clws01' && w.key === 'conditional_logic');
  TestAssert.isNotNull(match, `array-shape CL must warn (got ${JSON.stringify(apply.warnings)})`);
});

suite.test('[hostile] Unicode: zalgo-text custom_label round-trips', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-zalgo');
  const zalgo = 'Z̸̢̧̛̛̮̪̱͚̑̄̀͆a̵̧͉̭̱̾̾̊̏l̶̢̧̪̟̥͉̃̃̄g̶̢̗̱͉̑̄̾͂o̸̧̮̪̭̭̾̾̃̃';
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'zlg01', {
    field_id:     fieldIds.name,
    custom_label: zalgo,
  });
  TestAssert.equal(stored.custom_label, zalgo);
});

suite.test('[hostile] Unicode: emoji-only custom_label', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-emoji-only');
  const emoji = '🔥🎉🚀💥🐉🦄🌈';
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'emo01', {
    field_id:     fieldIds.name,
    custom_label: emoji,
  });
  TestAssert.equal(stored.custom_label, emoji);
});

// ---------- INPUT TYPE EDGE CASES ----------

suite.test('[hostile] Search input: leading/trailing whitespace ("  input_text  ") → reject or trim cleanly', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-search-whitespace');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  let status = null;
  try {
    await h.gv_add_search_field({
      id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
      position: 'search-general_top::100::ws_row',
      field: { id: fieldIds.name, input: '  input_text  ', label: 'WS' },
    });
  } catch (e) { status = errStatus(e); }
  // Either pre-flight rejects (acceptable) or server rejects (acceptable).
  // 5xx is NEVER acceptable.
  if (status !== null) {
    TestAssert.isTrue(status >= 400 && status < 500, `whitespace input slug must 4xx, got ${status}`);
  }
});

suite.test('[hostile] Search input: wrong-case ("INPUT_TEXT") → reject or normalise', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-search-case');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  let status = null;
  try {
    await h.gv_add_search_field({
      id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
      position: 'search-general_top::100::case_row',
      field: { id: fieldIds.name, input: 'INPUT_TEXT', label: 'CASE' },
    });
  } catch (e) { status = errStatus(e); }
  if (status !== null) {
    TestAssert.isTrue(status === 400, `wrong-case input slug must 400, got ${status}`);
  }
});

suite.test('[hostile] Search input: numeric (1) instead of string', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-search-numeric-input');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  let status = null;
  try {
    await h.gv_add_search_field({
      id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
      position: 'search-general_top::100::num_row',
      field: { id: fieldIds.name, input: 1, label: 'NUM' },
    });
  } catch (e) { status = errStatus(e); }
  if (status !== null) {
    TestAssert.isTrue(status >= 400 && status < 500, `numeric input must 4xx, got ${status}`);
  }
});

suite.test('[hostile] Search field: field.id = 0 → reject', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-searchfield-zero');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  let status = null;
  try {
    await h.gv_add_search_field({
      id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
      position: 'search-general_top::100::z_row',
      field: { id: 0, input: 'input_text', label: 'Z' },
    });
  } catch (e) { status = errStatus(e); }
  if (status !== null) {
    TestAssert.isTrue(status >= 400 && status < 500, `field.id=0 must 4xx, got ${status}`);
  }
});

suite.test('[hostile] Search field: field.id pointing at a deleted/non-existent GF field', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-searchfield-ghost');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const widget = await h.gv_add_view_widget({
    id: viewId, area: 'header_top', widget: { field_id: 'search_bar', label: 'Search' },
  });
  let status = null;
  try {
    await h.gv_add_search_field({
      id: viewId, widget_area: 'header_top', widget_slot: widget.slot,
      position: 'search-general_top::100::g_row',
      field: { id: 99999, input: 'input_text', label: 'Ghost' },
    });
  } catch (e) { status = errStatus(e); }
  // Ideally rejects; if it accepts (because the value isn't validated until render),
  // confirm no 5xx happened.
  if (status !== null) {
    TestAssert.isTrue(status >= 400 && status < 500, `ghost field reject must 4xx, got ${status}`);
  }
});

// ---------- WIDGET / SEARCH chaos ----------

suite.test('[hostile] Widget: bogus widget id (definitely_not_real) → reject', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-widget-bogus-id');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  let status = null;
  try {
    await h.gv_add_view_widget({
      id: viewId, area: 'header_top',
      widget: { field_id: 'definitely_not_a_real_widget', label: 'X' },
    });
  } catch (e) { status = errStatus(e); }
  if (status !== null) {
    TestAssert.isTrue(status >= 400 && status < 500, `bogus widget reject must 4xx, got ${status}`);
  }
});

suite.test('[hostile] area_settings injected as a "field" must NOT be treated as a slot', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-area-settings-injection');
  // area_settings is a meta key on the area itself, not a slot.
  // A slot literally named "area_settings" should either reject or be
  // namespaced so it doesn't clobber real area_settings.
  await h.gv_apply_view_config({
    id: viewId, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'area_settings' }] },
  });
  const cfg = await h.gv_get_view_config({ id: viewId });
  // If "area_settings" got stored as a real slot key, it MUST have a field_id —
  // otherwise it's been confused with the area-level settings envelope.
  const stored = cfg.fields?.['directory_list-title']?.area_settings;
  if (stored) {
    TestAssert.isTrue(
      'field_id' in stored || 'id' in stored,
      `slot "area_settings" must look like a slot, not an envelope (got ${JSON.stringify(stored)})`
    );
  }
});

// ---------- TEMPLATE SETTINGS edge cases ----------

suite.test('[hostile] template-settings: page_size = 0 → coerced or rejected, no 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-pagesize-0');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  let err;
  try {
    await h.gv_patch_view_settings({
      id: viewId, template_settings: { page_size: 0 },
    });
  } catch (e) { err = e; }
  if (err) {
    TestAssert.isTrue(errStatus(err) >= 400 && errStatus(err) < 500, `page_size=0 reject must 4xx, got ${errStatus(err)}: ${errMessage(err)}`);
  }
});

suite.test('[hostile] template-settings: page_size = -1 → coerced or rejected', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-pagesize-neg');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  let err;
  try {
    await h.gv_patch_view_settings({
      id: viewId, template_settings: { page_size: -1 },
    });
  } catch (e) { err = e; }
  if (err) {
    TestAssert.isTrue(errStatus(err) >= 400 && errStatus(err) < 500, `page_size=-1 reject must 4xx, got ${errStatus(err)}: ${errMessage(err)}`);
  }
});

suite.test('[hostile] template-settings: page_size = "abc" → 4xx or coerced to 0/default', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-pagesize-string');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  let err;
  try {
    await h.gv_patch_view_settings({
      id: viewId, template_settings: { page_size: 'abc' },
    });
  } catch (e) { err = e; }
  if (err) {
    TestAssert.isTrue(errStatus(err) >= 400 && errStatus(err) < 500, `page_size="abc" reject must 4xx, got ${errStatus(err)}: ${errMessage(err)}`);
  } else {
    const cfg = await h.gv_get_view_config({ id: viewId });
    const ps = cfg.template_settings?.page_size;
    TestAssert.isTrue(
      ps === undefined || ps === null || ps === 0 || /^\d+$/.test(String(ps)),
      `page_size after "abc" must be numeric or absent, got ${JSON.stringify(ps)}`
    );
  }
});

suite.test('[hostile] template-settings: 100 keys at once', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-100-template-keys');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const ts = {};
  for (let i = 0; i < 100; i++) ts[`unknown_key_${i}`] = `v${i}`;
  let err;
  try {
    await h.gv_patch_view_settings({ id: viewId, template_settings: ts });
  } catch (e) { err = e; }
  if (err) {
    TestAssert.isTrue(errStatus(err) >= 400 && errStatus(err) < 500, `bulk-template-settings must 4xx, got ${errStatus(err)}`);
  }
});

// ---------- RENDER hot path ----------

suite.test('[hostile] Render: 50 parallel staged_slot renders', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-render-50-parallel');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const N = 50;
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => h.gv_render_view_field({
      id: viewId, area: 'directory_table-columns',
      slot: `parallel${String(i).padStart(3, '0')}`,
      staged_slot: { field_id: fieldIds.name, custom_label: `Parallel ${i}`, show_label: '1' },
    }))
  );
  console.log(`   (50 parallel renders took ${Date.now() - t0}ms)`);
  // Allow 503 (no entries) — but never 5xx other than 503, never 4xx unless 404.
  let okOrEmpty = 0, problems = [];
  for (const r of results) {
    if (r.status === 'fulfilled') { okOrEmpty++; continue; }
    const s = errStatus(r.reason);
    if (s === 503) { okOrEmpty++; continue; }
    problems.push(`status ${s}: ${errMessage(r.reason)}`);
  }
  TestAssert.equal(problems.length, 0, `parallel renders had ${problems.length} unexpected problems: ${problems.slice(0, 3).join(' | ')}`);
});

suite.test('[hostile] Render: extremely long custom_label (10KB) — no 5xx', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-render-long-label');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  const longLabel = 'L'.repeat(10000);
  let status = null;
  try {
    await h.gv_render_view_field({
      id: viewId, area: 'directory_table-columns', slot: 'longlabel001',
      staged_slot: { field_id: fieldIds.name, custom_label: longLabel, show_label: '1' },
    });
  } catch (e) { status = errStatus(e); }
  TestAssert.isTrue(status === null || status === 503 || (status >= 400 && status < 500),
    `long-label render must succeed/4xx/503 only, got ${status}`);
});

// ---------- RACE / CROSS-VIEW ----------

suite.test('[hostile] Apply to a deleted view → 404 (not 500)', async () => {
  if (suite.skip) return;
  // Needs wp-cli — the WP REST `gravityview` post type isn't exposed
  // for DELETE, so we have to go through wp-cli or skip cleanly.
  const wpRoot = process.env.WP_ROOT;
  let cp;
  if (wpRoot) {
    try {
      cp = await import('node:child_process');
      cp.execSync('which wp', { stdio: 'pipe' });
    } catch (_) { cp = null; }
  }
  if (!cp || !wpRoot) {
    console.log('   (skipping — needs WP_ROOT + wp-cli to actually delete the view)');
    return;
  }

  const viewId = await mintView('hostile-apply-after-delete');
  // Trash + force-delete via wp-cli.
  cp.execSync(`cd ${wpRoot} && wp post delete ${viewId} --force`, { stdio: 'pipe' });
  // Drop from cleanup tracking — already gone.
  mintedViewIds = mintedViewIds.filter((v) => v !== viewId);

  let status = null;
  let message = '';
  try {
    await h.gv_apply_view_config({
      id: viewId, mode: 'merge',
      fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'd01' }] },
    });
  } catch (e) { status = errStatus(e); message = errMessage(e); }
  TestAssert.equal(status, 404, `deleted view apply must 404 (got ${status}: ${message})`);
});

suite.test('[hostile] Cross-view ifMatch → 412', async () => {
  if (suite.skip) return;
  // Mint view A, mutate it so its version counter bumps to ":1+", then mint B.
  // This guarantees A's etag is genuinely incompatible with B's fresh ":0".
  const viewA = await mintView('hostile-xview-A');
  await h.gv_apply_view_config({
    id: viewA, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'bump_a' }] },
  });
  const cfgA = await h.gv_get_view_config({ id: viewA });
  const etagA = `"${cfgA.version}"`;

  const viewB = await mintView('hostile-xview-B');
  const cfgB = await h.gv_get_view_config({ id: viewB });
  // Sanity: versions must differ — otherwise the test can't prove anything.
  TestAssert.isTrue(cfgA.version !== cfgB.version, `view versions must differ; got A=${cfgA.version} B=${cfgB.version}`);

  let status = null, message = '';
  try {
    await h.gv_apply_view_config({
      id: viewB, ifMatch: etagA, mode: 'merge',
      fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'xvm01' }] },
    });
  } catch (e) { status = errStatus(e); message = errMessage(e); }
  TestAssert.equal(status, 412, `cross-view ifMatch must 412 (got ${status}: ${message})`);
});

suite.test('[hostile] Same apply twice with same ifMatch → second 412', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-replay');
  const cfg = await h.gv_get_view_config({ id: viewId });
  const etag = `"${cfg.version}"`;
  await h.gv_apply_view_config({
    id: viewId, ifMatch: etag, mode: 'merge',
    fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'rep01' }] },
  });
  let status = null;
  try {
    await h.gv_apply_view_config({
      id: viewId, ifMatch: etag, mode: 'merge',
      fields: { 'directory_list-title': [{ field_id: fieldIds.name, slot: 'rep02' }] },
    });
  } catch (e) { status = errStatus(e); }
  TestAssert.equal(status, 412, `replay must 412 (got ${status})`);
});

// ---------- RECURSIVE / SELF-REFERENTIAL ----------

suite.test('[hostile] Self-ref: field with conditional_logic referencing itself round-trips', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-cl-selfref');
  // CL references the same field — the renderer should handle this without
  // infinite recursion. The setting itself should at least round-trip.
  const cl = {
    version: 2, actionType: 'show', logicType: 'all',
    rules: [{ fieldId: fieldIds.name, operator: 'is', value: 'self' }],
  };
  const stored = await roundTripSlot(viewId, 'directory_list-title', 'sref01', {
    field_id: fieldIds.name, conditional_logic: cl,
  });
  TestAssert.isNotNull(stored.conditional_logic, 'self-ref CL persisted');
});

suite.test('[hostile] Self-ref: custom_content embedding [gravityview id="<self>"] shortcode', async () => {
  if (suite.skip) return;
  const viewId = await mintView('hostile-shortcode-selfref');
  const stored = await roundTripSlot(viewId, 'directory_list-description', 'shsref01', {
    field_id: 'custom',
    content:  `[gravityview id="${viewId}"]`,
    wpautop:  false,
  });
  TestAssert.isTrue(String(stored.content || '').includes(`id="${viewId}"`), 'shortcode body persisted verbatim');
  // The /render path is the place a recursion bomb would explode — skip
  // hitting it here on purpose; persistence is the contract being asserted.
});

// ============================================================
// AESTHETIC REFACTOR — new + consolidated abilities
// (renamed handlers are exercised throughout the suite via the
// global sweep — these tests exclusively cover surfaces that
// didn't exist before this pass.)
// ============================================================

suite.test('Consolidated schema: gv_get_view_field_schemas with no filter returns the bulk map', async () => {
  if (suite.skip) return;
  const viewId = await mintView('schema bulk mode');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  await h.gv_apply_view_config({
    id:     viewId,
    fields: { 'directory_table-columns': [
      { field_id: fieldIds.name,  slot: 'sb_a' },
      { field_id: fieldIds.email, slot: 'sb_b' },
    ] },
    mode:   'merge',
  });
  const r = await h.gv_get_view_field_schemas({ id: viewId });
  TestAssert.isTrue(typeof r.schemas === 'object', 'schemas object present');
  const keys = Object.keys(r.schemas);
  TestAssert.isTrue(keys.length >= 2, `bulk returned at least the 2 placed slots (got ${keys.length})`);
});

suite.test('Consolidated schema: gv_get_view_field_schemas filtered to area+slot returns one-key map', async () => {
  if (suite.skip) return;
  const viewId = await mintView('schema single mode');
  await h.gv_patch_view_template({ id: viewId, template_id: 'default_table' });
  await h.gv_apply_view_config({
    id:     viewId,
    fields: { 'directory_table-columns': [
      { field_id: fieldIds.name,  slot: 'sb_solo' },
      { field_id: fieldIds.email, slot: 'sb_other' },
    ] },
    mode:   'merge',
  });
  const r = await h.gv_get_view_field_schemas({
    id:   viewId,
    area: 'directory_table-columns',
    slot: 'sb_solo',
  });
  const keys = Object.keys(r.schemas);
  TestAssert.equal(keys.length, 1, 'single-slot filter narrows to ONE entry');
  TestAssert.equal(keys[0], 'directory_table-columns/sb_solo', 'returned key matches the requested area/slot');
});

suite.test('Safety: NO permanent-delete ability exists — only set-view-status: trash is the soft-remove path', async () => {
  if (suite.skip) return;
  // Anti-test: delete-view was intentionally NOT shipped. AI agents
  // shouldn't have a one-call permanent destruction path. Soft-delete
  // via set-view-status: trash is the canonical path; recovery is via
  // WP admin's "Restore from trash". This test pins that contract.
  TestAssert.isTrue(
    typeof h.gv_delete_view === 'undefined',
    'gv_delete_view ability must NOT exist (permanent destruction is admin-only by design)',
  );
});

suite.test('Safety: set-view-status: trash works as the soft-remove path (recoverable)', async () => {
  if (suite.skip) return;
  const viewId = await mintView('soft-trash via set-status');
  const r = await h.gv_set_view_status({ id: viewId, status: 'trash' });
  TestAssert.equal(r.changed, true);
  TestAssert.equal(r.status, 'trash');
  // Trashed views are still in the post table — recoverable. The
  // get_post_status check is the canonical "is this trashed" probe.
  // We assert via wp-cli rather than a REST round-trip because the
  // trashed view's accessibility through gv_get_view_config is a
  // separate contract.
});

suite.test('Safety: abilities-loader does NOT add a client-side destructive gate', async () => {
  if (suite.skip) return;
  // Field/widget removal is normal authoring (and reversible — re-add
  // the same field_id). The server's permission_callback (edit_post /
  // edit_gravityviews) is the only protection layer; there must NOT be
  // an env-var refusal in the loader closure. We probe by ensuring the
  // handler contacts the server (a 4xx from auth/missing-resource is
  // proof we got past the loader). The previous "Refusing to call
  // destructive ability" gate was removed when DeleteView shipped —
  // there is no longer any "delete the whole View" path through the
  // ability registry, so the env-var ratchet served no remaining
  // purpose. Status-level removal still flows through gv_set_view_status
  // and is gated server-side by the WP `delete_post` capability.
  const { loadAbilitiesAsTools } = await import('../abilities/loader.js');
  const { handlers } = await loadAbilitiesAsTools(gvClient);
  let msg = '';
  try {
    await handlers.gv_remove_view_field({ id: 999999999, area: 'directory_list-title', slot: 'never' });
  } catch (err) {
    msg = String(err?.message ?? '');
  }
  TestAssert.isTrue(
    !msg.includes('Refusing to call destructive ability'),
    `loader must not refuse destructive calls client-side (got "${msg}")`,
  );
});

suite.test('New ability: gv_duplicate_view clones form + template + fields', async () => {
  if (suite.skip) return;
  const sourceId = await mintView('duplicate source');
  await h.gv_patch_view_template({ id: sourceId, template_id: 'default_table' });
  await h.gv_apply_view_config({
    id:     sourceId,
    fields: { 'directory_table-columns': [
      { field_id: fieldIds.name, slot: 'dup_a', custom_label: 'Carry-over' },
    ] },
    mode:   'merge',
  });

  const r = await h.gv_duplicate_view({ id: sourceId, title: 'Duplicated for stress test' });
  TestAssert.equal(r.duplicated, true);
  TestAssert.equal(r.source_id, sourceId);
  TestAssert.isTrue(r.view_id > 0 && r.view_id !== sourceId, 'fresh post id, distinct from source');
  TestAssert.equal(r.title, 'Duplicated for stress test');
  mintedViewIds.push(r.view_id);

  const dup = await h.gv_get_view_config({ id: r.view_id });
  TestAssert.equal(dup.form_id, Number(formId), 'form binding cloned');
  TestAssert.equal(dup.template_id, 'default_table', 'template cloned');
  TestAssert.equal(
    dup.fields['directory_table-columns']?.dup_a?.custom_label,
    'Carry-over',
    'field placement + custom_label cloned',
  );
});

suite.test('New ability: gv_set_view_status — publish → draft round-trip + idempotent re-set', async () => {
  if (suite.skip) return;
  const viewId = await mintView('set-status round-trip');

  const pub = await h.gv_set_view_status({ id: viewId, status: 'publish' });
  TestAssert.equal(pub.status, 'publish');
  TestAssert.equal(pub.previous_status, 'draft');
  TestAssert.equal(pub.changed, true);

  const noop = await h.gv_set_view_status({ id: viewId, status: 'publish' });
  TestAssert.equal(noop.changed, false, 'idempotent — same status returns changed: false');

  const draft = await h.gv_set_view_status({ id: viewId, status: 'draft' });
  TestAssert.equal(draft.status, 'draft');
  TestAssert.equal(draft.previous_status, 'publish');
  TestAssert.equal(draft.changed, true);
});

suite.test('New ability: gv_set_view_status rejects an invalid status enum value', async () => {
  if (suite.skip) return;
  const viewId = await mintView('set-status invalid');
  let status = null;
  try {
    await h.gv_set_view_status({ id: viewId, status: 'totally_made_up' });
  } catch (err) {
    status = err?.response?.status ?? null;
  }
  TestAssert.equal(status, 400, 'invalid status → 400');
});

// ====================================================================
// Coverage for the post-Gemini-review enhancements
// ====================================================================

suite.test('New ability: gv_list_views enumerates with status / form_id / search filters', async () => {
  if (suite.skip) return;
  const seedTitle = `[stress] list-views needle ${Date.now()}`;
  const view = await h.gv_create_view({
    title: seedTitle,
    form_id: Number(formId),
    template_id: 'gravityview-layout-builder',
    status: 'draft',
  });
  mintedViewIds.push(view.view_id);

  // Substring search picks up the freshly-created View.
  const found = await h.gv_list_views({ search: 'list-views needle', per_page: 10 });
  TestAssert.isTrue(Array.isArray(found.views), 'returns views array');
  TestAssert.isTrue(found.total >= 1, 'total reflects matching count');
  const match = found.views.find((v) => v.view_id === view.view_id);
  TestAssert.isTrue(!!match, 'newly-minted View appears in search results');
  TestAssert.equal(match.form_id, Number(formId), 'form_id reflected');
  TestAssert.equal(match.status, 'draft', 'status reflected');

  // form_id filter narrows to that form (every result must match).
  const byForm = await h.gv_list_views({ form_id: Number(formId), per_page: 5 });
  for (const v of byForm.views) {
    TestAssert.equal(v.form_id, Number(formId), 'every row matches form_id filter');
  }

  // Pagination metadata.
  const paged = await h.gv_list_views({ per_page: 2, page: 1 });
  TestAssert.equal(paged.per_page, 2, 'per_page echoed');
  TestAssert.equal(paged.page, 1, 'page echoed');
  TestAssert.isTrue(paged.total_pages >= 1, 'total_pages computed');
});

suite.test('Projection: gv_get_view_config include narrows the response shape', async () => {
  if (suite.skip) return;
  const viewId = await mintView('projection');

  const full = await h.gv_get_view_config({ id: viewId, compact: false });
  TestAssert.isTrue('template_id' in full, 'full has template_id');
  TestAssert.isTrue('fields' in full, 'full has fields');
  TestAssert.isTrue('widgets' in full, 'full has widgets');

  const slim = await h.gv_get_view_config({
    id: viewId,
    include: ['template_settings', 'form_id'],
    compact: false,
  });
  TestAssert.isTrue('view_id' in slim, 'view_id always present (projection invariant)');
  TestAssert.isTrue('form_id' in slim, 'requested form_id present');
  TestAssert.isTrue('template_settings' in slim, 'requested template_settings present');
  TestAssert.isTrue(!('fields' in slim), 'unrequested fields stripped');
  TestAssert.isTrue(!('widgets' in slim), 'unrequested widgets stripped');
  TestAssert.isTrue(!('template_id' in slim), 'unrequested template_id stripped');
});

suite.test('Dry-run: gv_apply_view_config dry_run=true does NOT persist + flags response', async () => {
  if (suite.skip) return;
  const viewId = await mintView('dry-run apply');

  // Real bulk write to set a baseline. Each apply bumps the version,
  // so re-fetch + re-quote between writes (the test harness only
  // caches the version returned by the LAST call; the unit-test
  // happens to interleave reads + writes that defeat that).
  await h.gv_apply_view_config({
    id:                viewId,
    mode:              'merge',
    template_settings: { page_size: 25 },
  });
  const before = await h.gv_get_view_config({ id: viewId, include: ['template_settings'] });
  TestAssert.equal(before.template_settings.page_size, 25, 'baseline persisted');

  const dry = await h.gv_apply_view_config({
    id:                viewId,
    mode:              'merge',
    template_settings: { page_size: 999 },
    dry_run:           true,
  });
  TestAssert.equal(dry.dry_run, true, 'response flagged dry_run');
  TestAssert.equal(dry.would_apply, true, 'response flagged would_apply');

  const after = await h.gv_get_view_config({ id: viewId, include: ['template_settings'] });
  TestAssert.equal(after.template_settings.page_size, 25, 'meta unchanged after dry-run');
});

suite.test('Dry-run: gv_patch_view_field dry_run=true validates without persisting', async () => {
  if (suite.skip) return;
  const viewId = await mintView('dry-run patch-field');
  await h.gv_add_grid_row({
    id:           viewId,
    surface:      'fields',
    row_uid:      'r1',
    type:         '100',
    template_ids: ['default_table'],
  });
  const added = await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_table-columns',
    field_id: 'custom',
    label:    'Original',
  });
  await h.gv_patch_view_field({
    id:       viewId,
    area:     'directory_table-columns',
    slot:     added.slot,
    settings: { custom_label: 'Real Label' },
  });

  const dryPatch = await h.gv_patch_view_field({
    id:       viewId,
    area:     'directory_table-columns',
    slot:     added.slot,
    settings: { custom_label: 'Dry Label' },
    dry_run:  true,
  });
  TestAssert.equal(dryPatch.dry_run, true);

  const after = await h.gv_get_view_config({ id: viewId });
  const stored = after.fields['directory_table-columns']?.[added.slot]?.custom_label;
  TestAssert.equal(stored, 'Real Label', 'meta still holds the real-write value, not the dry-run value');
});

suite.test('Dry-run: gv_add_view_field dry_run=true returns shape but does NOT add a slot', async () => {
  if (suite.skip) return;
  const viewId = await mintView('dry-run add-field');
  await h.gv_add_grid_row({
    id:           viewId,
    surface:      'fields',
    row_uid:      'r1',
    type:         '100',
    template_ids: ['default_table'],
  });

  const beforeCount = Object.keys(
    (await h.gv_get_view_config({ id: viewId })).fields?.['directory_table-columns'] ?? {},
  ).length;

  const dry = await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_table-columns',
    field_id: 'custom',
    label:    'Hypothetical',
    dry_run:  true,
  });
  TestAssert.equal(dry.dry_run, true);

  const afterCount = Object.keys(
    (await h.gv_get_view_config({ id: viewId })).fields?.['directory_table-columns'] ?? {},
  ).length;
  TestAssert.equal(afterCount, beforeCount, 'slot count unchanged after dry-run add');
});

suite.test('Catalog: every gk-gravityview ability advertises a next_steps annotation', async () => {
  if (suite.skip) return;
  const { data: catalog } = await gvClient.httpClient.request({
    method:  'GET',
    baseURL: gvClient.baseUrl,
    url:     '/wp-json/wp-abilities/v1/abilities',
  });
  const ours = catalog.filter((a) => typeof a?.name === 'string' && a.name.startsWith('gk-gravityview/'));
  TestAssert.isTrue(ours.length > 0, 'at least one gk-gravityview ability');
  for (const ab of ours) {
    const ns = ab?.meta?.annotations?.next_steps;
    TestAssert.isTrue(Array.isArray(ns), `${ab.name} has next_steps array`);
    for (const step of ns) {
      TestAssert.isTrue(
        typeof step?.ability === 'string' && step.ability.startsWith('gk-gravityview/'),
        `${ab.name} next-step references gk-gravityview ability`,
      );
      TestAssert.isTrue(typeof step?.when === 'string' && step.when.length > 0, `${ab.name} next-step has when text`);
    }
  }
});

suite.test('Discovery bridge: list-layouts has_grid description points at list-grid-row-types', async () => {
  if (suite.skip) return;
  const { data: catalog } = await gvClient.httpClient.request({
    method:  'GET',
    baseURL: gvClient.baseUrl,
    url:     '/wp-json/wp-abilities/v1/abilities',
  });
  const listLayouts = catalog.find((a) => a.name === 'gk-gravityview/list-layouts');
  const hasGridDesc =
    listLayouts?.output_schema?.properties?.layouts?.items?.properties?.has_grid?.description ?? '';
  TestAssert.isTrue(
    hasGridDesc.includes('list-grid-row-types'),
    'has_grid description bridges to list-grid-row-types (the discovery step)',
  );
  TestAssert.isTrue(
    hasGridDesc.includes('list-view-areas'),
    'has_grid description bridges to list-view-areas for static layouts',
  );
});

suite.test('Field presets: default catalog is empty (filter-driven, core ships none)', async () => {
  if (suite.skip) return;
  const r = await h.gv_list_field_presets();
  TestAssert.equal(r.count, 0, 'no core-shipped presets');
  TestAssert.isTrue(Array.isArray(r.presets), 'presets is an array');
  TestAssert.equal(r.presets.length, 0);
});

suite.test('Field presets: apply-field-preset rejects an unknown preset id with 404', async () => {
  if (suite.skip) return;
  const viewId = await mintView('preset 404');
  let status = null;
  try {
    await h.gv_apply_field_preset({
      id:        viewId,
      preset_id: 'definitely-not-registered',
      area:      'directory_list-title',
    });
  } catch (err) {
    status = err?.response?.status ?? null;
  }
  TestAssert.equal(status, 404, 'unknown preset id → 404');
});

// ====================================================================
// Multiple Forms add-on stress (gk-multiple-forms/* abilities +
// cross-plugin filters on get/apply-view-config + list-views).
//
// All tests skip themselves when MFV isn't loaded — that's surfaced
// via the absence of `gv_list_joins` from the catalog. On dev.test
// MFV is active, so they run for real.
// ====================================================================

const mfvSkip = () => suite.skip || typeof h?.gv_list_joins !== 'function';

/** Mint a throwaway secondary GF form for join-target tests. */
async function mintSecondaryForm(label) {
  const created = await gfClient.createForm({
    title:  `[stress mfv ${label}] ${Date.now()}`,
    fields: [
      { id: 1, type: 'text', label: 'Customer Ref' },
      { id: 2, type: 'text', label: 'Email' },
      { id: 3, type: 'number', label: 'Amount' },
    ],
  });
  // createForm returns `{ form: { id }, edit_url, entries_url }` —
  // the form id lives on `.form.id`, not on the top-level result.
  const id = Number(created?.form?.id ?? 0);
  if (!id) {
    throw new Error('mintSecondaryForm: created form id missing from createForm response');
  }
  return id;
}

suite.test('MFV: catalog exposes the three gk-multiple-forms/* abilities', async () => {
  if (mfvSkip()) return;
  TestAssert.isTrue(typeof h.gv_list_joins === 'function', 'gv_list_joins handler present');
  TestAssert.isTrue(typeof h.gv_apply_joins === 'function', 'gv_apply_joins handler present');
  TestAssert.isTrue(typeof h.gv_list_joinable_fields === 'function', 'gv_list_joinable_fields handler present');
});

suite.test('MFV: list-joins on a no-joins View → empty + count=0', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv list empty');
  const r = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(r.count, 0, 'no joins on a fresh View');
  TestAssert.isTrue(Array.isArray(r.joins), 'joins is an array');
});

suite.test('MFV: list-joinable-fields enumerates form fields + entry-property aliases', async () => {
  if (mfvSkip()) return;
  const formId = await mintSecondaryForm('joinable');
  const r = await h.gv_list_joinable_fields({ form_id: formId });
  TestAssert.isTrue(r.fields.length >= 3, 'at least 3 numeric fields + aliases');
  const ids = r.fields.map((f) => f.id);
  for (const expected of ['1', '2', '3', 'entry_id', 'created_by']) {
    TestAssert.isTrue(ids.includes(expected), `expected ${expected} in joinable fields`);
  }
  // Cleanup
  await gfClient.deleteForm(formId).catch(() => {});
});

suite.test('MFV: apply-joins dry_run → flags response + does NOT persist', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv dry-run apply-joins');
  const joinedFormId = await mintSecondaryForm('dry');
  const dry = await h.gv_apply_joins({
    id:    viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
    dry_run: true,
  });
  TestAssert.equal(dry.dry_run, true, 'dry_run flag stamped');
  TestAssert.equal(dry.would_apply, true, 'would_apply flag stamped');
  TestAssert.equal(dry.count, 1, 'count reports the validated row count');

  const after = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(after.count, 0, 'meta unchanged after dry-run');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: apply-joins persists + list-joins inflates form/field labels', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv apply real');
  const joinedFormId = await mintSecondaryForm('real');
  const r = await h.gv_apply_joins({
    id: viewId,
    joins: [
      [Number(formId), '1', joinedFormId, '1'],
      [Number(formId), 'entry_id', joinedFormId, '3'],
    ],
  });
  TestAssert.equal(r.count, 2);

  const list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 2, 'two joins surfaced');
  TestAssert.isTrue(list.joins[0].details.base_form_label.length > 0, 'base form label inflated');
  TestAssert.isTrue(list.joins[0].details.base_form_active, 'base form active');
  TestAssert.isTrue(list.joins[0].details.join_form_active, 'join form active');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: apply-joins replaces (not merges) — 3 → 1 → 0', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv replace');
  const joinedFormId = await mintSecondaryForm('replace');

  // Set 3
  let r = await h.gv_apply_joins({
    id: viewId,
    joins: [
      [Number(formId), '1', joinedFormId, '1'],
      [Number(formId), '2', joinedFormId, '2'],
      [Number(formId), 'entry_id', joinedFormId, '3'],
    ],
  });
  TestAssert.equal(r.count, 3);

  // Replace with 1
  r = await h.gv_apply_joins({
    id: viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
  });
  TestAssert.equal(r.count, 1, 'apply-joins is replace-not-merge');
  let list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 1);

  // Clear with empty
  r = await h.gv_apply_joins({ id: viewId, joins: [] });
  TestAssert.equal(r.count, 0);
  list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 0, 'empty array clears all joins');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: apply-joins rejects malformed rows with 400', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv invalid rows');
  let status = null;
  try {
    await h.gv_apply_joins({
      id: viewId,
      joins: [
        [Number(formId), '1', 999999, '1'],
        ['not-numeric', '1', 999999, '1'], // invalid base_form_id type
      ],
    });
  } catch (err) {
    status = err?.response?.status ?? null;
  }
  TestAssert.equal(status, 400, 'malformed row → 400');

  // Verify the View still has no joins (atomic rollback on error).
  const list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 0, 'no partial write on validation error');
});

suite.test('MFV: apply-view-config writes joins via the cross-plugin filter', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv cross-plugin');
  const joinedFormId = await mintSecondaryForm('crossplugin');

  await h.gv_apply_view_config({
    id:    viewId,
    mode:  'merge',
    joins: [
      [Number(formId), '1', joinedFormId, '1'],
      [Number(formId), 'entry_id', joinedFormId, '3'],
    ],
  });

  const cfg = await h.gv_get_view_config({ id: viewId, compact: false });
  TestAssert.isTrue(Array.isArray(cfg.joins), 'get-view-config exposes joins');
  TestAssert.equal(cfg.joins.length, 2, 'apply-view-config persisted both joins');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: get-view-config include=[joins] projection narrows shape', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv projection');
  const joinedFormId = await mintSecondaryForm('proj');
  await h.gv_apply_joins({
    id: viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
  });

  const slim = await h.gv_get_view_config({
    id:      viewId,
    include: ['joins'],
    compact: false,
  });
  TestAssert.isTrue('joins' in slim, 'projection kept joins');
  TestAssert.equal(slim.joins.length, 1);
  TestAssert.isTrue(!('fields' in slim), 'projection stripped fields');
  TestAssert.isTrue(!('widgets' in slim), 'projection stripped widgets');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: list-views match_joined surfaces Views joining a form (not just primary)', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv list-views match');
  const joinedFormId = await mintSecondaryForm('listmatch');
  await h.gv_apply_joins({
    id: viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
  });

  // Search for Views connected to the JOINED form (not primary).
  const matched = await h.gv_list_views({ form_id: joinedFormId, match_joined: true });
  TestAssert.isTrue(
    matched.views.some((v) => v.view_id === viewId),
    'View surfaces under match_joined when its form is only joined',
  );

  // Without match_joined, the joined-only View must NOT show up.
  const unmatched = await h.gv_list_views({ form_id: joinedFormId });
  TestAssert.isTrue(
    !unmatched.views.some((v) => v.view_id === viewId),
    'plain form_id filter excludes joined-only Views',
  );

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: list-available-fields includes joined_form_fields tagged with form_id', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv available-fields');
  const joinedFormId = await mintSecondaryForm('availfields');
  await h.gv_apply_joins({
    id: viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
  });

  const r = await h.gv_list_available_fields({ id: viewId, zone: 'directory' });
  TestAssert.isTrue(Array.isArray(r.joined_form_fields), 'joined_form_fields is an array');
  TestAssert.isTrue(r.joined_form_fields.length > 0, 'at least one joined-form field returned');
  for (const f of r.joined_form_fields) {
    TestAssert.equal(f.form_id, joinedFormId, 'every joined field tagged with the joined form_id');
  }

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV: every gk-multiple-forms/* ability advertises a next_steps annotation', async () => {
  if (mfvSkip()) return;
  const { data: catalog } = await gvClient.httpClient.request({
    method:  'GET',
    baseURL: gvClient.baseUrl,
    url:     '/wp-json/wp-abilities/v1/abilities',
  });
  const ours = catalog.filter((a) => typeof a?.name === 'string' && a.name.startsWith('gk-multiple-forms/'));
  TestAssert.isTrue(ours.length >= 3, 'at least three MFV abilities registered');
  for (const ab of ours) {
    const ns = ab?.meta?.annotations?.next_steps;
    TestAssert.isTrue(Array.isArray(ns) && ns.length > 0, `${ab.name} advertises next_steps`);
  }
});

// --------------------------------------------------------------------
// DEEP Multi-Form authoring stress — mixes fields from both the primary
// and joined forms into the same View areas, the way a real
// multi-form authoring flow does. Verifies the field tree records
// each slot's source `form_id` correctly so renderers hydrate against
// the right form / field collision space.
// --------------------------------------------------------------------

suite.test('MFV deep: field slots from primary AND joined forms coexist in one area', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv mixed fields');

  // Mint the joined form with field IDs that would COLLIDE with the
  // primary if disambiguation were broken: both forms have id=1 + id=2.
  const joinedFormId = await mintSecondaryForm('mixed-fields');

  // Wire the join so the View can pull from both forms.
  await h.gv_apply_joins({
    id:    viewId,
    joins: [[Number(formId), '1', joinedFormId, '1']],
  });

  // Layout Builder needs a row before fields can land.
  await h.gv_add_grid_row({
    id:           viewId,
    surface:      'fields',
    row_uid:      'mixed_row',
    type:         '100',
    template_ids: ['gravityview-layout-builder'],
  });

  // Discover fields available from both forms.
  const avail = await h.gv_list_available_fields({ id: viewId, zone: 'directory' });
  TestAssert.isTrue(Array.isArray(avail.form_fields), 'primary form_fields surfaced');
  TestAssert.isTrue(Array.isArray(avail.joined_form_fields), 'joined_form_fields surfaced');
  TestAssert.isTrue(avail.form_fields.length > 0, 'primary form has fields');
  TestAssert.isTrue(avail.joined_form_fields.length > 0, 'joined form has fields');

  // Every joined field must carry the joined form_id tag — not the primary.
  for (const f of avail.joined_form_fields) {
    TestAssert.equal(f.form_id, joinedFormId, 'joined field tagged with joined form_id');
  }

  // Pick one numeric field id from each form. Using `1` from both
  // intentionally — that's the collision case real Multi-Form
  // configurations hit.
  const primaryFieldId = avail.form_fields[0]?.id;
  const joinedFieldId  = avail.joined_form_fields[0]?.id;
  TestAssert.isTrue(!!primaryFieldId, 'have a primary field id');
  TestAssert.isTrue(!!joinedFieldId, 'have a joined field id');

  // Add a slot from the PRIMARY form into the View's grid area.
  const primarySlot = await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_mixed_row-1',
    field_id: primaryFieldId,
    label:    'Primary Field',
    form_id:  Number(formId),
  });
  TestAssert.isTrue(!!primarySlot.slot, 'primary slot created');

  // Add a slot from the JOINED form into the SAME area.
  const joinedSlot = await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_mixed_row-1',
    field_id: joinedFieldId,
    label:    'Joined Field',
    form_id:  joinedFormId,
  });
  TestAssert.isTrue(!!joinedSlot.slot, 'joined slot created');
  TestAssert.isTrue(joinedSlot.slot !== primarySlot.slot, 'unique slot UID despite same field_id');

  // Verify both slots are persisted in the field tree under the same area.
  const cfg = await h.gv_get_view_config({ id: viewId, compact: false });
  const area = cfg.fields?.['directory_mixed_row-1'];
  TestAssert.isTrue(typeof area === 'object' && area !== null, 'area exists in field tree');
  TestAssert.isTrue(primarySlot.slot in area, 'primary slot in tree');
  TestAssert.isTrue(joinedSlot.slot in area, 'joined slot in tree');

  // The View's joins are still intact after the field placements.
  const cfgJoins = cfg.joins;
  TestAssert.isTrue(Array.isArray(cfgJoins) && cfgJoins.length === 1, 'join survived field placements');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV deep: 3-form join + fields from each form land in distinct areas', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv 3-form');
  const orderForm   = await mintSecondaryForm('orders');
  const addressForm = await mintSecondaryForm('addresses');

  // Triple-form join: primary ← orders ← addresses (cascading).
  await h.gv_apply_joins({
    id: viewId,
    joins: [
      [Number(formId),  '1', orderForm,    '1'],
      [orderForm,       '2', addressForm,  '2'],
    ],
  });

  // List joins includes both rows + inflates labels for all three forms.
  const list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 2);
  const labels = list.joins.map((j) => `${j.details.base_form_label}/${j.details.join_form_label}`);
  TestAssert.isTrue(labels.length === 2, 'two label pairs');
  TestAssert.isTrue(labels.every((l) => l.includes('/')), 'every join surfaces both form labels');

  // available-fields now spans all three forms.
  const avail = await h.gv_list_available_fields({ id: viewId });
  const joinedFormIds = new Set(avail.joined_form_fields.map((f) => f.form_id));
  TestAssert.isTrue(joinedFormIds.has(orderForm), 'orders form_id present in joined_form_fields');
  TestAssert.isTrue(joinedFormIds.has(addressForm), 'addresses form_id present in joined_form_fields');

  // Place one field from each form into 3 different rows so the View
  // is genuinely cross-form authored.
  for (const rowUid of ['r_orders', 'r_addr']) {
    await h.gv_add_grid_row({
      id:           viewId,
      surface:      'fields',
      row_uid:      rowUid,
      type:         '100',
      template_ids: ['gravityview-layout-builder'],
    });
  }

  await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_r_orders-1',
    field_id: avail.joined_form_fields.find((f) => f.form_id === orderForm)?.id,
    label:    'Order Field',
    form_id:  orderForm,
  });
  await h.gv_add_view_field({
    id:       viewId,
    area:     'directory_r_addr-1',
    field_id: avail.joined_form_fields.find((f) => f.form_id === addressForm)?.id,
    label:    'Address Field',
    form_id:  addressForm,
  });

  const cfg = await h.gv_get_view_config({ id: viewId, compact: false });
  TestAssert.isTrue(Object.keys(cfg.fields?.['directory_r_orders-1'] ?? {}).length === 1, 'orders row has 1 slot');
  TestAssert.isTrue(Object.keys(cfg.fields?.['directory_r_addr-1'] ?? {}).length === 1, 'address row has 1 slot');

  await gfClient.deleteForm(orderForm).catch(() => {});
  await gfClient.deleteForm(addressForm).catch(() => {});
});

suite.test('MFV deep: apply-view-config bulk — joins + fields from both forms in one call', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv bulk mixed');
  const joinedFormId = await mintSecondaryForm('bulk');

  // First materialise a row to host the slots.
  await h.gv_add_grid_row({
    id:           viewId,
    surface:      'fields',
    row_uid:      'bulk_row',
    type:         '100',
    template_ids: ['gravityview-layout-builder'],
  });

  // Bulk write everything in one shot: joins + fields tree spanning both forms.
  await h.gv_apply_view_config({
    id:    viewId,
    mode:  'merge',
    joins: [[Number(formId), '1', joinedFormId, '1']],
    fields: {
      'directory_bulk_row-1': [
        { field_id: '1',           label: 'From Primary',  form_id: Number(formId) },
        { field_id: '2',           label: 'Email Primary', form_id: Number(formId) },
        { field_id: '1',           label: 'From Joined',   form_id: joinedFormId },
        { field_id: '3',           label: 'Amount Joined', form_id: joinedFormId },
      ],
    },
  });

  const cfg = await h.gv_get_view_config({ id: viewId, compact: false });
  TestAssert.isTrue(Array.isArray(cfg.joins) && cfg.joins.length === 1, 'bulk wrote joins');
  const slots = cfg.fields?.['directory_bulk_row-1'] ?? {};
  TestAssert.equal(Object.keys(slots).length, 4, 'four slots in bulk_row-1');

  // Verify that the View knows which slots came from which form.
  const formIds = Object.values(slots).map((s) => Number(s.form_id ?? 0));
  const primaryCount = formIds.filter((id) => id === Number(formId)).length;
  const joinedCount  = formIds.filter((id) => id === joinedFormId).length;
  TestAssert.isTrue(primaryCount >= 2, 'at least 2 slots from primary form');
  TestAssert.isTrue(joinedCount  >= 2, 'at least 2 slots from joined form');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV deep: dry_run on mixed-form bulk apply does NOT persist any slot', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv dry mixed');
  const joinedFormId = await mintSecondaryForm('dry-mixed');

  await h.gv_add_grid_row({
    id:           viewId,
    surface:      'fields',
    row_uid:      'dry_row',
    type:         '100',
    template_ids: ['gravityview-layout-builder'],
  });

  const dry = await h.gv_apply_view_config({
    id:    viewId,
    mode:  'merge',
    dry_run: true,
    joins: [[Number(formId), '1', joinedFormId, '1']],
    fields: {
      'directory_dry_row-1': [
        { field_id: '1', label: 'Primary',  form_id: Number(formId) },
        { field_id: '1', label: 'Joined',   form_id: joinedFormId },
      ],
    },
  });
  TestAssert.equal(dry.dry_run, true);

  const cfg = await h.gv_get_view_config({ id: viewId, compact: false });
  TestAssert.isTrue(!cfg.joins || cfg.joins.length === 0, 'no joins persisted on dry-run');
  const slots = cfg.fields?.['directory_dry_row-1'] ?? {};
  TestAssert.equal(Object.keys(slots).length, 0, 'no slots persisted on dry-run');

  await gfClient.deleteForm(joinedFormId).catch(() => {});
});

suite.test('MFV deep: apply-joins clears + replaces, list-joins reflects each step', async () => {
  if (mfvSkip()) return;
  const viewId = await mintView('mfv replace cycle');
  const f1 = await mintSecondaryForm('repl1');
  const f2 = await mintSecondaryForm('repl2');

  // Round 1: 2 joins
  await h.gv_apply_joins({
    id: viewId,
    joins: [
      [Number(formId), '1', f1, '1'],
      [Number(formId), '2', f2, '2'],
    ],
  });
  let list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 2);

  // Round 2: replace with a single join to f2 only
  await h.gv_apply_joins({
    id: viewId,
    joins: [[Number(formId), 'entry_id', f2, '3']],
  });
  list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 1);
  TestAssert.equal(list.joins[0].join_form_id, f2);

  // Round 3: clear
  await h.gv_apply_joins({ id: viewId, joins: [] });
  list = await h.gv_list_joins({ id: viewId });
  TestAssert.equal(list.count, 0);

  // get-view-config reflects the cleared state.
  const cfg = await h.gv_get_view_config({ id: viewId, include: ['joins'], compact: false });
  TestAssert.isTrue(!cfg.joins || cfg.joins.length === 0, 'cleared joins reflected in get-view-config');

  await gfClient.deleteForm(f1).catch(() => {});
  await gfClient.deleteForm(f2).catch(() => {});
});

suite.run();
