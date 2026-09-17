/**
 * Tests for the GravityView abilities-loader.
 *
 * Guards the MCP `tools/list` contract — every auto-generated tool MUST
 * present an `inputSchema` of shape `{ type: 'object', properties: <Record>, … }`
 * or Claude Code's MCP client rejects the entire catalog with a Zod
 * validation error (this happened in the wild: tools 29–36 had an array
 * `inputSchema`, tool 57 had `properties: []`).
 */

import { TestRunner, TestAssert } from './helpers.js';
import {
  normalizeInputSchema,
  loadAbilitiesAsTools,
  methodForAbility,
  FOUNDATION_CATALOG_ROUTE,
  CORE_ABILITIES_ROUTE,
} from '../src/abilities/loader.js';

const suite = new TestRunner('Abilities Loader Tests');

/**
 * The MCP-contract assertion: every generated tool's inputSchema must
 * satisfy these invariants. Mirrors the shape `@modelcontextprotocol/sdk`
 * validates with Zod under `ListToolsRequestSchema`.
 */
function assertValidMcpInputSchema(schema, label = 'inputSchema') {
  TestAssert.isTrue(
    schema !== null && typeof schema === 'object' && !Array.isArray(schema),
    `${label}: must be a plain object, got ${Array.isArray(schema) ? 'array' : typeof schema}`,
  );
  TestAssert.equal(schema.type, 'object', `${label}.type must be "object"`);
  TestAssert.isTrue(
    schema.properties !== null
      && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties),
    `${label}.properties must be a Record<string,JSONSchema>, got ${Array.isArray(schema.properties) ? 'array' : typeof schema.properties}`,
  );
}

// ---------------------------------------------------------------------------
// normalizeInputSchema unit tests — cover every shape we've seen the WP
// Abilities API emit (or any shape PHP could plausibly emit).
// ---------------------------------------------------------------------------

suite.test('normalizeInputSchema: passes a valid schema through unchanged', () => {
  const valid = {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id'],
  };
  const out = normalizeInputSchema(valid);
  assertValidMcpInputSchema(out);
  TestAssert.deepEqual(out.properties, valid.properties);
  TestAssert.deepEqual(out.required, ['id']);
});

suite.test('normalizeInputSchema: wraps a top-level array (tools 29-36 bug)', () => {
  // The bug Claude Code surfaced: abilities 29-36 emitted `input_schema`
  // as a raw array, blowing MCP's `expected object, received array` Zod check.
  const arrayShaped = [
    { name: 'view_id', type: 'integer', required: true, description: 'The View ID.' },
    { name: 'compact', type: 'boolean', description: 'Strip empty fields.' },
  ];
  const out = normalizeInputSchema(arrayShaped);
  assertValidMcpInputSchema(out);
  TestAssert.isTrue('view_id' in out.properties, 'view_id property derived from entry.name');
  TestAssert.isTrue('compact' in out.properties, 'compact property derived from entry.name');
  TestAssert.deepEqual(out.required, ['view_id'], 'required: true lifts to outer required array');
  // Ensure the descriptor's `name` was stripped from the value (now it's the key).
  TestAssert.equal(out.properties.view_id.name, undefined);
  TestAssert.equal(out.properties.view_id.type, 'integer');
});

suite.test('normalizeInputSchema: coerces properties: [] (tool 57 bug)', () => {
  // PHP serialises an empty associative array as JSON `[]`. When `properties`
  // hits the MCP client like that, Zod fails with `expected record, received array`.
  const objectWithArrayProps = { type: 'object', properties: [] };
  const out = normalizeInputSchema(objectWithArrayProps);
  assertValidMcpInputSchema(out);
  TestAssert.deepEqual(out.properties, {});
});

suite.test('normalizeInputSchema: coerces properties: [descriptor, …]', () => {
  // Non-empty array under `properties`, same descriptor format as the
  // top-level-array case but nested. Treat it as a property descriptor list.
  const schema = {
    type: 'object',
    properties: [
      { name: 'slot', type: 'integer' },
      { name: 'ref', type: 'string', required: true },
    ],
  };
  const out = normalizeInputSchema(schema);
  assertValidMcpInputSchema(out);
  TestAssert.deepEqual(Object.keys(out.properties).sort(), ['ref', 'slot']);
  TestAssert.deepEqual(out.required, ['ref']);
});

suite.test('normalizeInputSchema: missing input_schema → open object', () => {
  for (const empty of [undefined, null, false]) {
    const out = normalizeInputSchema(empty);
    assertValidMcpInputSchema(out, `normalize(${empty})`);
    TestAssert.deepEqual(out.properties, {});
    TestAssert.equal(out.additionalProperties, true);
  }
});

suite.test('normalizeInputSchema: forces type:"object" when upstream omits it', () => {
  // Some abilities ship `properties` but forget `type` — common in
  // hand-written PHP schemas.
  const out = normalizeInputSchema({ properties: { id: { type: 'integer' } } });
  assertValidMcpInputSchema(out);
  TestAssert.equal(out.type, 'object');
});

