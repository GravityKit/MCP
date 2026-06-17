/**
 * Unit tests for server-runtime helpers (two-plane init, tool list assembly,
 * ability-call routing).
 */

import test from 'node:test';
import assert from 'node:assert';
import { runPlaneInit, buildToolList, classifyAbilityCall, resolveAbilitiesListTimeoutMs } from '../src/server-runtime.js';

// --- runPlaneInit (#1: WP not blocked by a slow GF probe) ---

test('runPlaneInit: WP plane initializes before a slow GF probe resolves', async () => {
  let gfResolved = false;
  let gfResolvedWhenWpRan = null;
  const initGravityFormsPlane = () => new Promise((r) => setTimeout(() => { gfResolved = true; r(true); }, 30));
  const initWordPressPlane = () => { gfResolvedWhenWpRan = gfResolved; return true; };
  await runPlaneInit({ initGravityFormsPlane, initWordPressPlane });
  assert.equal(gfResolvedWhenWpRan, false, 'WP plane must run before the GF probe resolves');
});

test('runPlaneInit: throws when neither plane is usable', async () => {
  await assert.rejects(
    runPlaneInit({ initGravityFormsPlane: async () => false, initWordPressPlane: () => false }),
    /Neither/
  );
});

test('runPlaneInit: returns each plane status', async () => {
  const r = await runPlaneInit({ initGravityFormsPlane: async () => true, initWordPressPlane: () => false });
  assert.deepEqual(r, { gfOk: true, wpOk: false });
});

// --- buildToolList (#2: GF tools only when the plane is live) ---

const defs = {
  gfToolDefs: [{ name: 'gf_list_forms' }],
  fieldOpTools: [{ name: 'gf_add_field' }],
  abilityDefs: [{ name: 'gv_view_create' }],
  gkReloadDef: { name: 'gk_reload_abilities' },
};

test('buildToolList: omits GF + field-op tools when the GF plane is not ready', () => {
  const names = buildToolList({ gfReady: false, ...defs }).map((t) => t.name);
  assert.ok(!names.includes('gf_list_forms'), 'gf tools excluded');
  assert.ok(!names.includes('gf_add_field'), 'field-op tools excluded');
  assert.ok(names.includes('gv_view_create'), 'ability tools present');
  assert.ok(names.includes('gk_reload_abilities'), 'reload tool present');
});

test('buildToolList: includes everything when the GF plane is ready', () => {
  const names = buildToolList({ gfReady: true, ...defs }).map((t) => t.name).sort();
  assert.deepEqual(names, ['gf_add_field', 'gf_list_forms', 'gk_reload_abilities', 'gv_view_create']);
});

test('buildToolList: reload tool present, no crash on missing abilities', () => {
  const names = buildToolList({ gfReady: false, gkReloadDef: defs.gkReloadDef, abilityDefs: null }).map((t) => t.name);
  assert.deepEqual(names, ['gk_reload_abilities']);
});

// --- classifyAbilityCall (#3: route by handler-map membership, any prefix) ---

test('classifyAbilityCall: dispatches any product-prefixed tool in the handler map', () => {
  assert.equal(classifyAbilityCall({ name: 'gv_view_create', hasWpClient: true, handlers: { gv_view_create() {} } }), 'dispatch');
  assert.equal(classifyAbilityCall({ name: 'gc_chart_create', hasWpClient: true, handlers: { gc_chart_create() {} } }), 'dispatch');
});

test('classifyAbilityCall: unknown when not in a loaded handler map', () => {
  assert.equal(classifyAbilityCall({ name: 'gv_nope', hasWpClient: true, handlers: { gv_view_create() {} } }), 'unknown');
});

test('classifyAbilityCall: no-wp-client when WP client is absent (any prefix)', () => {
  assert.equal(classifyAbilityCall({ name: 'gv_view_create', hasWpClient: false, handlers: null }), 'no-wp-client');
  assert.equal(classifyAbilityCall({ name: 'gc_chart_create', hasWpClient: false, handlers: null }), 'no-wp-client');
});

test('classifyAbilityCall: catalog-unreachable when WP is up but catalog not loaded (any prefix)', () => {
  assert.equal(classifyAbilityCall({ name: 'gv_view_create', hasWpClient: true, handlers: null }), 'catalog-unreachable');
  assert.equal(classifyAbilityCall({ name: 'gc_chart_create', hasWpClient: true, handlers: null }), 'catalog-unreachable');
});

// --- resolveAbilitiesListTimeoutMs (how long tools/list waits for the catalog) ---

test('resolveAbilitiesListTimeoutMs: defaults to 2000 when unset', () => {
  assert.equal(resolveAbilitiesListTimeoutMs({}), 2000);
});

test('resolveAbilitiesListTimeoutMs: honors a valid override (e.g. a one-shot client needing the full catalog)', () => {
  assert.equal(resolveAbilitiesListTimeoutMs({ GRAVITYKIT_MCP_LIST_TIMEOUT_MS: '15000' }), 15000);
});

test('resolveAbilitiesListTimeoutMs: ignores non-positive / non-numeric values', () => {
  assert.equal(resolveAbilitiesListTimeoutMs({ GRAVITYKIT_MCP_LIST_TIMEOUT_MS: '0' }), 2000);
  assert.equal(resolveAbilitiesListTimeoutMs({ GRAVITYKIT_MCP_LIST_TIMEOUT_MS: '-5' }), 2000);
  assert.equal(resolveAbilitiesListTimeoutMs({ GRAVITYKIT_MCP_LIST_TIMEOUT_MS: 'abc' }), 2000);
});
