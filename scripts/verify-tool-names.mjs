#!/usr/bin/env node
/**
 * Verify that every gf_ / gv_ tool name referenced in prose (server
 * instructions, docs, the demo) matches a tool the server actually
 * registers. The gv_* surface is generated at runtime from the installed
 * GravityView/Foundation Abilities catalog, so a catalog rename can silently
 * leave the instructions string or docs pointing at tools that no longer
 * exist — exactly the drift that broke demo-abilities.mjs.
 *
 * Authoritative set:
 *   - gf_* (static): the `name:` props in src/index.js (GF_TOOL_DEFINITIONS)
 *     and src/field-operations/index.js (fieldOperationTools)
 *   - gv_* (dynamic): loaded live from the connected site's catalog
 *   - gk-gravityview/* abilities: the live catalog (for the demo's references)
 *
 * Requires a live WordPress connection (same env as the server):
 *   GRAVITYKIT_WP_URL + GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD,
 *   or the GRAVITY_FORMS_* equivalents (see .env.example / AGENTS.md).
 *
 * Usage:  node scripts/verify-tool-names.mjs   (or: npm run verify:tool-names)
 * Exit:   0 = all references match · 1 = mismatches found or catalog unreachable
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WordPressClient } from '../src/wp-client.js';
import { loadAbilitiesAsTools } from '../src/abilities/loader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Tokens that look like tool names in prose but intentionally are not — keep
// this list short and explain each one so it stays honest.
const IGNORE = new Map([
  ['gf_new_tool', 'AGENTS.md "Adding a New Tool" example placeholder'],
  ['gv_revision_', 'entry-meta key prefix gv_revision_* (compact-mode docs), not a tool'],
]);

// --- Authoritative set: exactly what the server registers ---
const grabNames = (rel, re) => [...read(rel).matchAll(re)].map((m) => m[1]);
const gfStatic = new Set([
  ...grabNames('src/index.js', /name:\s*'(gf_[a-z0-9_]+)'/g),
  ...grabNames('src/field-operations/index.js', /name:\s*'(gf_[a-z0-9_]+)'/g),
]);

const wp = new WordPressClient(process.env);
let gvDynamic, abilityNames;
try {
  const { definitions } = await loadAbilitiesAsTools(wp);
  gvDynamic = new Set(definitions.map((d) => d.name));
  const catalog = (await wp.httpClient.request({
    method: 'GET',
    baseURL: wp.baseUrl,
    url: '/wp-json/wp-abilities/v1/abilities',
  })).data;
  abilityNames = new Set(catalog.filter((a) => a.name?.startsWith('gk-gravityview/')).map((a) => a.name));
} catch (err) {
  console.error(`✗ Could not load the live abilities catalog from ${wp.baseUrl}`);
  console.error(`  ${err.message}`);
  console.error('  Set WP credentials (see AGENTS.md) and point at a running site, then retry.');
  process.exit(1);
}

const authToolNames = new Set([...gfStatic, ...gvDynamic]);
console.log(`Authoritative: ${gfStatic.size} gf_*  +  ${gvDynamic.size} gv_*  =  ${authToolNames.size} tools; ${abilityNames.size} gk-gravityview/* abilities\n`);

// --- Referenced names per surface ---
const TOOL_RE = /\b(g[fv]_[a-z0-9_]+)\b/g;
const ABIL_RE = /\bgk-gravityview\/[a-z0-9-]+/g;

// The server `instructions` string is what the agent reads — check that line
// specifically rather than the whole file (which also *defines* the tools).
const instrLine = read('src/index.js').split('\n').find((l) => l.includes('instructions:')) || '';

const surfaces = [
  ['src/index.js  (instructions string)', instrLine, TOOL_RE],
  ['demo-abilities.mjs  (tool handlers)', read('demo-abilities.mjs'), TOOL_RE],
  ['demo-abilities.mjs  (ability names)', read('demo-abilities.mjs'), ABIL_RE],
  ['AGENTS.md', read('AGENTS.md'), TOOL_RE],
  ['README.md', read('README.md'), TOOL_RE],
  ['mcp.json', read('mcp.json'), TOOL_RE],
  // CLAUDE.md re-exports AGENTS.md (@AGENTS.md) — already covered above.
];

let problems = 0;
let ignored = 0;
for (const [label, text, re] of surfaces) {
  const isAbil = re === ABIL_RE;
  const valid = isAbil ? abilityNames : authToolNames;
  const ref = [...new Set([...text.matchAll(re)].map((m) => m[0]))].sort();
  const bad = ref.filter((n) => !valid.has(n) && !IGNORE.has(n));
  ignored += ref.filter((n) => IGNORE.has(n)).length;
  console.log(`${label}: ${ref.length} referenced, ${bad.length} unknown`);
  if (bad.length) {
    problems += bad.length;
    bad.forEach((n) => console.log(`   ✗ ${n}`));
  }
}

if (ignored) {
  console.log(`\nIgnored ${ignored} known non-tool token(s):`);
  for (const [tok, why] of IGNORE) console.log(`   • ${tok} — ${why}`);
}

console.log(`\n${problems === 0 ? '✅ All referenced names match registered MCP tool/ability names' : `❌ ${problems} mismatch(es) — update the docs or the IGNORE list`}`);
process.exit(problems === 0 ? 0 : 1);