suite.test('normalizeInputSchema: preserves sibling keys (required, additionalProperties, …)', () => {
  const out = normalizeInputSchema({
    type: 'object',
    properties: { foo: { type: 'string' } },
    required: ['foo'],
    additionalProperties: false,
    description: 'A widget',
  });
  TestAssert.deepEqual(out.required, ['foo']);
  TestAssert.equal(out.additionalProperties, false);
  TestAssert.equal(out.description, 'A widget');
});

suite.test('normalizeInputSchema: anonymous array entries get arg<N> keys', () => {
  // Defensive: if a descriptor lacks name/slug/key/title, we shouldn't
  // silently drop it — we synthesize a key so the agent can still bind it.
  const out = normalizeInputSchema([{ type: 'string' }, { type: 'integer' }]);
  assertValidMcpInputSchema(out);
  TestAssert.deepEqual(Object.keys(out.properties).sort(), ['arg0', 'arg1']);
});

suite.test('normalizeInputSchema: never mutates its input', () => {
  const input = { type: 'object', properties: [] };
  const before = JSON.stringify(input);
  normalizeInputSchema(input);
  TestAssert.equal(JSON.stringify(input), before, 'input was mutated');
});

// ---------------------------------------------------------------------------
// Integration: drive loadAbilitiesAsTools with a synthetic catalog that
// reproduces the wire-format Zod failures, and confirm every generated
// tool now satisfies the MCP contract.
// ---------------------------------------------------------------------------

/**
 * Stub gvClient for the WP-core fallback path: the Foundation catalog
 * 404s (older Foundation without gravitykit/v1), the core catalog
 * serves `catalog`. Records every request config in `requests`.
 */
function buildStubGvClient(catalog) {
  const requests = [];
  return {
    baseUrl: 'https://test.invalid',
    requests,
    httpClient: {
      request: async (config) => {
        requests.push(config);
        if (config.url === FOUNDATION_CATALOG_ROUTE) {
          const err = new Error('Request failed with status code 404');
          err.response = { status: 404 };
          throw err;
        }
        return { data: catalog, headers: {} };
      },
    },
  };
}

/**
 * Stub gvClient whose Foundation catalog 404s and whose WP-core catalog is
 * PAGINATED: `corePages` is an array of item-arrays, served by `page`, with
 * X-WP-TotalPages set. Core's list endpoint paginates at 50 per page by
 * default, so a site with more abilities than that is the normal case rather
 * than an edge one.
 */
function buildCorePaginatedStubGvClient(corePages) {
  const requests = [];
  return {
    baseUrl: 'https://test.invalid',
    requests,
    httpClient: {
      request: async (config) => {
        requests.push(config);
        if (config.url === FOUNDATION_CATALOG_ROUTE) {
          const err = new Error('Request failed with status code 404');
          err.response = { status: 404 };
          throw err;
        }
        if (config.url === CORE_ABILITIES_ROUTE) {
          const page = config.params?.page || 1;
          return {
            data:    corePages[page - 1] || [],
            headers: { 'x-wp-totalpages': String(corePages.length) },
          };
        }
        return { data: { ok: true }, headers: {} };
      },
    },
  };
}

/**
 * Stub gvClient whose Foundation catalog responds with the given pages
 * (array of item-arrays; X-WP-TotalPages = pages.length). Core-catalog
 * requests serve `coreCatalog`. Records every request config in
 * `requests` so tests can assert handler execution wiring.
 */
function buildCatalogStubGvClient(pages, { coreCatalog = [] } = {}) {
  const requests = [];
  return {
    baseUrl: 'https://test.invalid',
    requests,
    httpClient: {
      request: async (config) => {
        requests.push(config);
        if (config.url === FOUNDATION_CATALOG_ROUTE) {
          const page = config.params?.page || 1;
          return {
            data: pages[page - 1] || [],
            headers: { 'x-wp-totalpages': String(pages.length) },
          };
        }
        if (config.url === CORE_ABILITIES_ROUTE) {
          return { data: coreCatalog, headers: {} };
        }
        // Ability /run executions.
        return { data: { ok: true }, headers: {} };
      },
    },
  };
}

/**
 * Synthetic WP-core catalog covering the three failure modes + a healthy
 * ability. GravityKit items carry the `gk_registered_by` stamp and the
 * `mcp_tool_name` Foundation applies to every ability it registers —
 * the core-path filter + naming contract.
 */
function syntheticCatalog() {
  return [
    // Healthy reference — must round-trip untouched.
    {
      name: 'gk-gravityview/layouts-list',
      description: 'List installed layouts',
      input_schema: { type: 'object', properties: { compact: { type: 'boolean' } } },
      meta: { gk_registered_by: 'gravitykit', mcp_tool_name: 'gv_layouts_list', annotations: { readonly: true } },
    },
    // Bug shape #1 — input_schema is itself an array (tools 29-36).
    {
      name: 'gk-gravityview/view-field-add',
      description: 'Add a field to a View',
      input_schema: [
        { name: 'view_id', type: 'integer', required: true },
        { name: 'field_id', type: 'string', required: true },
      ],
      meta: { gk_registered_by: 'gravitykit', mcp_tool_name: 'gv_view_field_add', annotations: {} },
    },
    // Bug shape #2 — properties is an array (tool 57).
    {
      name: 'gk-multiple-forms/list-joins',
      description: 'List joins',
      input_schema: { type: 'object', properties: [] },
      meta: { gk_registered_by: 'gravitykit', mcp_tool_name: 'gk_list_joins', annotations: { readonly: true } },
    },
    // Another plugin's ability — no Foundation stamp, must be filtered out.
    {
      name: 'core/unrelated-ability',
      description: 'Should not be exposed',
      input_schema: { type: 'object', properties: {} },
      meta: { annotations: {} },
    },
  ];
}

