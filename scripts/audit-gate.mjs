#!/usr/bin/env node
/**
 * Fail the build on any production advisory that is not explicitly allowed.
 *
 * The workflow this replaces ran `npm audit ... || true` under
 * `continue-on-error: true`, so it could not fail: axios sat on 28 advisories
 * for four months behind a green badge. A gate that cannot fail is worse than
 * no gate, because it reports success.
 *
 * Failing on every advisory is the opposite mistake. Eight of this package's
 * production dependencies carry advisories in the MCP SDK's HTTP transport,
 * which a stdio server never loads, and there is no upstream version without
 * them. A build that is permanently red teaches everyone to ignore it.
 *
 * So: each allowed package is named in .github/audit-allowlist.json with the
 * reason it does not apply here. Anything else fails.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(root, '.github', 'audit-allowlist.json');

const { allowed = {}, reviewed } = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

// `npm audit` exits non-zero when it finds anything, so a throw here is the
// normal path and the payload still has to be read.
let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8' });
} catch (error) {
  raw = error.stdout;
}

if (!raw) {
  console.error('npm audit produced no output — treating as a broken check, not a pass.');
  process.exit(2);
}

const report = JSON.parse(raw);

// `npm audit --json` exits nonzero and writes {"error": …} when it cannot reach the
// registry. Treating a missing `vulnerabilities` key as "none found" would turn that
// into a pass -- the exact defect this gate replaced.
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary || report.error.detail || JSON.stringify(report.error)}`);
  process.exit(2);
}

if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || !report.metadata) {
  console.error('npm audit returned no recognisable audit report — treating as a broken check, not a pass.');
  process.exit(2);
}

const found = Object.keys(report.vulnerabilities);

// Allowing a package is not allowing every future advisory against it, so each entry
// records the advisories reviewed at the time. A new advisory id on an allowlisted
// package fails until somebody looks at it and adds it.
const advisoryIds = (info) => (info.via || [])
  .filter((v) => typeof v === 'object' && v.url)
  .map((v) => v.url.replace(/.*\//, ''))
  .sort();

const unexpected = found.filter((name) => !(name in allowed));
const unreviewed = [];

for (const name of found.filter((n) => n in allowed)) {
  const entry    = allowed[name];
  const reviewed = Array.isArray(entry.advisories) ? entry.advisories : null;
  if (!reviewed) continue; // reason-only entry: package-level, as before

  const fresh = advisoryIds(report.vulnerabilities[name]).filter((id) => !reviewed.includes(id));
  if (fresh.length) unreviewed.push({ name, fresh });
}
const stale = Object.keys(allowed).filter((name) => !found.includes(name));

for (const name of found.filter((n) => n in allowed)) {
  console.log(`allowed   ${name} — ${allowed[name].reason || allowed[name]}`);
}

// An entry that no longer matches anything means the dependency was fixed or
// dropped. Not a failure, but it should not sit in the file forever claiming
// to excuse something.
for (const name of stale) {
  console.log(`stale     ${name} — no longer reported; remove it from the allowlist`);
}

if (unreviewed.length) {
  console.error('\nAllowlisted package(s) carry advisories nobody has reviewed:\n');
  for (const { name, fresh } of unreviewed) {
    console.error(`  ${name}: ${fresh.join(', ')}`);
  }
  console.error('\nReview them, then add the ids to that package\'s "advisories" in .github/audit-allowlist.json.');
  process.exit(1);
}

if (unexpected.length === 0) {
  console.log(`\nNo unexpected production advisories. Allowlist last reviewed ${reviewed}.`);
  process.exit(0);
}

console.error(`\n${unexpected.length} production advisory package(s) not in the allowlist:\n`);
for (const name of unexpected) {
  const { severity, via } = report.vulnerabilities[name];
  const titles = (via || [])
    .filter((v) => typeof v === 'object' && v.title)
    .map((v) => `      ${v.severity}: ${v.title}`);
  console.error(`  ${name} (${severity})`);
  console.error(titles.join('\n') || '      (transitive)');
}
console.error('\nFix it, or add it to .github/audit-allowlist.json with the reason it does not apply.');
process.exit(1);
