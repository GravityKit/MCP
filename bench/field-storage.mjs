/**
 * Field-storage validation suite — deterministic, NOT AI-graded.
 *
 * Confirms the MCP's field model (registry storage + entry_input hints) matches
 * how Gravity Forms — and its REAL add-ons — actually store entry values. For
 * every storable field type (plus variant-aware cases like fileupload
 * single/JSON and the product input types), it builds a form, seeds an entry
 * over the GF REST API, reads it back, and asserts the STORED shape. Layout
 * types (html/section/page/captcha/password) assert the field is created with
 * no entry value. This is storage testing only: no rendering, no search, no
 * agent. See bench/field-storage-cases.mjs for the cases.
 *
 * "Real add-ons, not stubs": add-on-gated types (chainedselect, signature,
 * survey*, quiz, poll, nested form) run against a site with the ACTUAL Chained
 * Selects / Signature / Survey / Polls / Quiz / GP Nested Forms plugins
 * symlinked + activated. A preflight prints each active plugin's version and a
 * case whose add-on isn't really loaded is SKIPPED, never faked — so a green
 * run can't be a stub.
 *
 * Usage:
 *   node bench/field-storage.mjs --mint [--keep] [--fresh]   # throwaway site w/ add-ons
 *   node bench/field-storage.mjs                             # GRAVITY_FORMS_* target
 *   node bench/field-storage.mjs --type number,address       # filter by type
 *
 * Exit: 0 all pass · 1 a field's stored shape was wrong · 2 harness error.
 */

import { resolveTarget, SITEMINTER } from './config.mjs';
import { makeClient } from './lib/target.mjs';
import { provisionSite, destroySite, activePlugins } from './lib/siteminter.mjs';
import { CASES } from './field-storage-cases.mjs';

const STORAGE_SITE = process.env.BENCH_STORAGE_SITE || 'gvstore';

// The main field under test uses this id; multi-field cases (quantity/option/
// total) carry their auxiliary product at a fixed non-colliding id (10).
const FIELD_ID = 1;

// Add-on slugs whose versions we print in the preflight (proof of real source).
const ADDON_SLUGS = [
  'gravityformschainedselects',
  'gravityformssignature',
  'gravityformssurvey',
  'gravityformspolls',
  'gravityformsquiz',
  'gp-nested-forms',
];

function parseArgs(argv) {
  const out = { mint: false, keep: false, fresh: false, types: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mint') out.mint = true;
    else if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--fresh') out.fresh = true;
    else if (argv[i] === '--type') out.types = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const caseLabel = (cs) => `${cs.type}${cs.variant ? ` (${cs.variant})` : ''}`;

async function main() {
  const args = parseArgs(process.argv);
  const cases = args.types ? CASES.filter((cs) => args.types.includes(cs.type)) : CASES;
  if (!cases.length) { console.error(`No storage cases match --type ${args.types}`); process.exit(2); }

  let target;
  let mintedName = null;
  let plugins = null; // active-plugins map; null when not minting
  if (args.mint) {
    const prov = await provisionSite({
      fresh: args.fresh,
      name: STORAGE_SITE,
      plugins: [...SITEMINTER.plugins, ...SITEMINTER.addons],
      log: (m) => console.log(`[siteminter] ${m}`),
    });
    target = prov.target;
    mintedName = prov.name;
    plugins = activePlugins(prov.path);
  } else {
    target = resolveTarget();
  }
  const client = makeClient(target);

  console.log(`\nField-storage suite → ${target.baseUrl}`);

  // Preflight: prove we're on real source, not stubs.
  if (plugins) {
    const baseMissing = ['gravityforms', 'GravityView'].filter((slug) => !plugins[slug]);
    if (baseMissing.length) throw new Error(`base plugins not active on the mint: ${baseMissing.join(', ')}`);
    console.log('Active plugins (real source under test):');
    for (const slug of ['gravityforms', 'GravityView', ...ADDON_SLUGS]) {
      if (plugins[slug]) console.log(`  • ${slug} ${plugins[slug]}`);
    }
  } else {
    console.log('(no --mint: running against the configured target; add-on presence not asserted)');
  }
  console.log(`Cases: ${cases.length}\n`);

  const results = [];
  for (const cs of cases) {
    const label = caseLabel(cs);
    // Skip (never fake) a case whose add-on isn't actually active on the mint.
    if (cs.addon && plugins && !plugins[cs.addon]) {
      results.push({ label, skipped: true, detail: `add-on ${cs.addon} not active` });
      const tail = cs.note ? ` — ${cs.note}` : '';
      console.log(`  ⊘ ${label.padEnd(28)} skipped — add-on ${cs.addon} absent${tail}`);
      continue;
    }

    let formId = 0;
    let ctx;
    let verdict;
    try {
      // Optional setup runs first — e.g. a nested-form case creates its child
      // form + child entries and returns their ids for build/seed/assert.
      if (cs.setup) ctx = await cs.setup(client);
      const fields = cs.build(FIELD_ID, ctx);
      const formRes = await client._gf.post('/forms', { title: `BENCH FieldStorage ${label} ${Date.now()}`, fields });
      formId = Number(formRes.data?.id ?? formRes.data);
      if (!formId) throw new Error(`form create failed (${formRes.status}): ${JSON.stringify(formRes.data).slice(0, 200)}`);

      const entryId = await cs.seed(formId, client, FIELD_ID, ctx);
      const entry = entryId ? await client.getEntry(entryId) : {};
      const form = await client.getForm(formId);
      verdict = cs.assert(entry, form, FIELD_ID, ctx);
    } catch (e) {
      verdict = { pass: false, detail: `threw: ${e?.message || e}` };
    } finally {
      if (formId) await client.deleteForm(formId);
      if (cs.teardown && ctx) { try { await cs.teardown(client, ctx); } catch { /* best effort */ } }
    }

    results.push({ label, ...verdict });
    console.log(`  ${verdict.pass ? '✓' : '✗'} ${label.padEnd(28)} ${verdict.detail || ''}`);
    if (cs.note && verdict.pass) console.log(`      ↳ ${cs.note}`);
  }

  if (mintedName && !args.keep) { try { destroySite(mintedName); } catch { /* best effort */ } }
  else if (mintedName) console.log(`\n[siteminter] keeping "${mintedName}".`);

  const failed = results.filter((r) => !r.pass && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const ran = results.length - skipped.length;
  console.log('\n' + '─'.repeat(64));
  if (failed.length) {
    console.log(`❌ FIELD STORAGE: ${failed.length}/${ran} run case(s) stored the wrong shape:`);
    for (const f of failed) console.log(`   • ${f.label}: ${f.detail}`);
  } else {
    console.log(`✅ FIELD STORAGE: all ${ran} run case(s) match the field model${skipped.length ? `; ${skipped.length} skipped (add-on absent)` : ''}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`\nField-storage suite crashed: ${e?.stack || e}\n`); process.exit(2); });