suite.test('core fallback: filters on Foundation\'s gk_registered_by stamp, unstamped abilities excluded', async () => {
  const { definitions, count, source } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  TestAssert.equal(source, 'wp-core', 'catalog 404 must route to the WP-core path');
  TestAssert.equal(count, 3, 'expected 3 stamped abilities, got ' + count);
  TestAssert.equal(definitions.length, 3, 'definitions count must match');
  const names = definitions.map((d) => d.name).sort();
  TestAssert.deepEqual(names, ['gk_list_joins', 'gv_layouts_list', 'gv_view_field_add']);
});

suite.test('core fallback: cross-product abilities included; meta.mcp_tool_name beats gv_ derivation', async () => {
  const catalog = [
    ...syntheticCatalog(),
    {
      // A different GravityKit product — included via the same stamp,
      // named by the server, not the gv_ derivation.
      name: 'gk-gravitycharts/charts-list',
      description: 'List charts',
      input_schema: { type: 'object', properties: {} },
      meta: {
        gk_registered_by: 'gravitykit',
        mcp_tool_name: 'gc_charts_list',
        annotations: { readonly: true },
      },
    },
  ];
  const { definitions, source } = await loadAbilitiesAsTools(buildStubGvClient(catalog));
  TestAssert.equal(source, 'wp-core');
  const names = definitions.map((d) => d.name).sort();
  TestAssert.deepEqual(names, ['gc_charts_list', 'gk_list_joins', 'gv_layouts_list', 'gv_view_field_add']);
});

// ---------------------------------------------------------------------------
// Foundation catalog path — the canonical source. Items use the
// gravitykit/v1 Manager::to_rest_item() shape: top-level `annotations`,
// `enabled`, `mcp_tool_name`; already GravityKit-only server-side.
// ---------------------------------------------------------------------------

function syntheticFoundationCatalog() {
  return [
    {
      name: 'gk-gravityview/views-list',
      label: 'List Views',
      description: 'List editable Views.',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_views_list',
    },
    {
      // Cross-product — the catalog path trusts the server's
      // GravityKit-only filtering; no client-side product list.
      name: 'gk-gravitycharts/charts-list',
      label: 'List Charts',
      description: 'List charts.',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gc_charts_list',
    },
    {
      // Defensive: the server omits disabled by default, but if one
      // arrives flagged enabled:false it must be skipped.
      name: 'gk-gravityview/view-status-set',
      description: 'Disabled ability',
      input_schema: { type: 'object', properties: {} },
      annotations: {},
      enabled: false,
      mcp_tool_name: 'gv_view_status_set',
    },
    {
      // No mcp_tool_name → must be SKIPPED with a warning; the client
      // never invents tool names.
      name: 'gk-gravityview/layouts-list',
      description: 'List layouts',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
    },
  ];
}

suite.test('catalog path: server-owned naming; disabled and unnamed items skipped', async () => {
  const stub = buildCatalogStubGvClient([syntheticFoundationCatalog()]);
  const { definitions, count, source } = await loadAbilitiesAsTools(stub);
  TestAssert.equal(source, 'foundation-catalog');
  const names = definitions.map((d) => d.name).sort();
  TestAssert.deepEqual(names, ['gc_charts_list', 'gv_views_list']);
  TestAssert.equal(count, 2);
});

