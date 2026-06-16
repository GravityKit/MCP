/**
 * Live end-to-end tests against a REAL Gravity Forms site.
 *
 * Self-contained + repeatable: it creates its own throwaway forms and entries
 * through the MCP client, runs the gf_list_entries / validate / search contract
 * against the actual GF REST API, then deletes everything it created in a
 * finally block. It never reads or mutates data it didn't create, so it is safe
 * to run any number of times against any GF site (no manual seeding, no
 * hard-coded ids/counts).
 *
 * Run (skips cleanly when LIVE_GF_URL is unset, so offline CI is unaffected):
 *
 *   LIVE_GF_URL=http://localhost:8897 LIVE_GF_USER=admin \
 *   LIVE_GF_PW='xxxx xxxx xxxx xxxx xxxx xxxx' npm run test:live
 *
 * Optional: LIVE_SEED_COUNT (active entries in form A, default 55),
 *           LIVE_PAGE_SIZE (default 25).
 */

import GravityFormsClient from '../../src/gravity-forms-client.js';

const URL = process.env.LIVE_GF_URL;
if (!URL) {
  console.error('LIVE_GF_URL not set — skipping live tests (offline CI is unaffected).');
  process.exit(0);
}

const N = Number(process.env.LIVE_SEED_COUNT || 55);   // active entries in form A
const M = 10;                                           // entries in form B (multi-form)
const PAGE = Number(process.env.LIVE_PAGE_SIZE || 25);
const STAMP = `${Date.now()}-${process.pid}`;          // unique per run

const client = new GravityFormsClient({
  GRAVITY_FORMS_BASE_URL: URL,
  GRAVITY_FORMS_CONSUMER_KEY: process.env.LIVE_GF_USER || 'admin',
  GRAVITY_FORMS_CONSUMER_SECRET: process.env.LIVE_GF_PW || '',
  GRAVITY_FORMS_ALLOW_DELETE: 'true',
});

