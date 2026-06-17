/**
 * Field-output smoke suite — deterministic, NOT AI-graded.
 *
 * For every displayable Gravity Forms field type, render its View-display cell
 * HTML through the gk-gravityview/view-field-render ability (staged_slot, so
 * nothing is persisted) against one seeded entry, and assert the output renders
 * properly (error-free, and — for content-pinnable types — contains the
 * expected display value). This is field OUTPUT testing only: it does not touch
 * search, CRUD, or agent behavior.
 *
 * Shares the bench's target plumbing (siteminter / resolveTarget / makeClient)
 * but does its own work directly over REST — no `claude` agent, no scoring.
 *
 * Usage:
 *   node bench/field-output.mjs --mint [--keep] [--fresh]   # throwaway site
 *   node bench/field-output.mjs                              # GRAVITY_FORMS_* target
 *   node bench/field-output.mjs --type address,product       # filter by type
 *
 * Exit: 0 all pass · 1 a field failed to render · 2 harness error.
 */

import { resolveTarget } from './config.mjs';
import { makeClient } from './lib/target.mjs';
import { provisionSite, destroySite } from './lib/siteminter.mjs';
import { FIELDS } from './field-output-cases.mjs';

const DIRECTORY_AREA = 'directory_table-columns'; // default_table directory zone
const ERROR_MARKERS = [/Fatal error/i, /WP_Error/, /wp-die/i, /call to a member function/i, /Notice:/, /Warning:/];

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

/** Render one field's cell HTML via the ability; returns { ok, html, error }.
 *  view-field-render is readonly → GET. The nested staged_slot rides as
 *  bracketed query params (PHP parses input[staged_slot][field_id] into a
 *  nested array, which the ability repackages into its internal render POST). */
async function renderField(client, viewId, formId, fieldId, settings = {}) {
  const params = {
    'input[id]': viewId,
    'input[area]': DIRECTORY_AREA,
    'input[slot]': 'fieldoutput-preview',
    'input[staged_slot][field_id]': String(fieldId),
    // form_id is required for the staged slot to resolve the GF field's type
    // + entry value ({form_id}::{id} identity); without it the cell renders empty.
    'input[staged_slot][form_id]': String(formId),
  };
  // GravityView field settings (e.g. choice_display: value|label) ride along so
  // the test can assert the SETTING controls the rendered output.
  for (const [k, v] of Object.entries(settings)) params[`input[staged_slot][${k}]`] = String(v);
  const res = await client._wp.get(
    '/wp-abilities/v1/abilities/gk-gravityview/view-field-render/run',
    { params },
  );
  const data = res.data ?? {};
  if (res.status !== 200) {
    const msg = data?.message || data?.code || JSON.stringify(data).slice(0, 160);
    return { ok: false, error: `HTTP ${res.status}: ${msg}` };
  }
  // Ability result may be the object itself or wrapped; tolerate both.
  const html = data.html ?? data?.result?.html ?? data?.data?.html;
  if (typeof html !== 'string') return { ok: false, error: `no html in response: ${JSON.stringify(data).slice(0, 160)}` };
  return { ok: true, html };
}

function assertRender(field, html) {
  for (const re of ERROR_MARKERS) {
    if (re.test(html)) return { pass: false, detail: `output contains an error marker (${re})` };
  }
  // The CELL CONTENT (inside the <td>/<th> wrapper) must be non-empty — an
  // empty cell means the field rendered nothing, which is NOT "properly
  // rendered". This holds even for `lenient` cases (they still must output
  // SOMETHING, e.g. signature's <img>); lenient only waives the substring pin.
  const inner = html.replace(/^\s*<t[dh][^>]*>/i, '').replace(/<\/t[dh]>\s*$/i, '').trim();
  if (inner === '') {
    return { pass: false, detail: `rendered an empty cell: ${html.replace(/\s+/g, ' ').trim().slice(0, 140)}` };
  }
  if (field.lenient) return { pass: true, detail: '' };
  const missing = (field.expect || []).filter((s) => !html.includes(s));
  if (missing.length) {
    return { pass: false, detail: `output missing ${JSON.stringify(missing)} — got: ${inner.slice(0, 140)}` };
  }
  return { pass: true, detail: '' };
}

async function main() {
  const args = parseArgs(process.argv);
  const fields = args.types ? FIELDS.filter((f) => args.types.includes(f.type)) : FIELDS;
  if (!fields.length) { console.error(`No field cases match --type ${args.types}`); process.exit(2); }

  let target;
  let mintedName = null;
  if (args.mint) {
    const prov = await provisionSite({ fresh: args.fresh, log: (m) => console.log(`[siteminter] ${m}`) });
    target = prov.target;
    mintedName = prov.name;
  } else {
    target = resolveTarget();
  }
  const client = makeClient(target);

  console.log(`\nField-output suite → ${target.baseUrl}`);
  console.log(`Fields: ${fields.length}\n`);

  let formId = 0;
  let viewId = 0;
  const results = [];
  try {
    // 1) One mega-form with every field type (sequential ids 1..N).
    const formFields = fields.map((f, i) => f.build(i + 1));
    const formRes = await client._gf.post('/forms', { title: `BENCH FieldOutput ${Date.now()}`, fields: formFields });
    formId = Number(formRes.data?.id ?? formRes.data);
    if (!formId) throw new Error(`form create failed (${formRes.status}): ${JSON.stringify(formRes.data).slice(0, 200)}`);

    // 2) One entry carrying a value for every field.
    const entryValues = Object.assign({}, ...fields.map((f, i) => f.value(i + 1)));
    await client.createEntry(formId, entryValues);

    // 3) A table View (directory zone = DIRECTORY_AREA) to render against.
    const view = await client.createView(formId, `BENCH FieldOutput View ${Date.now()}`, 'default_table');
    viewId = view.id;

    // 4) Render each field's output and assert.
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const fieldId = i + 1;
      let verdict;
      try {
        const r = await renderField(client, viewId, formId, fieldId, field.settings || {});
        verdict = r.ok ? assertRender(field, r.html) : { pass: false, detail: r.error };
      } catch (e) {
        verdict = { pass: false, detail: `threw: ${e?.message || e}` };
      }
      results.push({ type: field.type, label: field.label, ...verdict });
      console.log(`  ${verdict.pass ? '✓' : '✗'} ${field.type.padEnd(14)} ${verdict.pass ? '' : verdict.detail}`);
    }
  } finally {
    if (viewId) await client.deleteView(viewId);
    if (formId) await client.deleteForm(formId);
    if (mintedName && !args.keep) { try { destroySite(mintedName); } catch { /* best effort */ } }
    else if (mintedName) console.log(`\n[siteminter] keeping "${mintedName}".`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(60));
  if (failed.length) {
    console.log(`❌ FIELD OUTPUT: ${failed.length}/${results.length} field type(s) did not render properly:`);
    for (const f of failed) console.log(`   • ${f.type}: ${f.detail}`);
  } else {
    console.log(`✅ FIELD OUTPUT: all ${results.length} field types render properly.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`\nField-output suite crashed: ${e?.stack || e}\n`); process.exit(2); });