suite.test('catalog path: handlers execute via /wp-abilities/v1 run route with annotation-derived method', async () => {
  const stub = buildCatalogStubGvClient([syntheticFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gc_charts_list({});
  const run = stub.requests.find((r) => typeof r.url === 'string' && r.url.includes('/run'));
  TestAssert.isTrue(!!run, 'handler must hit the run endpoint');
  TestAssert.equal(run.url, '/wp-json/wp-abilities/v1/abilities/gk-gravitycharts/charts-list/run');
  TestAssert.equal(run.method, 'GET');
});

suite.test('catalog path: paginates via X-WP-TotalPages', async () => {
  const items = syntheticFoundationCatalog();
  const stub = buildCatalogStubGvClient([[items[0]], [items[1]]]);
  const { count, source } = await loadAbilitiesAsTools(stub);
  TestAssert.equal(source, 'foundation-catalog');
  TestAssert.equal(count, 2);
});

suite.test('catalog path: tool-name collision — first wins, later skipped, never shadowed', async () => {
  const colliding = [
    {
      name: 'gk-gravityview/views-list',
      description: 'first claimant',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_views_list',
    },
    {
      name: 'gk-gravityboard/views-list',
      description: 'colliding claimant',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_views_list',
    },
  ];
  const stub = buildCatalogStubGvClient([colliding]);
  const { definitions, handlers, count } = await loadAbilitiesAsTools(stub);
  TestAssert.equal(count, 1, 'collision must not produce two tools');
  TestAssert.equal(definitions[0].description, 'first claimant');
  await handlers.gv_views_list({});
  const run = stub.requests.find((r) => typeof r.url === 'string' && r.url.includes('/run'));
  TestAssert.equal(run.url, '/wp-json/wp-abilities/v1/abilities/gk-gravityview/views-list/run', 'handler must stay bound to the first claimant');
});

suite.test('coexistence: Gravity Forms own abilities (feature-abilities-api) are never surfaced', async () => {
  // Exact shape GF's branch registers (GF_Abilities_Registry::definition):
  // gravityforms/* namespace, meta.mcp + annotations + show_in_rest:true,
  // and NO gk_registered_by stamp. show_in_rest means these DO appear in
  // the WP core catalog our fallback reads — the metadata filter is the
  // only thing keeping them out.
  const catalog = [
    ...syntheticCatalog(),
    {
      name: 'gravityforms/forms-list',
      label: 'List Forms',
      description: 'Lists Gravity Forms forms.',
      input_schema: { type: 'object', properties: {} },
      meta: {
        mcp: { public: true },
        annotations: { readonly: true, destructive: false, idempotent: true },
        show_in_rest: true,
      },
    },
    {
      // GF add-on convention uses a second slash.
      name: 'gravityforms/myaddon/my-action',
      description: 'Add-on ability.',
      input_schema: { type: 'object', properties: {} },
      meta: { mcp: { public: true }, annotations: {}, show_in_rest: true },
    },
  ];
  const { definitions, source } = await loadAbilitiesAsTools(buildStubGvClient(catalog));
  TestAssert.equal(source, 'wp-core');
  const names = definitions.map((d) => d.name);
  TestAssert.isTrue(!names.some((n) => n.includes('forms_list')), 'GF core abilities must not become tools');
  TestAssert.isTrue(!names.some((n) => n.includes('my_action')), 'GF add-on abilities must not become tools');
  TestAssert.equal(definitions.length, 3, 'only the gk_registered_by-stamped abilities surface');
});

suite.test('reserved names: catalog tools can never shadow the built-in gf_* contract', async () => {
  const colliding = [
    {
      // Hypothetical future gk-gravity-forms ability whose server name
      // collides with a released built-in tool — must be skipped.
      name: 'gk-gravity-forms/forms-list-legacy',
      description: 'Catalog claimant for a built-in name',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gf_list_forms',
    },
    {
      name: 'gk-gravityview/views-list',
      description: 'Safe name',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_views_list',
    },
  ];
  const stub = buildCatalogStubGvClient([colliding]);
  const { definitions, handlers, count } = await loadAbilitiesAsTools(stub, {
    reservedNames: new Set(['gf_list_forms', 'gk_reload_abilities']),
  });
  TestAssert.equal(count, 1, 'reserved-name claimant must be skipped');
  TestAssert.deepEqual(definitions.map((d) => d.name), ['gv_views_list']);
  TestAssert.equal(handlers.gf_list_forms, undefined, 'no handler may bind to a reserved name');
});

suite.test('empty catalog → falls back to WP core path', async () => {
  const stub = buildCatalogStubGvClient([[]], { coreCatalog: syntheticCatalog() });
  const { source, count } = await loadAbilitiesAsTools(stub);
  TestAssert.equal(source, 'wp-core');
  TestAssert.equal(count, 3);
});

suite.test('loadAbilitiesAsTools: EVERY generated tool has a valid MCP inputSchema', async () => {
  // The contract check that would have caught the production regression.
  const catalog = syntheticCatalog();
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(catalog));
  for (const def of definitions) {
    assertValidMcpInputSchema(def.inputSchema, `${def.name}.inputSchema`);
  }
});

suite.test('loadAbilitiesAsTools: tools 29-36 repro — array input_schema is wrapped', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gv_view_field_add');
  TestAssert.isTrue(!!tool, 'gv_view_field_add must exist');
  assertValidMcpInputSchema(tool.inputSchema);
  TestAssert.isTrue('view_id' in tool.inputSchema.properties);
  TestAssert.isTrue('field_id' in tool.inputSchema.properties);
  TestAssert.deepEqual(tool.inputSchema.required.sort(), ['field_id', 'view_id']);
});

suite.test('loadAbilitiesAsTools: tool 57 repro — properties:[] becomes properties:{}', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gk_list_joins');
  TestAssert.isTrue(!!tool, 'gk_list_joins must exist');
  assertValidMcpInputSchema(tool.inputSchema);
  TestAssert.deepEqual(tool.inputSchema.properties, {});
});

suite.test('loadAbilitiesAsTools: healthy schema passes through untouched', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gv_layouts_list');
  TestAssert.isTrue(!!tool);
  TestAssert.deepEqual(tool.inputSchema.properties, { compact: { type: 'boolean' } });
});

// ---------------------------------------------------------------------------
// executeAbility request shape (driven through the public handler; the mock
// captures the wire config). Empty-input contract: every ability is sent an
// OBJECT input, never null/omitted — GET → input='' (WP treats it as {} via
// rest_is_object('')); POST → {input:{}}. Foundation guarantees every ability
// declares an object input_schema, so a null/absent input would only ever 400
// against type:object; sending {} is always correct. The loader does not
// inspect the schema.
// ---------------------------------------------------------------------------

