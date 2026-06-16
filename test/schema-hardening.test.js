/**
 * Schema hardening tests for the tool advertisement layer.
 *
 * These assert the advertised inputSchema for the static Gravity Forms tools
 * in GF_TOOL_DEFINITIONS (src/index.js) matches what Gravity Forms 2.10.3
 * actually honors server-side. Verified against the real GF source:
 *   - /forms get_items() reads ONLY $request['include'] (class-controller-forms.php:88);
 *     get_collection_params() declares only page/per_page/search. status/active/exclude
 *     are no-ops → must NOT be advertised.
 *   - GFAPI::get_entries accepts sorting.is_numeric (includes/api.php:621,1484) and
 *     paging.offset (includes/api.php:604,712) → must be advertised.
 *
 * src/index.js calls main() on import (starts the stdio server), so importing it
 * has side effects. Instead we read the file text and evaluate ONLY the
 * GF_TOOL_DEFINITIONS array literal (pure object literals, no runtime calls) in an
 * isolated function scope. No runtime modification required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'src', 'index.js');

/**
 * Extract the `const GF_TOOL_DEFINITIONS = [ ... ];` array literal from the source
 * text and evaluate it in isolation. The array is a pure literal (object literals
 * only — no function references or spreads), so evaluating it is side-effect free.
 */
function loadToolDefinitions() {
  const source = readFileSync(INDEX_PATH, 'utf8');
  const marker = 'const GF_TOOL_DEFINITIONS = ';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'GF_TOOL_DEFINITIONS declaration not found in src/index.js');

  // Walk from the opening `[` to its matching `]` (bracket-balanced, skipping
  // string/comment contents) so we capture exactly the array literal.
  const arrayStart = source.indexOf('[', start + marker.length);
  assert.notEqual(arrayStart, -1, 'GF_TOOL_DEFINITIONS array opening bracket not found');

  let depth = 0;
  let inString = null; // quote char when inside a string
  let inLineComment = false;
  let inBlockComment = false;
  let arrayEnd = -1;

  for (let i = arrayStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }

  assert.notEqual(arrayEnd, -1, 'GF_TOOL_DEFINITIONS array closing bracket not found');

  const literal = source.slice(arrayStart, arrayEnd + 1);
  // eslint-disable-next-line no-new-func
  const definitions = Function(`"use strict"; return (${literal});`)();
  assert.ok(Array.isArray(definitions), 'GF_TOOL_DEFINITIONS did not evaluate to an array');
  return definitions;
}

function findTool(definitions, name) {
  const tool = definitions.find((t) => t && t.name === name);
  assert.ok(tool, `tool ${name} not found in GF_TOOL_DEFINITIONS`);
  return tool;
}

test('GF_TOOL_DEFINITIONS evaluates and contains the static GF tools', () => {
  const defs = loadToolDefinitions();
  assert.ok(defs.length > 0, 'expected at least one tool definition');
  for (const name of ['gf_list_forms', 'gf_list_entries', 'gf_send_notifications']) {
    findTool(defs, name);
  }
});

test('gf_list_forms advertises ONLY include (no status/active/exclude) per SHARED FORMS CONTRACT', () => {
  const defs = loadToolDefinitions();
  const tool = findTool(defs, 'gf_list_forms');
  const props = tool.inputSchema.properties;

  // Must keep include — the only param GF /forms honors server-side.
  assert.ok('include' in props, 'gf_list_forms must advertise include');

  // Must NOT advertise params GF ignores.
  assert.ok(!('status' in props), 'gf_list_forms must NOT advertise status (GF ignores it)');
  assert.ok(!('active' in props), 'gf_list_forms must NOT advertise active (GF ignores it)');
  assert.ok(!('exclude' in props), 'gf_list_forms must NOT advertise exclude (GF ignores it)');
});

test('gf_list_entries advertises sorting.is_numeric (boolean) — a real GFAPI param', () => {
  const defs = loadToolDefinitions();
  const tool = findTool(defs, 'gf_list_entries');
  const sorting = tool.inputSchema.properties.sorting;
  assert.ok(sorting && sorting.properties, 'gf_list_entries must have a sorting object schema');
  assert.ok('is_numeric' in sorting.properties, 'sorting must advertise is_numeric');
  assert.equal(sorting.properties.is_numeric.type, 'boolean', 'is_numeric must be a boolean');
  // Pre-existing sorting props must remain.
  assert.ok('key' in sorting.properties, 'sorting must still advertise key');
  assert.ok('direction' in sorting.properties, 'sorting must still advertise direction');
});

test('gf_list_entries advertises paging.offset (integer) alongside page_size/current_page', () => {
  const defs = loadToolDefinitions();
  const tool = findTool(defs, 'gf_list_entries');
  const paging = tool.inputSchema.properties.paging;
  assert.ok(paging && paging.properties, 'gf_list_entries must have a paging object schema');
  assert.ok('offset' in paging.properties, 'paging must advertise offset');
  assert.equal(paging.properties.offset.type, 'integer', 'offset must be an integer');
  // Pre-existing paging props must remain.
  assert.ok('page_size' in paging.properties, 'paging must still advertise page_size');
  assert.ok('current_page' in paging.properties, 'paging must still advertise current_page');
});

test('gf_send_notifications keeps entry_id/notification_ids/event; notification_ids items note non-empty ids', () => {
  const defs = loadToolDefinitions();
  const tool = findTool(defs, 'gf_send_notifications');
  const props = tool.inputSchema.properties;
  assert.ok('entry_id' in props, 'gf_send_notifications must advertise entry_id');
  assert.ok('notification_ids' in props, 'gf_send_notifications must advertise notification_ids');
  assert.ok('event' in props, 'gf_send_notifications must advertise event');

  const items = props.notification_ids.items;
  assert.ok(items, 'notification_ids must declare items');
  assert.equal(items.type, 'string', 'notification_ids items must be strings');
  assert.match(
    String(items.description || ''),
    /non-empty/i,
    'notification_ids items description must note ids must be non-empty'
  );
});
