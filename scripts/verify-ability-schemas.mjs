#!/usr/bin/env node
/**
 * Round-trip every readonly ability against the output_schema it publishes.
 *
 * The server now publishes `outputSchema` and returns `structuredContent`, and the
 * spec obliges the two to match. Nothing in the unit suite can prove that: it takes
 * a real site, a real catalog, and a real call. This is that check, kept out of
 * `npm test` because it needs credentials and a running WordPress.
 *
 * Calls only abilities that are readonly AND have no required input, so it writes
 * nothing and needs no fixtures. An ability the site refuses on permissions is
 * reported and not counted as a failure — the question here is whether a result
 * that came back matches the schema that described it.
 *
 * Usage:
 *   GRAVITYKIT_WP_URL=… GRAVITYKIT_WP_USERNAME=… GRAVITYKIT_WP_APP_PASSWORD=… \
 *     node scripts/verify-ability-schemas.mjs
 */

import Ajv from 'ajv';
import { WordPressClient } from '../src/wp-client.js';
import { loadAbilitiesAsTools } from '../src/abilities/loader.js';
import { abilityToolResult } from '../src/utils/compact.js';

const wpClient = new WordPressClient(process.env);
const { definitions, handlers, source } = await loadAbilitiesAsTools(wpClient);

console.log(`Catalog: ${source} — ${definitions.length} tools from ${wpClient.baseUrl}`);
console.log(`Credentials: ${wpClient.credentialSource}\n`);

// strict:false — WordPress schemas carry keywords JSON Schema does not define
// (`context`, WP's own annotations), and rejecting those would report a schema
// problem where there is none.
const ajv = new Ajv({ strict: false, allErrors: true });

let checked = 0;
let skipped = 0;
let failed = 0;

for (const definition of definitions) {
  if (!definition.outputSchema) {
    skipped += 1;
    continue;
  }
  if (!definition.annotations?.readOnlyHint) {
    skipped += 1;
    continue;
  }

  const required = definition.inputSchema?.required;
  if (Array.isArray(required) && required.length > 0) {
    skipped += 1;
    continue;
  }

  let result;
  try {
    result = await handlers[definition.name]({});
  } catch (error) {
    // A refusal is the site's answer about this caller, not a schema defect.
    console.log(`  ~ ${definition.name}: not called (${error.message.slice(0, 80)})`);
    skipped += 1;
    continue;
  }

  checked += 1;

  const envelope = abilityToolResult(result);
  const validate = ajv.compile(definition.outputSchema);

  if (!validate(envelope.structuredContent)) {
    failed += 1;
    console.log(`  ✗ ${definition.name}`);
    for (const error of validate.errors.slice(0, 5)) {
      console.log(`      ${error.instancePath || '(root)'} ${error.message}`);
    }
    continue;
  }

  console.log(`  ✓ ${definition.name}`);
}

console.log(`\nchecked=${checked} failed=${failed} skipped=${skipped}`);

if (failed > 0) {
  console.log('\nA result did not match the schema its own tool publishes. Either the');
  console.log('ability\'s output_schema is wrong, or something between the site and the');
  console.log('client is reshaping the payload.');
}

process.exit(failed > 0 ? 1 : 0);
