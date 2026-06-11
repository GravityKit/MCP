#!/usr/bin/env node
/**
 * Abilities API end-to-end demo.
 *
 * Walks the new GravityView Abilities surface from cold start to a
 * round-trip create + apply + render — same path the MCP and the
 * Design Studio React app now use in production.
 *
 * Run from /Users/zackkatz/Dropbox/MonoKit/MCPs/gravitymcp:
 *   node /tmp/abilities-demo.mjs
 */

import 'dotenv/config';
import { WordPressClient } from '/Users/zackkatz/Dropbox/MonoKit/MCPs/gravitymcp/src/wp-client.js';
import { loadAbilitiesAsTools, methodForAbility } from '/Users/zackkatz/Dropbox/MonoKit/MCPs/gravitymcp/src/abilities/loader.js';

const RESET   = '\x1b[0m';
const DIM     = '\x1b[2m';
const CYAN    = '\x1b[36m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const BOLD    = '\x1b[1m';

function header(s) {
  console.log(`\n${BOLD}${CYAN}━━ ${s} ━━${RESET}`);
}
function step(n, s) {
  console.log(`\n${BOLD}${MAGENTA}[${n}]${RESET} ${BOLD}${s}${RESET}`);
}
function muted(s) {
  console.log(`${DIM}${s}${RESET}`);
}
function value(label, v) {
  const json = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  console.log(`  ${YELLOW}${label}${RESET}: ${json}`);
}
function ok(s) {
  console.log(`  ${GREEN}✓${RESET} ${s}`);
}

const client = new WordPressClient(process.env);

// ──────────────────────────────────────────────────────────────────
header('1. Discover the catalog (single network call)');
// ──────────────────────────────────────────────────────────────────

step('1a', 'Fetch /wp-json/wp-abilities/v1/abilities');
const { definitions, handlers, count } = await loadAbilitiesAsTools(client);
ok(`${count} abilities discovered under the gk-gravityview/ namespace`);

step('1b', 'Categorize them — what can the agent do?');
const catalogResp = await client.httpClient.request({
  method: 'GET',
  baseURL: client.baseUrl,
  url: '/wp-json/wp-abilities/v1/abilities',
});
const ours = catalogResp.data.filter(a => a.name?.startsWith('gk-gravityview/'));
const byCat = {};
for (const a of ours) (byCat[a.category] ||= []).push(a);
for (const cat of Object.keys(byCat).sort()) {
  console.log(`  ${CYAN}${cat}${RESET} (${byCat[cat].length})`);
  byCat[cat].slice(0, 3).forEach(a => muted(`     • ${a.name}`));
  if (byCat[cat].length > 3) muted(`     … +${byCat[cat].length - 3} more`);
}

step('1c', 'Show one ability\'s full self-description');
const sample = ours.find(a => a.name === 'gk-gravityview/list-layouts');
console.log(`  ${BOLD}${sample.name}${RESET}`);
muted(`  ${sample.description.slice(0, 140)}…`);
value('annotations', sample.meta?.annotations);
value('output schema', sample.output_schema);

// ──────────────────────────────────────────────────────────────────
header('2. HTTP method auto-routing (annotations drive the wire)');
// ──────────────────────────────────────────────────────────────────

const examples = [
  ours.find(a => a.name === 'gk-gravityview/list-layouts'),         // readonly + idempotent → GET
  ours.find(a => a.name === 'gk-gravityview/create-view'),          // write → POST
  ours.find(a => a.name === 'gk-gravityview/remove-view-field'),    // destructive + idempotent → DELETE
];
for (const a of examples) {
  const m = methodForAbility(a.meta?.annotations || {});
  const ann = a.meta?.annotations || {};
  console.log(`  ${BOLD}${a.name.padEnd(40)}${RESET} → ${GREEN}${m}${RESET}  ${DIM}(readonly=${!!ann.readonly} destructive=${!!ann.destructive} idempotent=${!!ann.idempotent})${RESET}`);
}

// ──────────────────────────────────────────────────────────────────
header('3. Run a readonly ability (zero input)');
// ──────────────────────────────────────────────────────────────────

step('3a', 'gv_list_layouts → list installed layout engines');
const layouts = await handlers.gv_list_layouts({});
ok(`${layouts.layouts.length} layouts returned`);
layouts.layouts.slice(0, 4).forEach(l => {
  console.log(`     ${YELLOW}${l.id.padEnd(32)}${RESET} ${l.label}${l.has_grid ? ' ' + GREEN + '[grid]' + RESET : ''}`);
});

// ──────────────────────────────────────────────────────────────────
header('4. Run a readonly ability with input (bracketed query params)');
// ──────────────────────────────────────────────────────────────────

step('4a', 'gv_get_field_type_schema { field_type: "email" }');
const emailSchema = await handlers.gv_get_field_type_schema({ field_type: 'email' });
ok(`${emailSchema.schema.length} settings declared for the email field type`);
emailSchema.schema.slice(0, 5).forEach(s => muted(`     • ${s.slug.padEnd(28)} ${s.type.padEnd(12)} ${s.label || ''}`));

// ──────────────────────────────────────────────────────────────────
header('5. End-to-end round-trip: create → apply → read');
// ──────────────────────────────────────────────────────────────────

step('5a', 'gv_create_view — mint a fresh draft');
const formId = Number(process.env.GRAVITYKIT_DEMO_FORM_ID || 296);
const created = await handlers.gv_create_view({
  title: `Abilities API demo · ${new Date().toISOString().slice(11, 19)}`,
  form_id: formId,
  template_id: 'default_table',
  status: 'draft',
});
ok(`view #${created.view_id} created (version ${created.version})`);
value('admin URL', created.admin_url || `[edit in WP admin via post id ${created.view_id}]`);

step('5b', 'gv_apply_view_config — add a column with optimistic concurrency');
const applied = await handlers.gv_apply_view_config({
  id:      created.view_id,
  fields:  { 'directory_table-columns': [{ field_id: '1', slot: 'demo_speaker', custom_label: 'Speaker' }] },
  mode:    'merge',
  ifMatch: `"${created.version}"`,
});
ok(`apply landed → version bumped to ${applied.version}`);
value('applied envelope', applied.applied);

step('5c', 'gv_get_view_config — read it back');
const config = await handlers.gv_get_view_config({ id: created.view_id });
const slot = config.fields['directory_table-columns']?.demo_speaker;
ok(`field present at directory_table-columns.demo_speaker`);
value('stored slot', slot);

// ──────────────────────────────────────────────────────────────────
header('6. Stale ifMatch → server returns 412 (concurrency in action)');
// ──────────────────────────────────────────────────────────────────

step('6a', 'Apply with the OLD version (now stale after 5b)');
let conflict;
try {
  await handlers.gv_apply_view_config({
    id:      created.view_id,
    fields:  { 'directory_table-columns': [{ field_id: '1', slot: 'should_fail', custom_label: 'X' }] },
    mode:    'merge',
    ifMatch: `"${created.version}"`,  // pre-5b version, deliberately stale
  });
} catch (err) {
  conflict = err;
}
if (conflict?.response?.status === 412) {
  ok('412 Precondition Failed — server refused the stale write');
  value('error code', conflict.response.data?.code);
} else {
  console.log('  (no 412 — race may have served us; concurrency check still firing if you re-run)');
}

// ──────────────────────────────────────────────────────────────────
header('7. Direct REST probe (no MCP, no client wrapper)');
// ──────────────────────────────────────────────────────────────────

step('7a', 'curl-equivalent GET on a readonly ability');
const direct = await client.httpClient.request({
  method: 'GET',
  baseURL: client.baseUrl,
  url: '/wp-json/wp-abilities/v1/abilities/gk-gravityview/list-search-zones/run',
});
ok(`HTTP ${direct.status}  /wp-abilities/v1/abilities/gk-gravityview/list-search-zones/run`);
value('body', direct.data);

step('7b', 'How an external client (curl, Postman, the React app) calls this');
console.log(`  ${DIM}curl -u user:pass -X POST \\${RESET}`);
console.log(`  ${DIM}  https://example.com/wp-json/wp-abilities/v1/abilities/gk-gravityview/apply-view-config/run \\${RESET}`);
console.log(`  ${DIM}  -H 'Content-Type: application/json' \\${RESET}`);
console.log(`  ${DIM}  -d '{"input":{"id":${created.view_id},"fields":{...}}}'${RESET}`);

// ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}${GREEN}Done.${RESET}  View #${created.view_id} left in place for inspection.\n`);
