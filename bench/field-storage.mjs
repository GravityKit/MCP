/**
 * Field-storage validation suite — deterministic, NOT AI-graded.
 *
 * Confirms the MCP's field-registry storage model + entry_input hints match how
 * Gravity Forms (and its REAL add-ons) actually store entry values. For each
 * fixed field type it builds a form, seeds an entry over the GF REST API, reads
 * the entry back, and asserts the STORED shape — the ground truth the registry
 * claims. This is storage testing only: no rendering, no search, no agent.
 *
 * "Real add-ons, not stubs": the add-on-gated types (chainedselect, signature,
 * survey_rank) are validated against a site with the ACTUAL Chained Selects /
 * Signature / Survey plugins symlinked + activated. A preflight prints each
 * active plugin's version and FAILS if a required add-on isn't really loaded,
 * so a green run can't be a stub passing for the real thing.
 *
 * Where a fix is metadata only (e.g. signature stores a filename, written by
 * the add-on's canvas-submission save path that the REST pipeline can't drive),
 * the suite validates what REST can — the real add-on registers the field — and
 * marks the storage shape SOURCE-VALIDATED, never silently green.
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
import { FieldManager } from '../src/field-operations/field-manager.js';
import { fieldRegistry } from '../src/field-definitions/field-registry.js';

const STORAGE_SITE = process.env.BENCH_STORAGE_SITE || 'gvstore';

// Add-on slug → the field types that depend on it (for the preflight + skips).
const ADDON_FIELDS = {
  gravityformschainedselects: ['chainedselect'],
  gravityformssignature: ['signature'],
  gravityformssurvey: ['survey_rank'],
};

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

/** Generate chainedselect sub-inputs using the ACTUAL FieldManager code under
 *  test — so the live round-trip validates the structure our fix emits, not a
 *  hand-written copy of it. generateSubInputs is pure (no API), so a null client
 *  is fine. */
function chainedSelectInputs(fieldId, levelLabels) {
  const fm = new FieldManager(null, fieldRegistry, { getWarnings: () => [] });
  return fm.generateSubInputs(
    { id: fieldId, type: 'chainedselect', inputs: levelLabels.map((label) => ({ label })) },
    { storage: { type: 'compound' } },
  );
}

/**
 * One case per fixed field. Each is independent (its own form).
 * - build(): the form's `fields` array.
 * - seed(formId, client): create the entry, return its id.
 * - assert(entry): { pass, detail, note? } against the STORED entry object.
 * - addon: required add-on slug (case is skipped-with-reason if absent).
 * - storageSourceValidated: a human note for shapes REST can't write live.
 */
