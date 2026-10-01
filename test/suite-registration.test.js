/**
 * Every test file has to run somewhere, and a file that runs under `node --test`
 * has to be able to fail there.
 *
 * test/checkbox-expansion.test.js sat registered nowhere, so it never executed, and
 * carried two failing tests nobody saw. This derives the list from the directory
 * instead of trusting a hand-kept one.
 *
 * A TestRunner suite calls `suite.run()` and never sets an exit code, so under
 * `node --test` it reports "ok" whatever its assertions did (measured: 39 passed,
 * 2 failed, reported `ok 1`). Those suites belong in test/run.js, which counts.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(testDir, '..');

// Files that need a live site and skip or fail without credentials, so no default
// script runs them. Each is run on purpose, by hand.
const LIVE_ONLY = new Map([
  ['field-operations-e2e.test.js', 'needs TEST_GF_CONSUMER_KEY and a live Gravity Forms site'],
  ['field-operations-integration.test.js', 'needs TEST_GF_CONSUMER_KEY and a live Gravity Forms site'],
  ['views-stress.test.js', 'needs WordPress credentials and a GravityView install']
]);

// Built in two pieces so this file does not match its own check.
const RUNNER_MARKER = 'new ' + 'TestRunner(';

const testFiles = fs.readdirSync(testDir).filter((name) => name.endsWith('.test.js')).sort();
const packageScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const runnerSource = fs.readFileSync(path.join(testDir, 'run.js'), 'utf8');
const nodeTestScript = packageScripts['test:node'];

const inRunner = (name) => runnerSource.includes(`./${name}`);
const inScript = (name) => Object.values(packageScripts).some((script) => script.includes(`test/${name}`));

test('every test file is loaded by test/run.js or a package.json script, or is listed as live-only', () => {
  const orphans = testFiles.filter((name) => !inRunner(name) && !inScript(name) && !LIVE_ONLY.has(name));
  assert.deepStrictEqual(orphans, [], `registered nowhere, so they never run: ${orphans.join(', ')}`);
});

test('a file listed as live-only is not registered anywhere, and exists', () => {
  const stale = [...LIVE_ONLY.keys()].filter((name) => !testFiles.includes(name) || inRunner(name) || inScript(name));
  assert.deepStrictEqual(stale, [], `drop from LIVE_ONLY: ${stale.join(', ')}`);
});

test('a file in test:node cannot be a TestRunner suite, which reports ok under node --test whatever fails', () => {
  const nodeFiles = testFiles.filter((name) => nodeTestScript.includes(`test/${name}`));
  assert.ok(nodeFiles.length > 10, 'the test:node list was not read');
  const runnerSuites = nodeFiles.filter((name) => fs.readFileSync(path.join(testDir, name), 'utf8').includes(RUNNER_MARKER));
  assert.deepStrictEqual(runnerSuites, [], `move to test/run.js: ${runnerSuites.join(', ')}`);
});
