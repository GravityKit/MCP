/**
 * Nested-forms FRONT-END output suite — deterministic, NOT AI-graded.
 *
 * The hardest GravityView display case: a PARENT View showing a GP Nested Forms
 * field must render the linked CHILD entries' values. This is only true on the
 * FRONT-END render — GravityView routes the `form` field through GF's
 * get_value_entry_detail (GP Nested Forms' nested-table renderer), which runs
 * in a real front-end request where the add-on is loaded. (The Inspector
 * single-field preview does NOT trigger it, so this suite renders the actual
 * published View page over HTTP.)
 *
 * Setup (all over real plugins on a minted site):
 *   1. Child form: Name (1) + Amount (2), with two child entries.
 *   2. Parent form: a nested-form field (gpnfForm → child form, gpnfFields) + a
 *      text field.
 *   3. A parent entry whose nested field holds the child entry ids, with the
 *      children linked back via GP Nested Forms' parent meta. The nested field's
 *      Summary Fields (gpnfFields) choose which child fields show — Name + Amount
 *      are chosen; Notes is not, so it must be excluded from the rendered table.
 *   4. A table View on the parent form, with the nested field added to the
 *      directory + single-entry columns.
 *   5. A published page embedding the View ([gravityview id=…]); FETCH the
 *      rendered page over HTTP and assert the CHILD values appear.
 *
 * Usage:
 *   node bench/nested-forms.mjs --mint [--keep] [--fresh] [--verbose]
 *
 * Exit: 0 output correct · 1 output wrong · 2 harness error (e.g. add-on absent).
 */

import { resolveTarget, SITEMINTER } from './config.mjs';
import { makeClient } from './lib/target.mjs';
import { provisionSite, destroySite, activePlugins, wpCli } from './lib/siteminter.mjs';

const SITE = process.env.BENCH_STORAGE_SITE || 'gvstore';
const ERROR_MARKERS = [/Fatal error/i, /call to a member function/i, /There has been a critical error/i];

// Child entries. Name + Amount are chosen as Summary Fields (must surface in
// the parent's nested table); Notes is NOT a Summary Field (must be excluded) —
// this proves the gpnfFields "Summary Fields" setting controls which child
// fields are shown.
const CHILD = [
  { name: 'Ada Lovelace', amount: '100', notes: 'note-alpha-hidden' },
  { name: 'Grace Hopper', amount: '200', notes: 'note-beta-hidden' },
];
// Child-form field ids chosen as Summary Fields (Name=1, Amount=2; NOT Notes=3).
const SUMMARY_FIELDS = ['1', '2'];

function parseArgs(argv) {
  const out = { mint: false, keep: false, fresh: false, verbose: false, keepFixtures: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mint') out.mint = true;
    else if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--fresh') out.fresh = true;
    else if (argv[i] === '--verbose') out.verbose = true;
    else if (argv[i] === '--keep-fixtures') { out.keepFixtures = true; out.keep = true; }
  }
  return out;
}