/**
 * Foundation catalog exercising the request shape across GET/POST and
 * abilities that do or don't declare an input_schema. The loader always sends
 * an object input regardless, so the schema and no-schema rows behave
 * identically — the no-schema rows guard against the loader trying to be clever.
 */
function inputSchemaFenceCatalog() {
  return [
    {
      name: 'gk-gravityview/views-list',
      description: 'GET with object input_schema',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_schema_get',
    },
    {
      name: 'gk-gravityview/view-create',
      description: 'POST with object input_schema',
      input_schema: { type: 'object', properties: { title: { type: 'string' } } },
      annotations: {},
      enabled: true,
      mcp_tool_name: 'gv_schema_post',
    },
    {
      name: 'gk-gravityview/view-delete-hard',
      description: 'DELETE with object input_schema',
      input_schema: { type: 'object', properties: {} },
      annotations: { destructive: true, idempotent: true },
      enabled: true,
      mcp_tool_name: 'gv_schema_delete',
    },
    {
      name: 'gk-gravityview/ping-get',
      description: 'GET with NO input_schema',
      // No input_schema key at all.
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_noschema_get',
    },
    {
      name: 'gk-gravityview/ping-post',
      description: 'POST with NO input_schema',
      // No input_schema key at all.
      annotations: {},
      enabled: true,
      mcp_tool_name: 'gv_noschema_post',
    },
  ];
}

/** Find the captured /run request for a given ability name. */
function findRun(stub, abilityName) {
  return stub.requests.find(
    (r) => typeof r.url === 'string' && r.url === `/wp-json/wp-abilities/v1/abilities/${abilityName}/run`,
  );
}

suite.test('executeAbility: object input_schema + empty input → GET sends params {input:\'\'}', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_get({});
  const run = findRun(stub, 'gk-gravityview/views-list');
  TestAssert.isTrue(!!run, 'GET ability must hit the run endpoint');
  TestAssert.equal(run.method, 'GET');
  TestAssert.deepEqual(run.params, { input: '' }, 'empty object input → input="" (WP rest_is_object(\'\')===true)');
  TestAssert.equal(run.data, undefined, 'GET must not carry a body');
});

suite.test('executeAbility: object input_schema + empty input → POST body {input:{}}', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_post({});
  const run = findRun(stub, 'gk-gravityview/view-create');
  TestAssert.isTrue(!!run, 'POST ability must hit the run endpoint');
  TestAssert.equal(run.method, 'POST');
  TestAssert.deepEqual(run.data, { input: {} }, 'empty object input → body {input:{}}');
  TestAssert.equal(run.params, undefined, 'POST must not carry query params');
});

suite.test('executeAbility: empty input on a GET ability → params {input:\'\'} even without a declared schema', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_noschema_get({});
  const run = findRun(stub, 'gk-gravityview/ping-get');
  TestAssert.isTrue(!!run, 'GET ability must hit the run endpoint');
  TestAssert.equal(run.method, 'GET');
  TestAssert.deepEqual(run.params, { input: '' }, 'empty input → input="" (object); the loader always sends an object');
});

suite.test('executeAbility: empty input on a POST ability → body {input:{}} even without a declared schema', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_noschema_post({});
  const run = findRun(stub, 'gk-gravityview/ping-post');
  TestAssert.isTrue(!!run, 'POST ability must hit the run endpoint');
  TestAssert.equal(run.method, 'POST');
  TestAssert.deepEqual(run.data, { input: {} }, 'empty input → body {input:{}}; the loader always sends an object');
});

suite.test('executeAbility: non-empty input → GET bracketed params (unchanged)', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_get({ id: 7, nested: { k: 'v' } });
  const run = findRun(stub, 'gk-gravityview/views-list');
  TestAssert.isTrue(!!run, 'GET ability must hit the run endpoint');
  TestAssert.equal(run.method, 'GET');
  TestAssert.deepEqual(
    run.params,
    { 'input[id]': 7, 'input[nested][k]': 'v' },
    'non-empty input expands to bracketed query params',
  );
});

suite.test('executeAbility: non-empty input → POST body {input:{...}} (unchanged)', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_post({ title: 'Hello' });
  const run = findRun(stub, 'gk-gravityview/view-create');
  TestAssert.isTrue(!!run, 'POST ability must hit the run endpoint');
  TestAssert.equal(run.method, 'POST');
  TestAssert.deepEqual(run.data, { input: { title: 'Hello' } }, 'non-empty input nests under input key');
});

suite.test('executeAbility: non-empty input on a schemaless ability still sends it (bracketed)', async () => {
  // The loader always forwards caller-supplied keys verbatim (bracketed); the
  // server, not the loader, is the authority on whether that ability accepts
  // the input.
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_noschema_get({ q: 'x' });
  const run = findRun(stub, 'gk-gravityview/ping-get');
  TestAssert.deepEqual(run.params, { 'input[q]': 'x' }, 'keys present → bracketed params regardless of schema');
});

