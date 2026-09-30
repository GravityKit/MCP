/**
 * A tool's description is the only documentation an agent gets before it
 * commits to a call. A description promising a capability the inputSchema does
 * not expose costs a wasted call and, worse, a wrong conclusion: an agent told
 * `gf_list_forms` supports search will believe an unfiltered result is filtered.
 *
 * Parsed out of src/index.js as text, the way test/instructions.test.js does —
 * the file is the server entry point and exports nothing.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

/**
 * Every `gf_*` static tool definition as { name, description, props }.
 *
 * @returns {Array<{name: string, description: string, props: string[]}>}
 */
function gfToolDefinitions() {
  const re = /\{\s*name: '(gf_[a-z_]+)',\s*description: '((?:[^'\\]|\\.)*)'/g;
  const out = [];
  let match;

  while ((match = re.exec(source))) {
    // The properties block sits inside this definition; read a bounded window
    // rather than brace-matching, which a description containing a brace breaks.
    const chunk = source.slice(match.index, match.index + 2600);
    const propsAt = chunk.indexOf('properties:');
    const props = propsAt === -1
      ? []
      : [...chunk.slice(propsAt, propsAt + 2000).matchAll(/^\s{8,}([a-z_0-9]+):\s*\{/gm)].map((m) => m[1]);

    out.push({ name: match[1], description: match[2], props: [...new Set(props)] });
  }

  return out;
}

test('gf_* descriptions promise no capability the schema lacks', () => {
  const defs = gfToolDefinitions();

  // Prove the parser found the surface before asserting over it — an empty
  // list would pass every check below while testing nothing.
  assert.ok(defs.length >= 20, `expected the gf_* tool definitions, parsed ${defs.length}`);

  const claims = [
    { mentions: /\bsearch/i, denies: /\b(no|without|not|cannot|never)\b[^.]{0,30}\bsearch/i, satisfiedBy: /search|query/, label: 'search' },
    { mentions: /paginat|paging|per[ _]page/i, denies: /\b(no|without|not|cannot|never)\b[^.]{0,30}(paginat|paging)/i, satisfiedBy: /paging|page|offset|limit/, label: 'pagination' },
  ];

  const broken = [];
  for (const def of defs) {
    for (const claim of claims) {
      if (!claim.mentions.test(def.description)) continue;
      // Saying a capability is absent is the honest case, not a promise of it.
      if (claim.denies.test(def.description)) continue;
      if (def.props.some((p) => claim.satisfiedBy.test(p))) continue;
      broken.push(`${def.name} promises ${claim.label}; schema exposes [${def.props.join(', ')}]`);
    }
  }

  assert.deepEqual(broken, [], `descriptions promising what the schema cannot take:\n  ${broken.join('\n  ')}`);
});

test('the claim check can actually fail', () => {
  // A guard nobody has seen fail is a guard nobody knows works. `gf_list_entries`
  // genuinely takes `search`, so a description keyword alone must not be enough
  // to flag it — and a schema with no matching property must be.
  const entries = gfToolDefinitions().find((d) => d.name === 'gf_list_entries');

  assert.ok(entries, 'gf_list_entries must be in the parsed set');
  assert.ok(/\bsearch/i.test(entries.description), 'its description does mention search');
  assert.ok(entries.props.some((p) => /search|query/.test(p)), 'and its schema exposes it, so it must not be flagged');
});