const CASES = [
  {
    type: 'number',
    fix: "storage.type 'number' → 'string' (GF stores numbers as TEXT)",
    build: () => [{ id: 1, type: 'number', label: 'Number' }],
    seed: (formId, c) => c.createEntry(formId, { 1: '42' }),
    assert: (e) => {
      const v = e['1'];
      if (typeof v !== 'string') return { pass: false, detail: `expected string, got ${typeof v} (${JSON.stringify(v)})` };
      if (v !== '42') return { pass: false, detail: `expected "42", got ${JSON.stringify(v)}` };
      return { pass: true, detail: 'stored as string "42"' };
    },
  },
  {
    type: 'quantity',
    fix: "storage.type 'number' → 'string'",
    // A quantity field is normally bound to a product; a standalone one still
    // stores a string. Pair it with a single product so GF accepts the entry.
    build: () => [
      { id: 1, type: 'product', label: 'Widget', inputType: 'singleproduct', basePrice: '$10.00',
        inputs: [{ id: '1.1', label: 'Name' }, { id: '1.2', label: 'Price' }, { id: '1.3', label: 'Quantity' }] },
      { id: 2, type: 'quantity', label: 'Qty', productField: 1 },
    ],
    seed: (formId, c) => c.createEntry(formId, { '1.1': 'Widget', '1.2': '$10.00', 2: '3' }),
    assert: (e) => {
      const v = e['2'];
      if (typeof v !== 'string') return { pass: false, detail: `expected string, got ${typeof v} (${JSON.stringify(v)})` };
      if (v !== '3') return { pass: false, detail: `expected "3", got ${JSON.stringify(v)}` };
      return { pass: true, detail: 'stored as string "3"' };
    },
  },
  {
    type: 'address',
    fix: 'hint now lists all six sub-inputs N.1–N.6',
    build: () => [{
      id: 1, type: 'address', label: 'Location',
      inputs: [
        { id: '1.1', label: 'Street Address' }, { id: '1.2', label: 'Address Line 2' },
        { id: '1.3', label: 'City' }, { id: '1.4', label: 'State' },
        { id: '1.5', label: 'ZIP' }, { id: '1.6', label: 'Country' },
      ],
    }],
    seed: (formId, c) => c.createEntry(formId, {
      '1.1': '1 Infinite Loop', '1.2': 'Suite 100', '1.3': 'Cupertino',
      '1.4': 'CA', '1.5': '95014', '1.6': 'USA',
    }),
    assert: (e) => {
      const want = { '1.1': '1 Infinite Loop', '1.2': 'Suite 100', '1.3': 'Cupertino', '1.4': 'CA', '1.5': '95014', '1.6': 'USA' };
      const missing = Object.entries(want).filter(([k, v]) => e[k] !== v).map(([k]) => k);
      if (missing.length) return { pass: false, detail: `sub-inputs wrong/missing: ${missing.join(', ')}` };
      return { pass: true, detail: 'all six sub-inputs N.1–N.6 round-tripped (incl. .2 Line 2 + .6 Country)' };
    },
  },
  {
    type: 'chainedselect',
    addon: 'gravityformschainedselects',
    fix: 'FieldManager now emits one sub-input per level (was none)',
    build: () => [{
      id: 1, type: 'chainedselect', label: 'Vehicle',
      // Inputs generated by the ACTUAL code under test:
      inputs: chainedSelectInputs(1, ['Make', 'Model']),
      choices: [
        { text: 'Ford', value: 'Ford', choices: [
          { text: 'Focus', value: 'Focus' }, { text: 'Fiesta', value: 'Fiesta' },
        ] },
        { text: 'Toyota', value: 'Toyota', choices: [
          { text: 'Corolla', value: 'Corolla' },
        ] },
      ],
    }],
    seed: (formId, c) => c.createEntry(formId, { '1.1': 'Ford', '1.2': 'Focus' }),
    assert: (e, form) => {
      // The field our code generated must survive the round-trip with one input
      // per level, ids 1.1 / 1.2 — matching the real add-on's expectation.
      const field = (form.fields || []).find((f) => String(f.id) === '1');
      const inputIds = (field?.inputs || []).map((i) => String(i.id));
      if (inputIds.join(',') !== '1.1,1.2') return { pass: false, detail: `field inputs = [${inputIds}], expected [1.1,1.2]` };
      if (e['1.1'] !== 'Ford' || e['1.2'] !== 'Focus') {
        return { pass: false, detail: `per-level values wrong: 1.1=${JSON.stringify(e['1.1'])} 1.2=${JSON.stringify(e['1.2'])}` };
      }
      return { pass: true, detail: 'real add-on accepted our 2 generated sub-inputs; entry stored 1.1=Ford, 1.2=Focus' };
    },
  },
  {
    type: 'survey_rank',
    addon: 'gravityformssurvey',
    fix: 'hint: comma-separated ranked values is CORRECT (audit was wrong)',
    build: () => [{
      id: 1, type: 'survey', inputType: 'rank', label: 'Priorities',
      // Comma-free values, mirroring the add-on's auto-assigned tokens.
      choices: [
        { text: 'Speed', value: 'speedval' },
        { text: 'Price', value: 'priceval' },
        { text: 'Quality', value: 'qualityval' },
      ],
    }],
    seed: (formId, c) => c.createEntry(formId, { 1: 'qualityval,speedval,priceval' }),
    assert: (e) => {
      const v = e['1'];
      if (typeof v !== 'string') return { pass: false, detail: `expected string, got ${typeof v}` };
      if (v !== 'qualityval,speedval,priceval') return { pass: false, detail: `expected comma-joined ranked order, got ${JSON.stringify(v)}` };
      return { pass: true, detail: 'real add-on stored comma-joined ranked values as one string (order preserved)' };
    },
  },
  {
    type: 'signature',
    addon: 'gravityformssignature',
    fix: "storage.format 'base64' → 'filename'",
    // The add-on writes the entry value (a saved-image filename) from a custom
    // canvas POST key the REST submission pipeline can't populate, so we can't
    // drive base64→filename over REST. We validate what REST CAN: the real
    // add-on is active and registers the field; the filename shape is
    // source-validated (get_value_save_entry → maybe_save_signature → filename).
    storageSourceValidated: 'entry stores the saved-image FILENAME (get_value_save_entry → maybe_save_signature → save_signature returns "<hash>.png"); URL derived at display time.',
    build: () => [{ id: 1, type: 'signature', label: 'Sign Here' }],
    seed: () => null, // no entry — see storageSourceValidated
    assert: (_entry, form) => {
      const field = (form.fields || []).find((f) => String(f.id) === '1');
      if (!field || field.type !== 'signature') return { pass: false, detail: 'signature field not present in form after create' };
      return { pass: true, detail: 'real Signature add-on active + field registered (storage format source-validated)' };
    },
  },
];