suite.test('executeAbility: empty input → DELETE sends params {input:\'\'} (parity with GET)', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  // allowDelete: this test pins the DELETE wire shape; gating has its own tests.
  const { handlers } = await loadAbilitiesAsTools(stub, { allowDelete: true });
  await handlers.gv_schema_delete({});
  const run = findRun(stub, 'gk-gravityview/view-delete-hard');
  TestAssert.isTrue(!!run, 'DELETE ability must hit the run endpoint');
  TestAssert.equal(run.method, 'DELETE');
  TestAssert.deepEqual(run.params, { input: '' }, 'empty object input → input="" on DELETE');
  TestAssert.equal(run.data, undefined, 'DELETE must not carry a body');
});

suite.test('executeAbility: input whose keys flatten to nothing ({nested:{}}) → GET params {input:\'\'}', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_get({ nested: {} });
  const run = findRun(stub, 'gk-gravityview/views-list');
  TestAssert.equal(run.method, 'GET');
  TestAssert.deepEqual(run.params, { input: '' }, '{nested:{}} serializes to no params → must still send input="" (else WP 400s on null)');
});

suite.test('executeAbility: input with only null values ({a:null}) → GET params {input:\'\'}', async () => {
  const stub = buildCatalogStubGvClient([inputSchemaFenceCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);
  await handlers.gv_schema_get({ a: null });
  const run = findRun(stub, 'gk-gravityview/views-list');
  TestAssert.equal(run.method, 'GET');
  TestAssert.deepEqual(run.params, { input: '' }, '{a:null} drops in walkInputToBracketedParams → must still send input=""');
});

// ---------------------------------------------------------------------------
// Lightweight smoke for the existing helpers — these have no tests yet and
// regressions here would silently mis-route every gv_* call.
// ---------------------------------------------------------------------------

suite.test('methodForAbility: readonly → GET, destructive+idempotent → DELETE, else POST', () => {
  TestAssert.equal(methodForAbility({ readonly: true }), 'GET');
  TestAssert.equal(methodForAbility({ destructive: true, idempotent: true }), 'DELETE');
  // Destructive but NOT idempotent (e.g. view-delete with default soft trash)
  // must POST — Foundation's run controller rejects DELETE on these with 405.
  TestAssert.equal(methodForAbility({ destructive: true, idempotent: false }), 'POST');
  TestAssert.equal(methodForAbility({ destructive: true }), 'POST');
  TestAssert.equal(methodForAbility({}), 'POST');
  TestAssert.equal(methodForAbility(), 'POST');
});

suite.test('methodForAbility: null / non-object annotations → POST (no throw)', () => {
  TestAssert.equal(methodForAbility(null), 'POST');
  TestAssert.equal(methodForAbility('nope'), 'POST');
});

// ---------------------------------------------------------------------------
// MCP annotations + destructive gating + next_steps surfacing. The loader
// used to read ability annotations only to pick the HTTP method and then
// DROP them from the tool definition — so gv_view_delete reached MCP clients
// with no destructiveHint (no confirmation prompt) while the far less
// dangerous gf_delete_* tools were both hinted AND env-gated.
// ---------------------------------------------------------------------------

function annotatedFoundationCatalog() {
  return [
    {
      name: 'gk-gravityview/views-list',
      description: 'List Views.',
      input_schema: { type: 'object', properties: {} },
      annotations: { readonly: true },
      enabled: true,
      mcp_tool_name: 'gv_views_list',
    },
    {
      name: 'gk-gravityview/view-delete',
      description: 'Delete a View.',
      input_schema: { type: 'object', properties: { id: { type: 'integer' } } },
      annotations: { destructive: true, idempotent: true },
      enabled: true,
      mcp_tool_name: 'gv_view_delete',
    },
    {
      // Destructive but NOT idempotent → executes as POST, must still be gated.
      name: 'gk-gravityview/view-trash',
      description: 'Trash a View.',
      input_schema: { type: 'object', properties: {} },
      annotations: { destructive: true },
      enabled: true,
      mcp_tool_name: 'gv_view_trash',
    },
    {
      name: 'gk-gravityview/view-create',
      description: 'Create a View.',
      input_schema: { type: 'object', properties: {} },
      annotations: {},
      enabled: true,
      mcp_tool_name: 'gv_view_create',
    },
  ];
}

suite.test('annotations: ability annotations map onto MCP tool annotations', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { definitions } = await loadAbilitiesAsTools(stub);
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));

  TestAssert.deepEqual(byName.gv_views_list.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  });
  TestAssert.deepEqual(byName.gv_view_delete.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
  TestAssert.deepEqual(byName.gv_view_trash.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  });
  TestAssert.deepEqual(byName.gv_view_create.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  });
});

suite.test('annotations: core-path meta.annotations map the same way', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gv_layouts_list');
  TestAssert.equal(tool.annotations.readOnlyHint, true);
  TestAssert.equal(tool.annotations.destructiveHint, false);
  TestAssert.equal(tool.annotations.openWorldHint, true);
});

suite.test('gating: destructive ability handlers refuse to run when nothing is permitted', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);

  for (const toolName of ['gv_view_delete', 'gv_view_trash']) {
    let threw = null;
    try {
      await handlers[toolName]({ id: 1 });
    } catch (err) {
      threw = err;
    }
    TestAssert.isTrue(!!threw, `${toolName} must throw when nothing is permitted`);
    TestAssert.isTrue(
      /GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE/.test(threw.message),
      `${toolName} error must name the setting that enables it, got: ${threw.message}`
    );
  }
  const runs = stub.requests.filter((r) => typeof r.url === 'string' && r.url.includes('/run'));
  TestAssert.equal(runs.length, 0, 'no gated call may reach the wire');
});

