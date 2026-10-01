/**
 * Server-owned parameters must never reach Gravity Forms.
 *
 * `compact` and `test_mode` belong to this server, and the id aliases (`entry_id`
 * for `id`, `id` for `form_id`) are spellings the validators resolve. Every
 * validator that spreads its input forwards what it does not delete, so each leak
 * so far was one validator forgetting one key: `compact` persisted into a saved
 * form's display_meta, and `entry_id` rode a PUT body. That second one is worse
 * than a stray key. WordPress resolves `$request['entry_id']` from the JSON body
 * BEFORE the URL (WP_REST_Request::get_parameter_order), and GF's entries
 * controller does `$entry['id'] = $request['entry_id']` (prepare_item_for_database),
 * so a body entry_id that differed from the URL id would have updated a different
 * entry.
 *
 * The tool list is derived from the registered definitions, not written out here:
 * a hardcoded list is how the gap existed. A write tool with no fixture below fails
 * the suite until it gets one.
 *
 * `replace` is sent only to tools whose schema declares it (gf_update_form,
 * gf_update_feed): on a tool that does not, an unknown key is meant to pass through,
 * since entry meta is per-site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { BaseValidator } from '../src/config/validation.js';
import { stripControlParams } from '../src/server-runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

// src/index.js starts the stdio server on import, so read the tool array as text.
function getToolDefinitions() {
  const start = source.indexOf('const GF_TOOL_DEFINITIONS = ');
  const end = source.indexOf('\n];', start);
  assert.ok(start !== -1 && end !== -1, 'GF_TOOL_DEFINITIONS literal not found');
  return Function(`"use strict"; return (${source.slice(start + 'const GF_TOOL_DEFINITIONS = '.length, end + 2)});`)();
}

const DEFINITIONS = getToolDefinitions();

// Tools that POST although they are annotated read-only: they validate without storing.
const POSTS_BUT_READ_ONLY = ['gf_validate_form', 'gf_validate_submission'];

const WRITE_TOOLS = DEFINITIONS
  .filter((tool) => !tool.annotations?.readOnlyHint || POSTS_BUT_READ_ONLY.includes(tool.name))
  .map((tool) => tool.name);

const clientMethodFor = (toolName) => toolName.replace(/^gf_/, '').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

const SERVER_OWNED = { compact: false, test_mode: true };

/**
 * One call per write tool, spelled with the alias where the tool has one.
 * `aliasKeys` are the spellings that must not appear on the wire body. `replace`
 * is the value to send where the tool declares that parameter: it is a real
 * argument there (names of properties allowed to drop stored keys) and is refused
 * if it names a property the call does not send, so it must name one that is sent.
 */
const FIXTURES = {
  gf_create_form: { input: { title: 'T' }, aliasKeys: [] },
  gf_update_form: { input: { form_id: 1, title: 'T2' }, aliasKeys: ['form_id'], replace: ['title'] },
  gf_delete_form: { input: { form_id: 1 }, aliasKeys: [] },
  gf_validate_form: { input: { id: 1, input_1: 'x' }, aliasKeys: ['id', 'form_id'] },
  gf_create_entry: { input: { form_id: 1, '1': 'x' }, aliasKeys: [] },
  gf_update_entry: { input: { entry_id: 50, '1': 'y' }, aliasKeys: ['entry_id'] },
  gf_delete_entry: { input: { entry_id: 50 }, aliasKeys: [] },
  gf_submit_form_data: { input: { id: 1, input_1: 'x' }, aliasKeys: ['id', 'form_id'] },
  gf_validate_submission: { input: { id: 1, input_1: 'x' }, aliasKeys: ['id', 'form_id'] },
  gf_send_notifications: { input: { entry_id: 50 }, aliasKeys: ['entry_id'] },
  gf_create_feed: { input: { addon_slug: 'x', form_id: 1, meta: { a: 1 } }, aliasKeys: [] },
  gf_update_feed: { input: { id: 5, meta: { a: 1 } }, aliasKeys: [], replace: ['meta'] },
  gf_patch_feed: { input: { id: 5, meta: { a: 1 } }, aliasKeys: [] },
  gf_delete_feed: { input: { id: 5 }, aliasKeys: [] }
};

const FORM = { id: 1, title: 'T', fields: [{ id: 1, type: 'text' }], confirmations: {}, notifications: {}, is_active: '1' };
const ENTRY = { id: 50, form_id: 1, '1': 'x', status: 'active' };
const FEED = { id: 5, form_id: 1, addon_slug: 'x', meta: { a: 1 }, is_active: true };

