#!/usr/bin/env node
/**
 * Stress + compatibility test for the abilities loader against the
 * Foundation 3.0.0 catalog contract (GravityKit/Foundation#158):
 *
 *   - products-filter naming: short declared prefixes (gv_*) AND
 *     full-product-slug fallback names in the same catalog
 *   - mcp_tool_name stamped into ability meta (WP core fallback path)
 *   - paginated Foundation catalog (page/per_page + X-WP-TotalPages)
 *   - collision guard: duplicates and reserved built-in names
 *   - schema normalization: object / array-properties / descriptor-array /
 *     null input_schema shapes
 *   - execution wire shapes: GET bracketed params, POST {input}, DELETE
 *
 * Pure synthetic — no live site needed. Exits non-zero on any failure.
 *
 * Usage: node scripts/stress-abilities.mjs
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  loadAbilitiesAsTools,
  normalizeInputSchema,
  methodForAbility,
  FOUNDATION_CATALOG_ROUTE,
  CORE_ABILITIES_ROUTE,
} from '../src/abilities/loader.js';

// ---------------------------------------------------------------- fixtures

const SCHEMA_VARIANTS = [
  // Proper JSON Schema object.
  (i) => ({
    type: 'object',
    properties: { id: { type: 'integer' }, [`field_${i}`]: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  }),
  // PHP-serialised empty assoc array: properties as [].
  () => ({ type: 'object', properties: [] }),
  // Top-level array of parameter descriptors.
  (i) => ([
    { name: 'view_id', type: 'integer', required: true },
    { slug: `arg_${i}`, type: 'string' },
    'garbage-entry',
  ]),
  // Missing entirely.
  () => null,
];

const ANNOTATION_VARIANTS = [
  { readonly: true },
  { destructive: true, idempotent: true },
  { destructive: true },
  {},
];

/** One Foundation catalog item (Manager::to_rest_item() shape). */
function foundationItem(i, overrides = {}) {
  const product = i % 2 === 0 ? 'gravityview' : 'gravityboard'; // gv_ declared vs full-slug fallback
  const prefix = i % 2 === 0 ? 'gv' : 'gravityboard';
  return {
    name: `gk-${product}/op-${i}`,
    label: `Op ${i}`,
    description: `Synthetic ability ${i}.`,
    category: `gk-${product}-stress`,
    input_schema: SCHEMA_VARIANTS[i % SCHEMA_VARIANTS.length](i),
    annotations: ANNOTATION_VARIANTS[i % ANNOTATION_VARIANTS.length],
    enabled: true,
    gk_product: product,
    gk_scope: 'stress',
    mcp_tool_name: `${prefix}_op_${i}`,
    ...overrides,
  };
}

/** One WP core catalog ability (meta-shaped, post-Foundation-stamping). */
function coreAbility(i, overrides = {}) {
  return {
    name: `gk-gravityview/core-op-${i}`,
    label: `Core op ${i}`,
    description: `Core synthetic ${i}.`,
    input_schema: SCHEMA_VARIANTS[i % SCHEMA_VARIANTS.length](i),
    meta: {
      gk_registered_by: 'gravitykit',
      gk_product: 'gravityview',
      mcp_tool_name: `gv_core_op_${i}`,
      annotations: ANNOTATION_VARIANTS[i % ANNOTATION_VARIANTS.length],
    },
    ...overrides,
  };
}

function buildFoundationCatalog() {
  const items = [];
  for (let i = 0; i < 1140; i++) items.push(foundationItem(i));

  // 20 disabled (defensive skip — the live catalog omits these by default).
  for (let i = 0; i < 20; i++) items.push(foundationItem(5000 + i, { enabled: false }));

  // 20 without mcp_tool_name (server owns naming — skipped with warning).
  for (let i = 0; i < 20; i++) items.push(foundationItem(6000 + i, { mcp_tool_name: '' }));

  // 10 names outside the gk- contract.
  for (let i = 0; i < 10; i++) items.push(foundationItem(7000 + i, { name: `acme/op-${i}` }));

  // 10 duplicate tool names (collide with items 0..9 — first wins).
  for (let i = 0; i < 10; i++) {
    items.push(foundationItem(8000 + i, { mcp_tool_name: foundationItem(i).mcp_tool_name }));
  }

  // 5 colliding with a reserved built-in name.
  for (let i = 0; i < 5; i++) items.push(foundationItem(9000 + i, { mcp_tool_name: 'gf_list_forms' }));

  return items;
}

// ------------------------------------------------------------- mock client