suite.test('gating: destructive handlers execute when allowDelete is true; method logic unchanged', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub, { allowDelete: true });

  await handlers.gv_view_delete({ id: 1 });
  await handlers.gv_view_trash({});
  const runs = stub.requests.filter((r) => typeof r.url === 'string' && r.url.includes('/run'));
  TestAssert.equal(runs.length, 2);
  TestAssert.equal(runs[0].method, 'DELETE', 'destructive+idempotent must stay DELETE');
  TestAssert.equal(runs[1].method, 'POST', 'destructive non-idempotent must stay POST');
});

suite.test('gating: readonly and non-destructive handlers are never gated', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);

  await handlers.gv_views_list({});
  await handlers.gv_view_create({});
  const runs = stub.requests.filter((r) => typeof r.url === 'string' && r.url.includes('/run'));
  TestAssert.equal(runs.length, 2);
  TestAssert.equal(runs[0].method, 'GET');
  TestAssert.equal(runs[1].method, 'POST');
});

suite.test('gating: a gated destructive tool says so, and names itself', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { definitions } = await loadAbilitiesAsTools(stub);
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));

  // Naming the tool, not just the setting: the agent has to be able to tell a
  // person exactly what to add.
  TestAssert.isTrue(/GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE/.test(byName.gv_view_delete.description));
  TestAssert.isTrue(/gv_view_delete/.test(byName.gv_view_delete.description));
  TestAssert.isTrue(/GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE/.test(byName.gv_view_trash.description));
  TestAssert.isTrue(!/GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE/.test(byName.gv_views_list.description));
});

suite.test('gating: the old boolean still permits everything', async () => {
  // A server configured before the allow-list existed keeps working.
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub, { allowDelete: true });

  await handlers.gv_view_delete({ id: 1 });
  await handlers.gv_view_trash({ id: 1 });
});

suite.test('next_steps: surfaced in the description, mapped to exposed tool names', async () => {
  const catalog = annotatedFoundationCatalog();
  // Foundation ships next_steps inside annotations ([{ability, when}, …]).
  catalog[0].annotations = {
    readonly: true,
    next_steps: [
      { ability: 'gk-gravityview/view-create', when: 'After picking a View to clone.' },
      { ability: 'gk-gravityview/not-exposed', when: 'Never — not a registered tool.' },
    ],
  };
  const stub = buildCatalogStubGvClient([catalog]);
  const { definitions } = await loadAbilitiesAsTools(stub);
  const tool = definitions.find((d) => d.name === 'gv_views_list');
  TestAssert.isTrue(
    /gv_view_create/.test(tool.description),
    `next-step ability must be named by its TOOL name, got: ${tool.description}`
  );
  TestAssert.isTrue(/After picking a View to clone\./.test(tool.description), 'the when-guidance must survive');
  TestAssert.isTrue(!/not-exposed/.test(tool.description), 'steps pointing at unexposed abilities are dropped');
});

suite.test('next_steps: absent or malformed next_steps leave the description untouched', async () => {
  const catalog = annotatedFoundationCatalog();
  catalog[3].annotations = { next_steps: 'not-an-array' };
  const stub = buildCatalogStubGvClient([catalog]);
  const { definitions } = await loadAbilitiesAsTools(stub);
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));
  TestAssert.equal(byName.gv_view_create.description, 'Create a View.');
});

/**
 * A GravityKit ability on page two of the WP-core catalog.
 *
 * @param {number} n Distinguishes one from the next.
 * @returns {object} Core catalog item.
 */
function coreAbility(n) {
  return {
    name:         `gk-gravityview/paged-${n}`,
    description:  `Paged ability ${n}`,
    input_schema: { type: 'object', properties: {} },
    meta:         {
      gk_registered_by: 'gravitykit',
      mcp_tool_name:    `gv_paged_${n}`,
      annotations:      { readonly: true },
    },
  };
}

suite.test('core fallback: follows X-WP-TotalPages instead of stopping at the first page', async () => {
  // WP core's list endpoint defaults to 50 per page. A site carrying GravityView's
  // 49 abilities plus another product's already spills onto page two, so a
  // single-request fallback silently serves a partial catalog.
  const pageOne = Array.from({ length: 50 }, (unused, i) => coreAbility(i + 1));
  const pageTwo = [ coreAbility(51), coreAbility(52) ];

  const gvClient = buildCorePaginatedStubGvClient([ pageOne, pageTwo ]);
  const { definitions, source } = await loadAbilitiesAsTools(gvClient);

  TestAssert.equal(source, 'wp-core', 'catalog 404 must route to the WP-core path');
  TestAssert.equal(definitions.length, 52, 'every page of the core catalog must be loaded');
  TestAssert.isTrue(
    definitions.some((d) => d.name === 'gv_paged_52'),
    'an ability on the second page must reach the tool list'
  );
});