/** Answers any route a write tool reads or writes, and records every request. */
function makeClient() {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass',
    GRAVITY_FORMS_ALLOW_DELETE: 'true'
  });
  const requests = [];
  const respond = (method, path, body) => {
    if (path === '/forms' && method === 'POST') return { ...FORM, id: 2 };
    if (/^\/forms\/\d+$/.test(path)) return method === 'GET' ? FORM : (body || {});
    if (/\/submissions(\/validation)?$/.test(path)) return { is_valid: true, entry_id: 9 };
    if (path === '/entries' && method === 'POST') return { ...ENTRY, ...body, id: 50 };
    if (/^\/entries\/\d+\/notifications$/.test(path)) return ['n1'];
    if (/^\/entries\/\d+$/.test(path)) return method === 'PUT' ? { ...ENTRY, ...body } : ENTRY;
    if (path === '/feeds' && method === 'POST') return { ...FEED };
    if (/^\/feeds\/\d+$/.test(path)) return method === 'GET' ? FEED : { ...FEED, ...(body || {}) };
    throw new Error(`unrouted ${method} ${path}`);
  };
  const answer = (method) => async (path, dataOrConfig, config) => {
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const body = hasBody ? dataOrConfig : undefined;
    const params = (hasBody ? config : dataOrConfig)?.params;
    requests.push({ method, path, body, params });
    return { data: respond(method, path, body), headers: {} };
  };
  client.httpClient.get = answer('GET');
  client.httpClient.post = answer('POST');
  client.httpClient.put = answer('PUT');
  client.httpClient.patch = answer('PATCH');
  client.httpClient.delete = answer('DELETE');
  return { client, requests };
}

/** What src/index.js does with a tool call before the client sees it. */
const dispatch = (client, toolName, params) => client[clientMethodFor(toolName)](stripControlParams(params));

// --- the unit ---------------------------------------------------------------

test('takeIdAlias resolves the id, deletes both spellings, and sets the canonical key', () => {
  for (const [given, preferred, other, canonical] of [
    [{ entry_id: 7, '1': 'a' }, 'id', 'entry_id', 'id'],
    [{ id: 7, '1': 'a' }, 'id', 'entry_id', 'id'],
    [{ id: 7, entry_id: 7, '1': 'a' }, 'id', 'entry_id', 'id'],
    [{ id: 7, '1': 'a' }, 'form_id', 'id', 'form_id']
  ]) {
    const validated = { ...given };
    const resolved = BaseValidator.takeIdAlias(validated, canonical, preferred, other);

    assert.equal(resolved, 7);
    assert.equal(validated[canonical], 7);
    const stray = [preferred, other].filter((name) => name !== canonical);
    stray.forEach((name) => assert.ok(!(name in validated), `${name} must be gone after resolving`));
    assert.equal(validated['1'], 'a', 'everything else is untouched');
  }
});

test('takeIdAlias keeps resolveIdAlias\'s refusals: disagreement, missing, invalid', () => {
  assert.throws(() => BaseValidator.takeIdAlias({ id: 1, entry_id: 2 }, 'id', 'id', 'entry_id'), /disagree/);
  assert.throws(() => BaseValidator.takeIdAlias({}, 'id', 'id', 'entry_id'), /id is required/);
  assert.throws(() => BaseValidator.takeIdAlias({ entry_id: 0 }, 'id', 'id', 'entry_id'), /positive integer/);
});

// --- every write tool ---------------------------------------------------------

test('every write tool has a fixture, and every fixture is a registered tool', () => {
  assert.ok(WRITE_TOOLS.length >= 10, `derived only ${WRITE_TOOLS.length} write tools: the derivation is broken`);
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...WRITE_TOOLS].sort(),
    'add a fixture for a new write tool (or remove the stale one)');
});

for (const toolName of WRITE_TOOLS) {
  test(`${toolName}: no server-owned parameter or alias reaches the wire`, async () => {
    const { input, aliasKeys, replace } = FIXTURES[toolName];
    const { client, requests } = makeClient();
    const declaresReplace = Boolean(DEFINITIONS.find((tool) => tool.name === toolName).inputSchema.properties?.replace);
    if (declaresReplace) {
      assert.ok(Array.isArray(replace), `${toolName} declares replace: give its fixture a replace value`);
    }
    const sent = { ...input, compact: SERVER_OWNED.compact, test_mode: SERVER_OWNED.test_mode, ...(declaresReplace ? { replace } : {}) };

    await dispatch(client, toolName, sent);

    const mutating = requests.filter((request) => request.method !== 'GET');
    assert.ok(mutating.length > 0, `${toolName} sent no mutating request: the fixture exercises nothing`);

    const forbidden = ['compact', 'test_mode', ...(declaresReplace ? ['replace'] : []), ...aliasKeys];
    for (const request of requests) {
      for (const name of forbidden) {
        assert.ok(!(request.body && name in request.body), `${toolName}: ${request.method} ${request.path} body carries "${name}"`);
        assert.ok(!(request.params && name in request.params), `${toolName}: ${request.method} ${request.path} query carries "${name}"`);
      }
    }
  });
}

// --- the dispatcher -----------------------------------------------------------

test('the dispatcher strips control params once, and hands every gf_* write tool the stripped input', () => {
  assert.match(source, /const input = stripControlParams\(params\);/, 'control params are stripped before routing');

  for (const toolName of WRITE_TOOLS) {
    const caseAt = source.indexOf(`case '${toolName}':`);
    assert.ok(caseAt !== -1, `no dispatch case for ${toolName}`);
    const next = source.indexOf('\n    case ', caseAt + 1);
    const block = source.slice(caseAt, next === -1 ? caseAt + 400 : next);
    const method = clientMethodFor(toolName);

    assert.match(block, new RegExp(`gravityFormsClient\\.${method}\\(input\\)`), `${toolName} must pass the stripped input to ${method}`);
    assert.doesNotMatch(block, new RegExp(`gravityFormsClient\\.${method}\\(params\\)`), `${toolName} must not pass raw params`);
  }
});