// --- tiny harness ---
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); pass++; results.push(`  ✅ ${name}`); }
  catch (e) { fail++; results.push(`  ❌ ${name}\n       ${e.message}`); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'expected equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const ids = (r) => r.entries.map((e) => Number(e.id));
const idOf = (v) => Number(v && typeof v === 'object' ? v.id : v);

// --- self-seeding setup / teardown (dogfoods create + delete) ---
const created = { forms: [] };
let formA, formB, activeIds = [], trashedId;

async function createForm(title) {
  const r = await client.createForm({ title, fields: [{ id: 1, type: 'text', label: 'Name', isRequired: true }] });
  const id = idOf(r.form);
  ok(Number.isInteger(id) && id > 0, `createForm did not return a usable id (got ${JSON.stringify(r.form)})`);
  created.forms.push(id);
  return id;
}
async function addEntry(formId, value) {
  const r = await client.createEntry({ form_id: formId, '1': value });
  return idOf(r.entry);
}

async function setup() {
  formA = await createForm(`MCP Live A ${STAMP}`);
  formB = await createForm(`MCP Live B ${STAMP}`);
  for (let i = 1; i <= N; i++) activeIds.push(await addEntry(formA, `A${i}`));
  for (let i = 1; i <= M; i++) await addEntry(formB, `B${i}`);
  trashedId = await addEntry(formA, 'trashed');
  await client.deleteEntry({ id: trashedId });   // force defaults false → trashes it
}

async function teardown() {
  for (const id of created.forms) {
    try { await client.deleteForm({ id, force: true }); } catch { /* best effort */ }
  }
}

// --- the tests, all relative to what we created ---
async function run() {
  await check(`default page returns 10 of ${N} (total_count accurate)`, async () => {
    const r = await client.listEntries({ form_ids: [formA] });
    eq(r.entries.length, Math.min(10, N), 'default page size');
    eq(r.total_count, N, 'total_count');
  });

  await check('pagination walks every page with NO repeats (covers each entry once)', async () => {
    const pages = Math.ceil(N / PAGE);
    const seen = [];
    for (let p = 1; p <= pages; p++) {
      const r = await client.listEntries({ form_ids: [formA], paging: { page_size: PAGE, current_page: p } });
      seen.push(...ids(r));
    }
    eq(seen.length, N, 'rows summed across pages');
    eq(new Set(seen).size, N, 'all unique — paging actually advanced (the #4 bug)');
  });

  await check('sorting id ASC vs DESC actually reorders', async () => {
    const asc = await client.listEntries({ form_ids: [formA], sorting: { key: 'id', direction: 'ASC', is_numeric: true }, paging: { page_size: 5 } });
    const desc = await client.listEntries({ form_ids: [formA], sorting: { key: 'id', direction: 'DESC', is_numeric: true }, paging: { page_size: 5 } });
    const a = ids(asc), d = ids(desc);
    ok(a[0] < a[a.length - 1], `ASC not ascending: ${a}`);
    ok(d[0] > d[d.length - 1], `DESC not descending: ${d}`);
    ok(a[0] !== d[0], 'ASC and DESC returned the same first row');
  });

  await check('include returns the TRASHED entry (any status) — a field_filter could not', async () => {
    const r = await client.listEntries({ include: [trashedId] });
    eq(r.entries.length, 1, 'one entry');
    eq(Number(r.entries[0].id), trashedId, 'the trashed id');
    eq(r.entries[0].status, 'trash', 'status trash');
  });

  await check('include multiple ids returns exactly those', async () => {
    const want = activeIds.slice(0, 3);
    const r = await client.listEntries({ include: want });
    eq(r.entries.length, 3, 'three entries');
    ok(want.every((id) => ids(r).includes(id)), 'all requested ids present');
  });

  await check('exclude removes the id from the active result set', async () => {
    const drop = activeIds[0];
    const r = await client.listEntries({ form_ids: [formA], exclude: [drop], paging: { page_size: N + 50 } });
    eq(r.entries.length, N - 1, `${N} active minus 1 excluded`);
    ok(!ids(r).includes(drop), 'excluded id absent');
  });

  await check('form_ids [A,B] returns entries from BOTH forms', async () => {
    const r = await client.listEntries({ form_ids: [formA, formB], paging: { page_size: N + M + 50 } });
    eq(r.total_count, N + M, 'A + B counts');
    const forms = new Set(r.entries.map((e) => Number(e.form_id)));
    ok(forms.has(formA) && forms.has(formB), `both forms present: ${[...forms]}`);
  });

  await check('validateSubmission does NOT create an entry (P0)', async () => {
    const before = (await client.listEntries({ form_ids: [formA] })).total_count;
    const res = await client.validateSubmission({ form_id: formA, input_1: 'validation probe' });
    ok(typeof res.valid === 'boolean', 'returns a boolean valid');
    ok(!('field_errors' in res), 'no phantom field_errors');
    const after = (await client.listEntries({ form_ids: [formA] })).total_count;
    eq(after, before, 'entry count unchanged after validation');
  });

  await check('search field_filter id IN [array] matches multiple (array not flattened)', async () => {
    const want = activeIds.slice(0, 3);
    const r = await client.listEntries({
      form_ids: [formA],
      search: { field_filters: [{ key: 'id', operator: 'in', value: want }] },
      paging: { page_size: 200 },
    });
    eq(r.entries.length, 3, 'three matches for IN [array]');
  });

  await check('validateSubmission on an INVALID submission returns messages (does not throw)', async () => {
    // form A field 1 is required → empty value is invalid. The fix must return
    // GF's 400 {is_valid:false, validation_messages} instead of throwing.
    const res = await client.validateSubmission({ form_id: formA, input_1: '' });
    eq(res.valid, false, 'empty required field → invalid');
    ok(res.validation_messages && typeof res.validation_messages === 'object', 'validation_messages is a map');
    ok(Object.keys(res.validation_messages).length > 0, 'at least one field message present');
  });

  await check('search mode:any does OR across field_filters (the mode fix)', async () => {
    const r = await client.listEntries({
      form_ids: [formA],
      search: { mode: 'any', field_filters: [{ key: '1', value: 'A1', operator: '=' }, { key: '1', value: 'A2', operator: '=' }] },
      paging: { page_size: 50 },
    });
    eq(r.entries.length, 2, 'A1 OR A2 → exactly 2 entries (AND would give 0)');
  });
}

console.log(`\n🌐 Live GF tests against ${URL} (seeding ${N}+${M}+1 entries, page size ${PAGE})\n`);
let setupError;
try {
  await setup();
  await run();
} catch (e) {
  setupError = e;
} finally {
  await teardown();
}
if (setupError) {
  console.error(`\n❌ Live setup/run crashed before completion: ${setupError.message}\n`);
  process.exit(1);
}
console.log(results.join('\n'));
console.log(`\n${fail === 0 ? '✅' : '❌'} Live: ${pass} passed, ${fail} failed (cleaned up ${created.forms.length} forms)\n`);
process.exit(fail === 0 ? 0 : 1);