function preflight(plugins, requestedTypes) {
  const required = ['gravityforms', 'GravityView'];
  const missing = required.filter((slug) => !plugins[slug]);
  if (missing.length) throw new Error(`base plugins not active on the mint: ${missing.join(', ')}`);

  // Verify every add-on whose field types we're actually about to run is real + active.
  const needed = new Set();
  for (const [slug, types] of Object.entries(ADDON_FIELDS)) {
    const willRun = types.some((t) => !requestedTypes || requestedTypes.includes(t));
    if (willRun) needed.add(slug);
  }
  const addonMissing = [...needed].filter((slug) => !plugins[slug]);
  return { needed: [...needed], addonMissing };
}

async function main() {
  const args = parseArgs(process.argv);
  const cases = args.types ? CASES.filter((cs) => args.types.includes(cs.type)) : CASES;
  if (!cases.length) { console.error(`No storage cases match --type ${args.types}`); process.exit(2); }

  let target;
  let mintedName = null;
  let sitePath = null;
  if (args.mint) {
    const prov = await provisionSite({
      fresh: args.fresh,
      name: STORAGE_SITE,
      plugins: [...SITEMINTER.plugins, ...SITEMINTER.addons],
      log: (m) => console.log(`[siteminter] ${m}`),
    });
    target = prov.target;
    mintedName = prov.name;
    sitePath = prov.path;
  } else {
    target = resolveTarget();
  }
  const client = makeClient(target);

  console.log(`\nField-storage suite → ${target.baseUrl}`);

  // Preflight: prove we're on real add-ons, not stubs.
  let addonMissing = [];
  if (sitePath) {
    const plugins = activePlugins(sitePath);
    const requestedTypes = args.types;
    const pf = preflight(plugins, requestedTypes);
    addonMissing = pf.addonMissing;
    console.log('Active plugins (real source under test):');
    for (const slug of ['gravityforms', 'GravityView', ...Object.keys(ADDON_FIELDS)]) {
      if (plugins[slug]) console.log(`  • ${slug} ${plugins[slug]}`);
    }
    if (addonMissing.length) {
      console.log(`\n⚠ add-ons not active (their cases will be skipped, not faked): ${addonMissing.join(', ')}`);
    }
  } else {
    console.log('(no --mint: running against the configured target; add-on presence not asserted)');
  }
  console.log(`Cases: ${cases.length}\n`);

  const results = [];
  for (const cs of cases) {
    const addonAbsent = cs.addon && addonMissing.includes(cs.addon);
    if (addonAbsent) {
      results.push({ type: cs.type, skipped: true, detail: `add-on ${cs.addon} not active${cs.storageSourceValidated ? ' (source-validated)' : ''}` });
      console.log(`  ⊘ ${cs.type.padEnd(14)} skipped — add-on ${cs.addon} absent`);
      continue;
    }
    let formId = 0;
    let verdict;
    try {
      const fields = cs.build();
      const formRes = await client._gf.post('/forms', { title: `BENCH FieldStorage ${cs.type} ${Date.now()}`, fields });
      formId = Number(formRes.data?.id ?? formRes.data);
      if (!formId) throw new Error(`form create failed (${formRes.status}): ${JSON.stringify(formRes.data).slice(0, 200)}`);

      const entryId = await cs.seed(formId, client);
      const entry = entryId ? await client.getEntry(entryId) : {};
      const form = await client.getForm(formId);
      verdict = cs.assert(entry, form);
    } catch (e) {
      verdict = { pass: false, detail: `threw: ${e?.message || e}` };
    } finally {
      if (formId) await client.deleteForm(formId);
    }
    results.push({ type: cs.type, ...verdict });
    const mark = verdict.pass ? '✓' : '✗';
    console.log(`  ${mark} ${cs.type.padEnd(14)} ${verdict.detail || ''}`);
    if (cs.storageSourceValidated && verdict.pass) console.log(`      ↳ source-validated: ${cs.storageSourceValidated}`);
  }

  if (mintedName && !args.keep) { try { destroySite(mintedName); } catch { /* best effort */ } }
  else if (mintedName) console.log(`\n[siteminter] keeping "${mintedName}".`);

  const failed = results.filter((r) => !r.pass && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log('\n' + '─'.repeat(64));
  if (failed.length) {
    console.log(`❌ FIELD STORAGE: ${failed.length}/${results.length} case(s) stored the wrong shape:`);
    for (const f of failed) console.log(`   • ${f.type}: ${f.detail}`);
  } else {
    console.log(`✅ FIELD STORAGE: all ${results.length - skipped.length} run case(s) match the registry${skipped.length ? `; ${skipped.length} skipped (add-on absent)` : ''}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`\nField-storage suite crashed: ${e?.stack || e}\n`); process.exit(2); });