function paginate(items, perPage, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return {
    data: items.slice((page - 1) * perPage, page * perPage),
    headers: { 'x-wp-totalpages': String(totalPages) },
  };
}

/**
 * @param {object} scenario
 *   foundation: items array | 'throw'
 *   core:       abilities array | 'throw'
 */
function makeClient(scenario) {
  const log = { foundationRequests: 0, coreRequests: 0, runs: [] };
  return {
    log,
    baseUrl: 'https://stress.test',
    httpClient: {
      async request(config) {
        if (config.url === FOUNDATION_CATALOG_ROUTE) {
          log.foundationRequests++;
          if (scenario.foundation === 'throw') throw new Error('403 synthetic');
          return paginate(scenario.foundation, config.params.per_page, config.params.page);
        }
        if (config.url === CORE_ABILITIES_ROUTE) {
          log.coreRequests++;
          if (scenario.core === 'throw') throw new Error('404 synthetic');
          return { data: scenario.core, headers: {} };
        }
        if (config.url.includes('/run')) {
          log.runs.push(config);
          return { data: { ok: true } };
        }
        throw new Error(`Unexpected request: ${config.url}`);
      },
    },
  };
}

// ----------------------------------------------------------------- helpers

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(['PASS', label]);
  } catch (err) {
    results.push(['FAIL', `${label} — ${err.message}`]);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- scenarios

const catalog = buildFoundationCatalog();
const reservedNames = new Set(['gf_list_forms', 'gf_get_form']);

// A. Foundation path: filtering, collisions, pagination, schema validity.
{
  const client = makeClient({ foundation: catalog, core: [] });
  const tools = await loadAbilitiesAsTools(client, { reservedNames });

  check('A1: source is foundation-catalog', () => assert.equal(tools.source, 'foundation-catalog'));
  check('A2: exactly the 1,140 valid abilities become tools', () => assert.equal(tools.count, 1140));
  check('A3: handlers map matches definitions', () =>
    assert.equal(Object.keys(tools.handlers).length, tools.definitions.length));
  check('A4: pagination fetched all 13 pages', () => assert.equal(client.log.foundationRequests, 13));
  check('A5: reserved gf_list_forms never shadowed', () =>
    assert.equal(tools.definitions.filter((d) => d.name === 'gf_list_forms').length, 0));
  check('A6: duplicate tool names resolved first-wins (no doubles)', () => {
    const names = tools.definitions.map((d) => d.name);
    assert.equal(new Set(names).size, names.length);
  });
  check('A7: full-slug fallback names (gravityboard_*) coexist with gv_*', () => {
    assert.ok(tools.definitions.some((d) => d.name.startsWith('gravityboard_')));
    assert.ok(tools.definitions.some((d) => d.name.startsWith('gv_')));
  });
  check('A8: every inputSchema is MCP-valid (object type + plain-object properties)', () => {
    for (const d of tools.definitions) {
      assert.equal(d.inputSchema.type, 'object', d.name);
      assert.ok(isPlainObject(d.inputSchema.properties), `${d.name} properties`);
    }
  });
  check('A9: descriptor-array schemas gained derived required list', () => {
    const sample = tools.definitions.find((d) => d.inputSchema.properties.view_id);
    assert.ok(sample, 'no descriptor-array tool found');
    assert.deepEqual(sample.inputSchema.required, ['view_id']);
  });

  // B. Execution wire shapes through real handlers.
  const byName = Object.fromEntries(tools.definitions.map((d) => [d.name, d]));
  const readonlyName = catalog.find((c) => c.annotations.readonly && byName[c.mcp_tool_name])?.mcp_tool_name;
  const deleteName = catalog.find((c) => c.annotations.destructive && c.annotations.idempotent && byName[c.mcp_tool_name])?.mcp_tool_name;
  const postName = catalog.find((c) => !c.annotations.readonly && !c.annotations.idempotent && byName[c.mcp_tool_name])?.mcp_tool_name;

  await tools.handlers[readonlyName]({ view: { id: 7, fields: ['a', 'b'] } });
  await tools.handlers[postName]({ title: 'Stress' });
  await tools.handlers[deleteName]({ id: 9 });

  const [getRun, postRun, deleteRun] = client.log.runs;
  check('B1: readonly handler issues GET with bracketed nested params', () => {
    assert.equal(getRun.method, 'GET');
    assert.equal(getRun.params['input[view][id]'], 7);
    assert.equal(getRun.params['input[view][fields][0]'], 'a');
  });
  check('B2: default handler issues POST with {input} body', () => {
    assert.equal(postRun.method, 'POST');
    assert.deepEqual(postRun.data, { input: { title: 'Stress' } });
  });
  check('B3: destructive+idempotent handler issues DELETE', () =>
    assert.equal(deleteRun.method, 'DELETE'));

  // Throughput: sequential + concurrent handler execution.
  const seqStart = performance.now();
  for (let i = 0; i < 5000; i++) await tools.handlers[postName]({ i });
  const seqMs = performance.now() - seqStart;

  const conStart = performance.now();
  await Promise.all(Array.from({ length: 2000 }, (_, i) => tools.handlers[readonlyName]({ i })));
  const conMs = performance.now() - conStart;

  results.push(['INFO', `B4: 5,000 sequential handler calls in ${seqMs.toFixed(0)}ms (${Math.round(5000 / (seqMs / 1000)).toLocaleString()}/s)`]);
  results.push(['INFO', `B5: 2,000 concurrent handler calls in ${conMs.toFixed(0)}ms`]);
}

// C. Repeated full loads (timing + stability).
{
  const ITERATIONS = 25;
  const times = [];
  const rssBefore = process.memoryUsage().rss;
  for (let i = 0; i < ITERATIONS; i++) {
    const client = makeClient({ foundation: catalog, core: [] });
    const start = performance.now();
    const tools = await loadAbilitiesAsTools(client, { reservedNames });
    times.push(performance.now() - start);
    assert.equal(tools.count, 1140);
  }
  const rssAfter = process.memoryUsage().rss;
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  results.push(['INFO',
    `C1: ${ITERATIONS} full loads of 1,205-item catalog — avg ${avg.toFixed(1)}ms, ` +
    `min ${Math.min(...times).toFixed(1)}ms, max ${Math.max(...times).toFixed(1)}ms, ` +
    `RSS +${((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)}MB`]);
  check('C2: load stays under 250ms avg for 1,205 items', () => assert.ok(avg < 250, `${avg.toFixed(1)}ms`));
}

// D. WP core fallback (Foundation 403) reads stamped meta.mcp_tool_name.
{
  const core = [];
  for (let i = 0; i < 600; i++) core.push(coreAbility(i));
  for (let i = 0; i < 50; i++) core.push(coreAbility(9000 + i, { meta: { some_other_plugin: true } }));
  for (let i = 0; i < 10; i++) {
    core.push(coreAbility(9500 + i, { meta: { gk_registered_by: 'gravitykit' } })); // no mcp_tool_name
  }

  const client = makeClient({ foundation: 'throw', core });
  const tools = await loadAbilitiesAsTools(client, { reservedNames });

  check('D1: falls back to wp-core source', () => assert.equal(tools.source, 'wp-core'));
  check('D2: foreign + unnamed abilities filtered; 600 stamped survive', () => assert.equal(tools.count, 600));
  check('D3: core-path names come from stamped meta.mcp_tool_name', () =>
    assert.ok(tools.definitions.every((d) => d.name.startsWith('gv_core_op_'))));
}

// E. Empty world: both catalogs unusable → throws (self-heal contract).
{
  const client = makeClient({ foundation: [], core: [] });
  let threw = false;
  try {
    await loadAbilitiesAsTools(client, { reservedNames });
  } catch {
    threw = true;
  }
  check('E1: empty Foundation catalog + empty core throws for self-heal retry', () => assert.ok(threw));
}

// F. Unit edges already covered elsewhere, asserted here as a canary.
check('F1: methodForAbility contract', () => {
  assert.equal(methodForAbility({ readonly: true }), 'GET');
  assert.equal(methodForAbility({ destructive: true, idempotent: true }), 'DELETE');
  assert.equal(methodForAbility({ destructive: true }), 'POST');
  assert.equal(methodForAbility(), 'POST');
});
check('F2: normalizeInputSchema never returns array properties', () => {
  for (const variant of [null, [], [{ name: 'x' }], { type: 'object', properties: [] }, 'junk', 42]) {
    const out = normalizeInputSchema(variant);
    assert.equal(out.type, 'object');
    assert.ok(isPlainObject(out.properties));
  }
});

// ------------------------------------------------------------------ report

const failed = results.filter(([s]) => s === 'FAIL');
console.log('\n=== abilities loader stress test ===');
for (const [status, label] of results) console.log(`${status.padEnd(5)} ${label}`);
console.log(`\n${results.filter(([s]) => s === 'PASS').length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
