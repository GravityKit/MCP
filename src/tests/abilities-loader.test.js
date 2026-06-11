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
} from '../abilities/loader.js';

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
    reservedNames: new Set(['gf_list_forms', 'gv_reload_abilities']),
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

// Standalone runner
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  suite.run().then((results) => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}

export default suite;
