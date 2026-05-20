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
  abilityNameToToolName,
  methodForAbility,
} from '../view-operations/abilities-loader.js';

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

/** Stub gvClient — only `httpClient.request` and `baseUrl` are exercised. */
function buildStubGvClient(catalog) {
  return {
    baseUrl: 'https://test.invalid',
    httpClient: {
      request: async () => ({ data: catalog }),
    },
  };
}

/** Synthetic catalog covering the three failure modes + a healthy ability. */
function syntheticCatalog() {
  return [
    // Healthy reference — must round-trip untouched.
    {
      name: 'gk-gravityview/list-layouts',
      description: 'List installed layouts',
      input_schema: { type: 'object', properties: { compact: { type: 'boolean' } } },
      meta: { annotations: { readonly: true } },
    },
    // Bug shape #1 — input_schema is itself an array (tools 29-36).
    {
      name: 'gk-gravityview/add-view-field',
      description: 'Add a field to a View',
      input_schema: [
        { name: 'view_id', type: 'integer', required: true },
        { name: 'field_id', type: 'string', required: true },
      ],
      meta: { annotations: {} },
    },
    // Bug shape #2 — properties is an array (tool 57).
    {
      name: 'gk-multiple-forms/list-joins',
      description: 'List joins',
      input_schema: { type: 'object', properties: [] },
      meta: { annotations: { readonly: true } },
    },
    // Outside our namespaces — must be filtered out.
    {
      name: 'core/unrelated-ability',
      description: 'Should not be exposed',
      input_schema: { type: 'object', properties: {} },
      meta: { annotations: {} },
    },
  ];
}

suite.test('loadAbilitiesAsTools: filters to gk-gravityview/* + gk-multiple-forms/*', async () => {
  const { definitions, count } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  TestAssert.equal(count, 3, 'expected 3 in-namespace abilities, got ' + count);
  TestAssert.equal(definitions.length, 3, 'definitions count must match');
  const names = definitions.map((d) => d.name).sort();
  TestAssert.deepEqual(names, ['gv_add_view_field', 'gv_list_joins', 'gv_list_layouts']);
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
  const tool = definitions.find((d) => d.name === 'gv_add_view_field');
  TestAssert.isTrue(!!tool, 'gv_add_view_field must exist');
  assertValidMcpInputSchema(tool.inputSchema);
  TestAssert.isTrue('view_id' in tool.inputSchema.properties);
  TestAssert.isTrue('field_id' in tool.inputSchema.properties);
  TestAssert.deepEqual(tool.inputSchema.required.sort(), ['field_id', 'view_id']);
});

suite.test('loadAbilitiesAsTools: tool 57 repro — properties:[] becomes properties:{}', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gv_list_joins');
  TestAssert.isTrue(!!tool, 'gv_list_joins must exist');
  assertValidMcpInputSchema(tool.inputSchema);
  TestAssert.deepEqual(tool.inputSchema.properties, {});
});

suite.test('loadAbilitiesAsTools: healthy schema passes through untouched', async () => {
  const { definitions } = await loadAbilitiesAsTools(buildStubGvClient(syntheticCatalog()));
  const tool = definitions.find((d) => d.name === 'gv_list_layouts');
  TestAssert.isTrue(!!tool);
  TestAssert.deepEqual(tool.inputSchema.properties, { compact: { type: 'boolean' } });
});

// ---------------------------------------------------------------------------
// Lightweight smoke for the existing helpers — these have no tests yet and
// regressions here would silently mis-route every gv_* call.
// ---------------------------------------------------------------------------

suite.test('abilityNameToToolName: strips namespace, kebab → snake', () => {
  TestAssert.equal(abilityNameToToolName('gk-gravityview/list-layouts'), 'gv_list_layouts');
  TestAssert.equal(abilityNameToToolName('gk-multiple-forms/list-joins'), 'gv_list_joins');
  TestAssert.equal(abilityNameToToolName('gk-gravityview/apply-view-config'), 'gv_apply_view_config');
});

suite.test('methodForAbility: readonly → GET, destructive → DELETE, else POST', () => {
  TestAssert.equal(methodForAbility({ readonly: true }), 'GET');
  TestAssert.equal(methodForAbility({ destructive: true }), 'DELETE');
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