suite.test('core fallback: asks for the largest page WP core allows', async () => {
  const gvClient = buildCorePaginatedStubGvClient([ [ coreAbility(1) ] ]);
  await loadAbilitiesAsTools(gvClient);

  const coreRequest = gvClient.requests.find((r) => r.url === CORE_ABILITIES_ROUTE);

  TestAssert.equal(coreRequest?.params?.per_page, 100, 'per_page must be requested, at core\'s maximum');
  TestAssert.equal(coreRequest?.params?.page, 1, 'the first page must be asked for explicitly');
});

suite.test('gating: a permitted destructive tool does not claim it is gated', async () => {
  // The suffix is a statement about this server's configuration. Appending it
  // unconditionally tells a correctly configured agent that every destructive
  // tool is switched off, which is the opposite of true.
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { definitions } = await loadAbilitiesAsTools(stub, { allowDelete: true });
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));

  TestAssert.isFalse(
    /GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE|ALLOW_DELETE/.test(byName.gv_view_delete.description),
    'a permitted destructive tool must not advertise a gate it is past'
  );
});

suite.test('gating: allows one product without unlocking another', async () => {
  // A Migrate user who needs bundle-import should not thereby be able to delete
  // Views. The gate takes a list, not a boolean.
  const catalog = annotatedFoundationCatalog();
  catalog.push({
    name: 'gk-gravitymigrate/bundle-import',
    description: 'Import a bundle.',
    input_schema: { type: 'object', properties: {} },
    annotations: { destructive: true },
    enabled: true,
    mcp_tool_name: 'gmig_bundle_import',
  });

  const stub = buildCatalogStubGvClient([catalog]);
  const { handlers } = await loadAbilitiesAsTools(stub, { allowDestructive: ['gmig'] });

  await handlers.gmig_bundle_import({});

  let refused = null;
  try {
    await handlers.gv_view_delete({ id: 1 });
  } catch (error) {
    refused = error.message;
  }

  TestAssert.isNotNull(refused, 'a product outside the allow-list must stay gated');
  TestAssert.isTrue(
    refused.includes('destructive'),
    `the refusal must name what it refuses, got: ${refused}`
  );
});

suite.test('gating: an exact tool name can be permitted on its own', async () => {
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub, { allowDestructive: ['gv_view_delete'] });

  await handlers.gv_view_delete({ id: 1 });

  let refused = null;
  try {
    await handlers.gv_view_trash({ id: 1 });
  } catch (error) {
    refused = error.message;
  }

  TestAssert.isNotNull(refused, 'only the named tool may be permitted');
});

suite.test('gating: the refusal says destructive, not delete', async () => {
  // "Delete operations are disabled" is wrong for an import, which is the
  // reason the gate is reached most often outside Gravity Forms.
  const stub = buildCatalogStubGvClient([annotatedFoundationCatalog()]);
  const { handlers } = await loadAbilitiesAsTools(stub);

  let refused = null;
  try {
    await handlers.gv_view_delete({ id: 1 });
  } catch (error) {
    refused = error.message;
  }

  TestAssert.isFalse(/Delete operations/.test(refused), `got: ${refused}`);
});

suite.test('next_steps: never advertises a tool the collision guard dropped', async () => {
  // toolNameByAbility was built from every entry before the collision guard ran,
  // so a step could name a tool that is not in the list the agent received.
  const catalog = annotatedFoundationCatalog();
  catalog.push({
    name: 'gk-other/views-list',
    description: 'A second product claiming the same tool name.',
    input_schema: { type: 'object', properties: {} },
    annotations: {},
    enabled: true,
    mcp_tool_name: 'gv_views_list',
  });
  catalog[1].annotations = {
    destructive: true,
    idempotent: true,
    next_steps: [{ ability: 'gk-other/views-list', when: 'afterwards' }],
  };

  const stub = buildCatalogStubGvClient([catalog]);
  const { definitions } = await loadAbilitiesAsTools(stub);
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));
  const exposed = new Set(definitions.map((d) => d.name));

  const hint = byName.gv_view_delete.description;
  const named = (hint.match(/\bg[a-z]+_[a-z_]+\b/g) || []).filter((n) => n !== 'gv_view_delete');

  for (const name of named) {
    TestAssert.isTrue(exposed.has(name), `next_steps named "${name}", which is not in the tool list`);
  }
});

suite.test('ability results are not compacted: a null-valued key survives', async () => {
  // WordPress validates every ability's output against its output_schema before
  // returning it, so the payload conforms when it leaves the site. Stripping
  // nulls here is the only thing that makes it stop conforming — and an absent
  // key and a key set to null are different facts to an agent.
  const { shapeAbilityResult } = await import('../src/utils/compact.js');

  const result = shapeAbilityResult({
    import_state:  'idle',
    progress:      null,
    import_job_id: null,
    title:         '',
    is_clean:      true,
  });

  TestAssert.isTrue('progress' in result, 'a null key must survive');
  TestAssert.isTrue('import_job_id' in result, 'a null key must survive');
  TestAssert.isTrue('title' in result, 'an explicitly empty string is a value, not noise');
  TestAssert.equal(result.import_state, 'idle');
});

// Standalone runner
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  suite.run().then((results) => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}

export default suite;
