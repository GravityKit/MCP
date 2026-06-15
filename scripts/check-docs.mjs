#!/usr/bin/env node
/**
 * Offline doc-freshness guard for AGENTS.md (the single canonical doc).
 *
 * Catches the drift classes this project has actually hit: a new src/ dir
 * nobody documented, stale tool/field counts, brittle file:line citations,
 * and a renamed built-in. Pure static analysis — no network, safe for
 * prepublishOnly. Exit 0 = fresh, 1 = drift.
 *
 * Run via `npm run lint:docs`.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fieldRegistry } from '../src/field-definitions/field-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const agents = read('AGENTS.md');
const problems = [];

// 1. Repo map / docs mention every immediate child of src/ that isn't
// git-ignored. `git ls-files --cached --others --exclude-standard` lets git
// apply .gitignore for us (no hand-rolled parser): it lists on-disk files
// minus ignored ones, so junk like .DS_Store drops out because it's ignored,
// new not-yet-committed files are still caught, and tracked dotfiles count.
try {
  const srcChildren = [...new Set(
    execSync('git ls-files --cached --others --exclude-standard src', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .map((p) => p.replace(/^src\//, '').split('/')[0])
  )];
  for (const child of srcChildren) {
    if (!agents.includes(child)) problems.push(`src/ entry never mentioned in AGENTS.md: ${child}`);
  }
} catch {
  console.warn('  (repo-map coverage check skipped — git not available)');
}

// 2. "N field types" claims match the registry.
const fieldCount = Object.keys(fieldRegistry).length;
const fieldClaims = [...agents.matchAll(/(\d+)\s+(?:Gravity Forms\s+)?field types/g)].map((m) => Number(m[1]));
if (!fieldClaims.length) problems.push('No "N field types" claim found in AGENTS.md');
for (const n of fieldClaims) if (n !== fieldCount) problems.push(`Field-type count drift: AGENTS.md says ${n}, registry has ${fieldCount}`);

// 3. "N Gravity Forms tools" claims match the registered gf_* tools.
const gfRe = /name:\s*'(gf_[a-z0-9_]+)'/g;
const gfTools = new Set([
  ...[...read('src/index.js').matchAll(gfRe)].map((m) => m[1]),
  ...[...read('src/field-operations/index.js').matchAll(gfRe)].map((m) => m[1]),
]);
const toolClaims = [...agents.matchAll(/(\d+)\s+(?:[\w-]+\s+)?Gravity Forms tools/g)].map((m) => Number(m[1]));
if (!toolClaims.length) problems.push('No "N Gravity Forms tools" claim found in AGENTS.md');
for (const n of toolClaims) if (n !== gfTools.size) problems.push(`GF tool-count drift: AGENTS.md says ${n}, code registers ${gfTools.size}`);

// 4. No brittle file:line citations (policy: cite symbols, not lines).
const cites = [...agents.matchAll(/[\w./-]+\.(?:js|mjs|json|php):\d+(?:-\d+)?|`:\d+(?:-\d+)?`/g)].map((m) => m[0]);
if (cites.length) problems.push(`${cites.length} file:line citation(s) — cite symbols, not lines: ${[...new Set(cites)].slice(0, 6).join(', ')}`);

// 5. The GravityKit reload built-in is named gk_reload_abilities and registered.
if (agents.includes('gk_reload_abilities') && !read('src/index.js').includes("name: 'gk_reload_abilities'")) {
  problems.push('AGENTS.md references gk_reload_abilities but src/index.js does not register a tool with that name');
}

if (problems.length) {
  console.error('❌ AGENTS.md doc-freshness check failed:');
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}
console.log(`✅ AGENTS.md doc-freshness OK — ${gfTools.size} gf_* tools, ${fieldCount} field types, repo map covers src/, no line citations`);
