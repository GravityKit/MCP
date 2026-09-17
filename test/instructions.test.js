/**
 * The MCP `instructions` string is delivered to the client every session,
 * regardless of the task at hand. Agent-directed, second-person prose there
 * reads as injected directives "not from the user" and trips the consuming
 * model's prompt-injection defense. Keep the string neutral and declarative,
 * and keep it pointing at the live discovery surface so it stays useful.
 *
 * The string is parsed out of src/index.js the same way scripts/verify-tool-names.mjs
 * does (the single `instructions:` line), so this guards the shipped text.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

// The instructions value lives on a single source line (verify-tool-names.mjs
// relies on the same shape). Pull the JS string literal out of it.
const instrLine = source.split('\n').find((l) => l.includes('instructions:'));
const match = instrLine && instrLine.match(/instructions:\s*'((?:[^'\\]|\\.)*)'/);
const instructions = match ? match[1].replace(/\\'/g, "'").replace(/\\n/g, '\n') : '';

test('instructions string is present and parseable', () => {
  assert.ok(instructions.length > 0, 'could not extract the instructions string from src/index.js');
});

test('instructions string has no second-person "you" address', () => {
  // Second-person framing is what reads as an injected directive. A neutral,
  // declarative string never needs to address the reader.
  const youAddress = instructions.match(/\byou(?:r|rs|rself)?\b/i);
  assert.equal(
    youAddress,
    null,
    `instructions must not address the agent in the second person, found: ${youAddress && youAddress[0]}`
  );
});

test('instructions string documents the horizontal search-bar mechanism', () => {
  // The one shipped behavior of this fix lives in this prose (the gv_* tool
  // schemas are server-owned). Guard its substance so it can't silently
  // regress: it must name the area_settings row layout AND warn off the
  // search_layout false positive, or a small model reverts to the no-op.
  assert.match(instructions, /area_settings/, 'instructions must document the area_settings layout mechanism');
  assert.match(instructions, /\brow\b/, 'instructions must specify the "row" layout value');
  assert.match(instructions, /search_layout/, 'instructions must name search_layout as the setting to avoid');
});

test('instructions string still names the discovery surface', () => {
  // A *_list discovery tool keeps the dynamic surface findable without the
  // old imperative playbook.
  assert.match(
    instructions,
    /gv_[a-z0-9_]*_list\b/,
    'instructions should name at least one gv_*_list discovery tool'
  );
  assert.match(
    instructions,
    /\bgk_reload_abilities\b/,
    'instructions should name gk_reload_abilities for refreshing the catalog'
  );
});