/** Add columns to a View area via the purpose-built view-field-add ability. */
async function addColumns(client, viewId, area, columns) {
  for (const col of columns) {
    const res = await client._wp.post('/wp-abilities/v1/abilities/gk-gravityview/view-field-add/run', {
      input: { id: viewId, area, field_id: String(col.field_id), label: col.label },
    });
    if (res.status !== 200) {
      throw new Error(`view-field-add ${col.field_id} → ${area} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
    }
  }
}

/** Plain front-end GET (no auth) — returns rendered HTML. */
async function fetchHtml(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'follow' });
  return { status: res.status, html: await res.text() };
}

async function main() {
  const args = parseArgs(process.argv);

  let target;
  let mintedName = null;
  let plugins = null;
  let sitePath = null;
  if (args.mint) {
    const prov = await provisionSite({
      fresh: args.fresh,
      name: SITE,
      plugins: [...SITEMINTER.plugins, ...SITEMINTER.addons],
      log: (m) => console.log(`[siteminter] ${m}`),
    });
    target = prov.target;
    mintedName = prov.name;
    sitePath = prov.path;
    plugins = activePlugins(prov.path);
  } else {
    target = resolveTarget();
  }
  const client = makeClient(target);

  console.log(`\nNested-forms FRONT-END suite → ${target.baseUrl}`);
  if (plugins) {
    for (const slug of ['gravityforms', 'GravityView', 'spellbook', 'gp-nested-forms']) {
      console.log(`  • ${slug} ${plugins[slug] || '(NOT ACTIVE)'}`);
    }
    // GP Nested Forms only renders the nested child table when the Spellbook
    // framework (formerly Gravity Perks) is active; without it the field falls
    // back to raw ids.
    const missing = ['spellbook', 'gp-nested-forms'].filter((slug) => !plugins[slug]);
    if (missing.length) {
      console.error(`\n✗ not active: ${missing.join(', ')} — cannot test nested-form output.`);
      if (mintedName && !args.keep) { try { destroySite(mintedName); } catch { /* best effort */ } }
      process.exit(2);
    }
  }

  let childFormId = 0;
  let parentFormId = 0;
  let viewId = 0;
  let pageId = 0;
  let parentEntryId = 0;
  let dirUrl = '';
  let singleUrl = '';
  let verdict = { pass: false, detail: 'did not run' };
  try {
    // 1) Child form + entries.
    const childRes = await client._gf.post('/forms', {
      title: `BENCH NF child ${Date.now()}`,
      fields: [
        { id: 1, type: 'text', label: 'Name' },
        { id: 2, type: 'number', label: 'Amount' },
        { id: 3, type: 'text', label: 'Notes' },
      ],
    });
    childFormId = Number(childRes.data?.id ?? childRes.data);
    if (!childFormId) throw new Error(`child form create failed: ${JSON.stringify(childRes.data).slice(0, 200)}`);
    const childEntryIds = [];
    for (const c of CHILD) childEntryIds.push(await client.createEntry(childFormId, { 1: c.name, 2: c.amount, 3: c.notes }));

    // 2) Parent form with a nested-form field pointing at the child form.
    const parentRes = await client._gf.post('/forms', {
      title: `BENCH NF parent ${Date.now()}`,
      fields: [
        { id: 1, type: 'form', label: 'Line Items', gpnfForm: String(childFormId), gpnfFields: SUMMARY_FIELDS },
        { id: 2, type: 'text', label: 'Customer' },
      ],
    });
    parentFormId = Number(parentRes.data?.id ?? parentRes.data);
    if (!parentFormId) throw new Error(`parent form create failed: ${JSON.stringify(parentRes.data).slice(0, 200)}`);

    // 3) Parent entry referencing the children.
    parentEntryId = await client.createEntry(parentFormId, { 1: childEntryIds.join(','), 2: 'Acme Corp' });

    // Mirror what a real GP Nested Forms submission persists, via entry meta.
    // Crucially this uses gform_update_meta — NOT a REST PUT /entries, which is
    // a full REPLACE that would wipe the child entries' field values.
    //   - parent linkage on each child (so GPNF treats them as nested children),
    //   - cleared `_gpnf_expiration` on all (GPNF filters `_gpnf_expiration=''`
    //     out of every GravityView query to hide unsubmitted child sessions),
    //   - approved parent (a default View shows only approved entries).
    if (sitePath) {
      for (const cid of childEntryIds) {
        wpCli(sitePath, ['eval',
          `gform_update_meta(${cid}, "gpnf_entry_parent", "${parentEntryId}");`
          + ` gform_update_meta(${cid}, "gpnf_entry_parent_form", "${parentFormId}");`
          + ` gform_update_meta(${cid}, "gpnf_entry_nested_form_field", "1");`]);
      }
      for (const id of [parentEntryId, ...childEntryIds]) {
        wpCli(sitePath, ['eval', `gform_update_meta(${id}, "_gpnf_expiration", "");`]);
      }
      wpCli(sitePath, ['eval', `gform_update_meta(${parentEntryId}, "is_approved", "1");`]);
    }

    // 4) A table View on the parent form with the nested field as a column.
    const view = await client.createView(parentFormId, `BENCH NF View ${Date.now()}`, 'default_table', 'publish');
    viewId = view.id;
    // Customer (2) is a plain text column — proves columns render at all; the
    // nested-form field (1) is the one whose child table we're checking. The
    // directory and single-entry contexts have SEPARATE field config, so add to
    // both: directory shows the child ids, single entry renders the child table.
    const columns = [
      { field_id: 2, label: 'Customer' },
      { field_id: 1, label: 'Line Items' },
    ];
    await addColumns(client, viewId, 'directory_table-columns', columns);
    await addColumns(client, viewId, 'single_table-columns', columns);

    // 5) Publish a page embedding the View, then FETCH both screens:
    //    - DIRECTORY (Multiple Entries): the nested field shows the child entry
    //      IDs (e.g. "25,26") — GravityView's expected directory behaviour.
    //    - SINGLE ENTRY: the nested field renders the child TABLE (the child
    //      entries' values), via GP Nested Forms' get_value_entry_detail.
    const pageRes = await client._wp.post('/wp/v2/pages', {
      title: `BENCH NF Page ${Date.now()}`,
      status: 'publish',
      content: `[gravityview id="${viewId}"]`,
    });
    pageId = Number(pageRes.data?.id);
    const pageLink = pageRes.data?.link;
    if (!pageId || !pageLink) throw new Error(`page create failed (${pageRes.status}): ${JSON.stringify(pageRes.data).slice(0, 200)}`);
    dirUrl = pageLink;
    // GravityView's single entry is the `entry` endpoint: /<page>/entry/<id>/
    // with pretty permalinks, or ?entry=<id> when the page URL is query-based.
    singleUrl = pageLink.includes('?')
      ? `${pageLink}&entry=${parentEntryId}`
      : `${pageLink.replace(/\/?$/, '/')}entry/${parentEntryId}/`;

    const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };
    const dir = await fetchHtml(target.baseUrl, pathOf(dirUrl));
    const single = await fetchHtml(target.baseUrl, pathOf(singleUrl));
    const ids = childEntryIds.join(',');
    const summaryVals = [CHILD[0].name, CHILD[1].name, CHILD[0].amount, CHILD[1].amount]; // chosen Summary Fields
    const excludedVals = [CHILD[0].notes, CHILD[1].notes]; // NOT a Summary Field

    if (args.verbose) {
      const region = (h) => {
        const flat = h.replace(/\s+/g, ' ');
        const m = flat.match(/<(?:div|table)[^>]*(?:gv-container|gravityview|gv-table|gv-list|gv-single)[\s\S]{0,2000}/i);
        if (m) return m[0];
        const ec = flat.match(/entry-content[\s\S]{0,1200}/i);
        return ec ? `(no gv markup) ${ec[0]}` : '(no gv markup / no entry-content)';
      };
      console.log(`\n--- DIRECTORY (${dir.status}) ---\n${region(dir.html)}\n--- SINGLE ENTRY (${single.status}) ---\n${region(single.html)}\n--- end ---`);
      console.log(`probes: dir[Acme=${dir.html.includes('Acme Corp') ? 'Y' : 'N'} ids="${ids}"=${dir.html.includes(ids) ? 'Y' : 'N'}] single[Ada=${single.html.includes(CHILD[0].name) ? 'Y' : 'N'} Grace=${single.html.includes(CHILD[1].name) ? 'Y' : 'N'} gpnf=${/gpnf|nested-entries/i.test(single.html) ? 'Y' : 'N'} Notes-excluded=${excludedVals.every((v) => !single.html.includes(v)) ? 'Y' : 'N'}]\n`);
    }

    const dirErr = ERROR_MARKERS.find((re) => re.test(dir.html));
    const singleErr = ERROR_MARKERS.find((re) => re.test(single.html));
    const missing = summaryVals.filter((v) => !single.html.includes(v));
    const leaked = excludedVals.filter((v) => single.html.includes(v)); // Notes must NOT render
    if (dir.status !== 200 || single.status !== 200) verdict = { pass: false, detail: `HTTP dir=${dir.status} single=${single.status}` };
    else if (dirErr || singleErr) verdict = { pass: false, detail: `error marker (${dirErr || singleErr})` };
    else if (!dir.html.includes('Acme Corp')) verdict = { pass: false, detail: 'directory did not render the parent entry' };
    else if (!dir.html.includes(ids)) verdict = { pass: false, detail: `directory did not show the child ids "${ids}"` };
    else if (missing.length) verdict = { pass: false, detail: `single entry missing Summary Field values ${JSON.stringify(missing)}` };
    else if (leaked.length) verdict = { pass: false, detail: `single entry leaked non-Summary fields (Notes) ${JSON.stringify(leaked)} — Summary Fields not honored` };
    else verdict = { pass: true, detail: `directory shows ids "${ids}"; single entry renders Summary Fields (Name+Amount) and excludes Notes` };
  } catch (e) {
    verdict = { pass: false, detail: `threw: ${e?.message || e}` };
  } finally {
    if (!args.keepFixtures) {
      if (pageId) { try { await client._wp.delete(`/wp/v2/pages/${pageId}`, { params: { force: true } }); } catch { /* best effort */ } }
      if (viewId) await client.deleteView(viewId);
      if (parentFormId) await client.deleteForm(parentFormId);
      if (childFormId) await client.deleteForm(childFormId);
    }
    if (mintedName && !args.keep) { try { destroySite(mintedName); } catch { /* best effort */ } }
    else if (mintedName) console.log(`\n[siteminter] keeping "${mintedName}".`);
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`  ${verdict.pass ? '✓' : '✗'} nested-form front-end output  ${verdict.detail}`);
  if (args.keepFixtures && dirUrl) {
    console.log('\nFixtures kept — open these on the live test site:');
    console.log(`  Directory (Multiple Entries, shows child ids): ${dirUrl}`);
    console.log(`  Single Entry (shows the nested child table):    ${singleUrl}`);
  }
  console.log(verdict.pass ? '✅ NESTED FORMS: directory shows ids, single entry shows the child table.' : '❌ NESTED FORMS: output is wrong.');
  process.exit(verdict.pass ? 0 : 1);
}

main().catch((e) => { console.error(`\nNested-forms suite crashed: ${e?.stack || e}\n`); process.exit(2); });
