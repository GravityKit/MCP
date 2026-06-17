/**
 * Field-storage cases — one (or more, for variants) per Gravity Forms field
 * type. The runner (field-storage.mjs) builds a form from `build(id)`, seeds an
 * entry over GF REST (`seed`), reads it back, and asserts the STORED shape.
 *
 * Because the MCP's gf_create_entry is a RAW IMPORT (GFAPI::add_entry stores
 * values verbatim, bypassing get_value_save_entry), a round-trip here validates
 * exactly the contract the registry + inputHints describe: the shape a caller
 * should PASS. Assertions encode the true GF stored shape (verified against GF
 * source), so this suite doubles as a regression guard for the field model.
 *
 * Compound fields are built through the MCP's OWN FieldManager.generateSubInputs
 * (not hand-written inputs), so the suite proves the structure our code emits is
 * one GF accepts and round-trips.
 *
 * Case shape:
 *   type      — registry field type key (also the --type filter key)
 *   variant   — optional label when a type has multiple cases
 *   addon     — required add-on slug; case is skipped (not faked) if absent
 *   novalue   — true for layout/no-storage types: assert the field is created,
 *               no entry value expected
 *   via       — optional note: the field was built through this MCP code path
 *   guards    — optional note: what stored behaviour this case pins
 *   build(id) — the form's `fields` array (id is the field id to use)
 *   seed(formId, client, id) — create the entry; return its id (or null)
 *   assert(entry, form, id) — { pass, detail } against the stored entry
 *   note      — optional annotation printed on pass (e.g. source-validated facts)
 */

import { FieldManager } from '../src/field-operations/field-manager.js';
import { fieldRegistry } from '../src/field-definitions/field-registry.js';

const fm = new FieldManager(null, fieldRegistry, { getWarnings: () => [] });

/** Build a compound field's inputs via the ACTUAL code under test. */
function genInputs(field) {
  return fm.generateSubInputs(field, { storage: { type: 'compound' } });
}

const choices = (pairs) => pairs.map(([text, value]) => (value === undefined ? { text, value: text } : { text, value }));

// Helpers for terse asserts.
const isStr = (v) => typeof v === 'string';
const eq = (v, want) => v === want;
const has = (v, sub) => isStr(v) && v.includes(sub);

export const CASES = [
  // ─── Standard string fields ───────────────────────────────────────────────
  {
    type: 'text',
    build: (id) => [{ id, type: 'text', label: 'Single Line' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Hello World' }),
    assert: (e, _f, id) => (eq(e[id], 'Hello World')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'textarea',
    build: (id) => [{ id, type: 'textarea', label: 'Paragraph' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Line one\nLine two' }),
    assert: (e, _f, id) => (has(e[id], 'Line one')
      ? { pass: true, detail: 'multiline string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'email',
    build: (id) => [{ id, type: 'email', label: 'Email' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'ada@example.com' }),
    assert: (e, _f, id) => (eq(e[id], 'ada@example.com')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'phone',
    build: (id) => [{ id, type: 'phone', label: 'Phone' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: '(555) 867-5309' }),
    assert: (e, _f, id) => (has(e[id], '867-5309')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'website',
    build: (id) => [{ id, type: 'website', label: 'Website' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'https://example.com/path' }),
    assert: (e, _f, id) => (has(e[id], 'example.com')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'hidden',
    build: (id) => [{ id, type: 'hidden', label: 'Hidden' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'secret-token' }),
    assert: (e, _f, id) => (eq(e[id], 'secret-token')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'number',
    guards: 'numbers are stored as strings',
    build: (id) => [{ id, type: 'number', label: 'Number' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: '42' }),
    assert: (e, _f, id) => (isStr(e[id]) && eq(e[id], '42')
      ? { pass: true, detail: 'stored as string "42"' }
      : { pass: false, detail: `expected string "42", got ${typeof e[id]} ${JSON.stringify(e[id])}` }),
  },

  // ─── Choice fields (storage = the choice VALUE) ────────────────────────────
  {
    type: 'select',
    variant: 'value set',
    guards: 'entry stores the choice value when one is set',
    build: (id) => [{
      id,
      type: 'select',
      label: 'Dept',
      enableChoiceValue: true,
      choices: choices([['Engineering', 'eng'], ['Design', 'design']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'eng' }),
    assert: (e, _f, id) => (eq(e[id], 'eng')
      ? { pass: true, detail: 'stored the choice value' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'select',
    variant: 'label-as-value',
    guards: 'with no explicit value, the label text is the value',
    build: (id) => [{
      id,
      type: 'select',
      label: 'Color',
      choices: choices([['Red'], ['Green']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Red' }),
    assert: (e, _f, id) => (eq(e[id], 'Red')
      ? { pass: true, detail: 'stored label-as-value' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'radio',
    build: (id) => [{
      id,
      type: 'radio',
      label: 'Seniority',
      choices: choices([['Junior'], ['Senior']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Senior' }),
    assert: (e, _f, id) => (eq(e[id], 'Senior')
      ? { pass: true, detail: 'stored the selected value' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'checkbox',
    guards: 'each selection lands in its sub-input (N.1, N.2…)',
    build: (id) => [{
      id,
      type: 'checkbox',
      label: 'Perks',
      choices: choices([['Remote'], ['Equity'], ['Learning']]),
      inputs: [
        { id: `${id}.1`, label: 'Remote' },
        { id: `${id}.2`, label: 'Equity' },
        { id: `${id}.3`, label: 'Learning' },
      ],
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.1`]: 'Remote', [`${id}.3`]: 'Learning' }),
    assert: (e, _f, id) => (eq(e[`${id}.1`], 'Remote') && eq(e[`${id}.3`], 'Learning')
      ? { pass: true, detail: 'per-choice sub-inputs N.1/N.3 stored' }
      : { pass: false, detail: `1=${JSON.stringify(e[`${id}.1`])} 3=${JSON.stringify(e[`${id}.3`])}` }),
  },
  {
    type: 'multiselect',
    build: (id) => [{
      id,
      type: 'multiselect',
      label: 'Skills',
      choices: choices([['PHP'], ['JavaScript'], ['Go']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: ['PHP', 'Go'] }),
    assert: (e, _f, id) => {
      const v = Array.isArray(e[id]) ? e[id].join(',') : String(e[id] ?? '');
      return has(v, 'PHP') && has(v, 'Go')
        ? { pass: true, detail: `stored multi-value (${JSON.stringify(e[id])})` }
        : { pass: false, detail: `got ${JSON.stringify(e[id])}` };
    },
  },
  {
    type: 'list',
    variant: 'single-column',
    build: (id) => [{ id, type: 'list', label: 'Items' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: ['Apple', 'Banana'] }),
    assert: (e, _f, id) => {
      const v = JSON.stringify(e[id] ?? '');
      return v.includes('Apple') && v.includes('Banana')
        ? { pass: true, detail: `serialized list (${v.slice(0, 60)})` }
        : { pass: false, detail: `got ${v}` };
    },
  },
  {
    type: 'list',
    variant: 'multi-column',
    build: (id) => [{
      id,
      type: 'list',
      label: 'Work',
      enableColumns: true,
      choices: choices([['Employer'], ['Role']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: [{ Employer: 'Acme', Role: 'Engineer' }] }),
    assert: (e, _f, id) => {
      const v = JSON.stringify(e[id] ?? '');
      return v.includes('Acme') && v.includes('Engineer')
        ? { pass: true, detail: 'multi-column row stored' }
        : { pass: false, detail: `got ${v.slice(0, 80)}` };
    },
  },

  // ─── Compound fields (built via the MCP's FieldManager) ────────────────────
  {
    type: 'name',
    via: 'FieldManager.generateSubInputs',
    build: (id) => [{
      id,
      type: 'name',
      label: 'Full Name',
      nameFormat: 'advanced',
      inputs: genInputs({ id, type: 'name', nameFormat: 'advanced' }),
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.3`]: 'Ada', [`${id}.6`]: 'Lovelace' }),
    assert: (e, _f, id) => (eq(e[`${id}.3`], 'Ada') && eq(e[`${id}.6`], 'Lovelace')
      ? { pass: true, detail: '.3 First / .6 Last stored' }
      : { pass: false, detail: `3=${JSON.stringify(e[`${id}.3`])} 6=${JSON.stringify(e[`${id}.6`])}` }),
  },
  {
    type: 'address',
    via: 'FieldManager.generateSubInputs',
    guards: 'all six sub-inputs N.1–N.6 round-trip',
    build: (id) => [{
      id,
      type: 'address',
      label: 'Location',
      inputs: genInputs({ id, type: 'address', addressType: 'us' }),
    }],
    seed: (f, c, id) => c.createEntry(f, {
      [`${id}.1`]: '1 Infinite Loop',
      [`${id}.2`]: 'Suite 100',
      [`${id}.3`]: 'Cupertino',
      [`${id}.4`]: 'CA',
      [`${id}.5`]: '95014',
      [`${id}.6`]: 'USA',
    }),
    assert: (e, _f, id) => {
      const want = { 1: '1 Infinite Loop', 2: 'Suite 100', 3: 'Cupertino', 4: 'CA', 5: '95014', 6: 'USA' };
      const miss = Object.entries(want).filter(([k, v]) => e[`${id}.${k}`] !== v).map(([k]) => `.${k}`);
      return miss.length
        ? { pass: false, detail: `wrong/missing ${miss.join(',')}` }
        : { pass: true, detail: 'all six sub-inputs N.1–N.6 (incl. .2 Line2 + .6 Country)' };
    },
  },
  {
    type: 'consent',
    build: (id) => [{
      id,
      type: 'consent',
      label: 'Agree',
      checkboxLabel: 'I agree',
      inputs: [
        { id: `${id}.1`, label: 'Consent' },
        { id: `${id}.2`, label: 'Text' },
        { id: `${id}.3`, label: 'Revision' },
      ],
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.1`]: '1', [`${id}.2`]: 'I agree', [`${id}.3`]: '1' }),
    assert: (e, _f, id) => (eq(e[`${id}.1`], '1') && has(e[`${id}.2`], 'agree')
      ? { pass: true, detail: '.1 checked / .2 text stored' }
      : { pass: false, detail: `1=${JSON.stringify(e[`${id}.1`])} 2=${JSON.stringify(e[`${id}.2`])}` }),
  },
  {
    type: 'creditcard',
    via: 'FieldManager.generateSubInputs',
    guards: 'sub-input labels (.4 Card Type, .5 Cardholder Name); .1/.4 round-trip',
    build: (id) => [{
      id,
      type: 'creditcard',
      label: 'Card',
      inputs: genInputs({ id, type: 'creditcard' }),
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.1`]: 'XXXXXXXXXXXX1111', [`${id}.4`]: 'Visa' }),
    assert: (e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      const byId = Object.fromEntries((field?.inputs || []).map((i) => [String(i.id), i.label]));
      const labelsOk = byId[`${id}.4`] === 'Card Type' && byId[`${id}.5`] === 'Cardholder Name';
      if (!labelsOk) {
        return { pass: false, detail: `labels .4=${byId[`${id}.4`]} .5=${byId[`${id}.5`]} (expected Card Type / Cardholder Name)` };
      }
      return eq(e[`${id}.1`], 'XXXXXXXXXXXX1111') && eq(e[`${id}.4`], 'Visa')
        ? { pass: true, detail: '.4/.5 labels correct; .1/.4 round-trip' }
        : { pass: false, detail: `1=${JSON.stringify(e[`${id}.1`])} 4=${JSON.stringify(e[`${id}.4`])}` };
    },
    note: 'On submission GF persists only .1 (masked) and .4 (card type); .2/.3/.5 are not stored (source-validated).',
  },
  {
    type: 'chainedselect',
    addon: 'gravityformschainedselects',
    via: 'FieldManager.generateSubInputs',
    guards: 'one sub-input per level; per-level values round-trip',
    build: (id) => [{
      id,
      type: 'chainedselect',
      label: 'Vehicle',
      inputs: genInputs({ id, type: 'chainedselect', inputs: [{ label: 'Make' }, { label: 'Model' }] }),
      choices: [
        { text: 'Ford', value: 'Ford', choices: [{ text: 'Focus', value: 'Focus' }] },
        { text: 'Toyota', value: 'Toyota', choices: [{ text: 'Corolla', value: 'Corolla' }] },
      ],
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.1`]: 'Ford', [`${id}.2`]: 'Focus' }),
    assert: (e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      const ids = (field?.inputs || []).map((i) => String(i.id));
      if (ids.join(',') !== `${id}.1,${id}.2`) {
        return { pass: false, detail: `inputs [${ids}] expected [${id}.1,${id}.2]` };
      }
      return eq(e[`${id}.1`], 'Ford') && eq(e[`${id}.2`], 'Focus')
        ? { pass: true, detail: 'real add-on accepted 2 generated levels; per-level stored' }
        : { pass: false, detail: `1=${JSON.stringify(e[`${id}.1`])} 2=${JSON.stringify(e[`${id}.2`])}` };
    },
  },

  // ─── Date / Time ───────────────────────────────────────────────────────────
  {
    type: 'date',
    guards: 'stored as ISO YYYY-MM-DD independent of display format',
    build: (id) => [{ id, type: 'date', label: 'When', dateFormat: 'mdy' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: '2026-06-17' }),
    assert: (e, _f, id) => (eq(e[id], '2026-06-17')
      ? { pass: true, detail: 'stored ISO YYYY-MM-DD (display format is mdy)' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'time',
    build: (id) => [{ id, type: 'time', label: 'Preferred', timeFormat: '12' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: '12:30 pm' }),
    assert: (e, _f, id) => (has(e[id], '12') && has(e[id], '30')
      ? { pass: true, detail: `stored at the field id (${JSON.stringify(e[id])})` }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },

  // ─── File upload (variant-aware storage) ───────────────────────────────────
  {
    type: 'fileupload',
    variant: 'single',
    build: (id) => [{ id, type: 'fileupload', label: 'Resume' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'https://example.com/uploads/resume.pdf' }),
    assert: (e, _f, id) => (has(e[id], 'resume.pdf')
      ? { pass: true, detail: 'single → bare URL string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'fileupload',
    variant: 'multiple (JSON)',
    guards: 'multipleFiles → JSON array of URLs',
    build: (id) => [{ id, type: 'fileupload', label: 'Docs', multipleFiles: true }],
    seed: (f, c, id) => c.createEntry(f, { [id]: JSON.stringify(['https://example.com/a.pdf', 'https://example.com/b.pdf']) }),
    assert: (e, _f, id) => {
      let arr;
      try { arr = JSON.parse(e[id]); } catch { arr = null; }
      return Array.isArray(arr) && arr.length === 2
        ? { pass: true, detail: 'multiple → JSON array of 2 URLs' }
        : { pass: false, detail: `expected JSON array, got ${JSON.stringify(e[id])}` };
    },
  },

  // ─── Post fields ────────────────────────────────────────────────────────────
  {
    type: 'post_title',
    build: (id) => [{ id, type: 'post_title', label: 'Title' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'My Post Title' }),
    assert: (e, _f, id) => (eq(e[id], 'My Post Title')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'post_content',
    guards: "field type 'post_content' resolves; string round-trip",
    build: (id) => [{ id, type: 'post_content', label: 'Body' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Post body text.' }),
    assert: (e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      if (!field || field.type !== 'post_content') {
        return { pass: false, detail: `GF did not keep type post_content (got ${field?.type})` };
      }
      return eq(e[id], 'Post body text.')
        ? { pass: true, detail: "type 'post_content' accepted; string round-trip" }
        : { pass: false, detail: `got ${JSON.stringify(e[id])}` };
    },
  },
  {
    type: 'post_excerpt',
    build: (id) => [{ id, type: 'post_excerpt', label: 'Excerpt' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Short excerpt.' }),
    assert: (e, _f, id) => (eq(e[id], 'Short excerpt.')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'post_tags',
    build: (id) => [{ id, type: 'post_tags', label: 'Tags' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'news, updates' }),
    assert: (e, _f, id) => (has(e[id], 'news')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'post_image',
    guards: 'stored as |:|-delimited 5-part composite',
    build: (id) => [{ id, type: 'post_image', label: 'Image' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'https://example.com/x.jpg|:|Title|:|Caption|:|Desc|:|Alt' }),
    assert: (e, _f, id) => (has(e[id], '|:|') && has(e[id], 'x.jpg')
      ? { pass: true, detail: 'stored as |:|-delimited composite' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'post_custom_field',
    build: (id) => [{ id, type: 'post_custom_field', label: 'Meta', postCustomFieldName: 'my_key' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'custom value' }),
    assert: (e, _f, id) => (eq(e[id], 'custom value')
      ? { pass: true, detail: 'string round-trip' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },

  // ─── Pricing ──────────────────────────────────────────────────────────────
  {
    type: 'product',
    variant: 'singleproduct',
    build: (id) => [{
      id,
      type: 'product',
      label: 'Plan',
      inputType: 'singleproduct',
      basePrice: '$10.00',
      inputs: [
        { id: `${id}.1`, label: 'Name' },
        { id: `${id}.2`, label: 'Price' },
        { id: `${id}.3`, label: 'Quantity' },
      ],
    }],
    seed: (f, c, id) => c.createEntry(f, { [`${id}.1`]: 'Pro Plan', [`${id}.2`]: '$10.00', [`${id}.3`]: '1' }),
    assert: (e, _f, id) => (has(e[`${id}.1`], 'Pro Plan') && has(e[`${id}.2`], '10')
      ? { pass: true, detail: '.1 name / .2 price / .3 qty stored' }
      : { pass: false, detail: `1=${JSON.stringify(e[`${id}.1`])} 2=${JSON.stringify(e[`${id}.2`])}` }),
  },
  {
    type: 'product',
    variant: 'price (user-defined)',
    guards: 'User Defined Price → single string under the field id',
    build: (id) => [{ id, type: 'product', label: 'Donation', inputType: 'price' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: '$25.00' }),
    assert: (e, _f, id) => (has(e[id], '25') && !e[`${id}.1`]
      ? { pass: true, detail: 'single price string under field id' }
      : { pass: false, detail: `id=${JSON.stringify(e[id])} .1=${JSON.stringify(e[`${id}.1`])}` }),
  },
  {
    type: 'quantity',
    guards: 'quantity is stored as a string',
    build: (id) => [
      {
        id: 10,
        type: 'product',
        label: 'Widget',
        inputType: 'singleproduct',
        basePrice: '$10.00',
        inputs: [
          { id: '10.1', label: 'Name' },
          { id: '10.2', label: 'Price' },
          { id: '10.3', label: 'Quantity' },
        ],
      },
      { id, type: 'quantity', label: 'Qty', productField: 10 },
    ],
    seed: (f, c, id) => c.createEntry(f, { '10.1': 'Widget', '10.2': '$10.00', [id]: '3' }),
    assert: (e, _f, id) => (isStr(e[id]) && eq(e[id], '3')
      ? { pass: true, detail: 'stored as string "3"' }
      : { pass: false, detail: `expected string "3", got ${typeof e[id]} ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'option',
    build: (id) => [
      {
        id: 10,
        type: 'product',
        label: 'Base',
        inputType: 'singleproduct',
        basePrice: '$10.00',
        inputs: [
          { id: '10.1', label: 'Name' },
          { id: '10.2', label: 'Price' },
          { id: '10.3', label: 'Quantity' },
        ],
      },
      {
        id,
        type: 'option',
        label: 'Add-on',
        productField: 10,
        inputType: 'select',
        choices: choices([['Gift Wrap|5.00', 'Gift Wrap|5.00']]),
      },
    ],
    seed: (f, c, id) => c.createEntry(f, { '10.1': 'Base', '10.2': '$10.00', [id]: 'Gift Wrap|5.00' }),
    assert: (e, _f, id) => (has(e[id], 'Gift Wrap') && has(e[id], '5.00')
      ? { pass: true, detail: 'stored "Label|price"' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'shipping',
    build: (id) => [{
      id,
      type: 'shipping',
      label: 'Shipping',
      inputType: 'select',
      choices: choices([['Ground|7.50', 'Ground|7.50']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'Ground|7.50' }),
    assert: (e, _f, id) => (has(e[id], '7.50')
      ? { pass: true, detail: 'stored "Method|price"' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'total',
    build: (id) => [
      {
        id: 10,
        type: 'product',
        label: 'Item',
        inputType: 'singleproduct',
        basePrice: '$10.00',
        inputs: [
          { id: '10.1', label: 'Name' },
          { id: '10.2', label: 'Price' },
          { id: '10.3', label: 'Quantity' },
        ],
      },
      { id, type: 'total', label: 'Total' },
    ],
    seed: (f, c, id) => c.createEntry(f, { '10.1': 'Item', '10.2': '$10.00', [id]: '10.00' }),
    assert: (e, _f, id) => (has(e[id], '10')
      ? { pass: true, detail: 'numeric total stored as string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },

  // ─── Add-on: Survey / Quiz / Poll ───────────────────────────────────────────
  {
    type: 'survey',
    variant: 'text inputType',
    addon: 'gravityformssurvey',
    build: (id) => [{ id, type: 'survey', label: 'Why?', inputType: 'text' }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'I love hard problems' }),
    assert: (e, _f, id) => (has(e[id], 'hard problems')
      ? { pass: true, detail: 'text survey → string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'survey_rank',
    addon: 'gravityformssurvey',
    guards: 'comma-joined ranked values in one string',
    build: (id) => [{
      id,
      type: 'survey',
      inputType: 'rank',
      label: 'Priorities',
      choices: choices([['Speed', 'speedval'], ['Price', 'priceval'], ['Quality', 'qualityval']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'qualityval,speedval,priceval' }),
    assert: (e, _f, id) => (eq(e[id], 'qualityval,speedval,priceval')
      ? { pass: true, detail: 'comma-joined ranked order (one string)' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'survey_rating',
    addon: 'gravityformssurvey',
    build: (id) => [{
      id,
      type: 'survey',
      inputType: 'rating',
      label: 'Rate us',
      choices: choices([['Bad', 'rate1'], ['OK', 'rate2'], ['Great', 'rate3']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'rate3' }),
    assert: (e, _f, id) => (eq(e[id], 'rate3')
      ? { pass: true, detail: 'single rating value stored' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'survey_likert',
    addon: 'gravityformssurvey',
    build: (id) => [{
      id,
      type: 'survey',
      inputType: 'likert',
      label: 'Agreement',
      choices: choices([['Disagree', 'col1'], ['Neutral', 'col2'], ['Agree', 'col3']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'col3' }),
    assert: (e, _f, id) => (eq(e[id], 'col3')
      ? { pass: true, detail: 'single-row likert → column token string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'quiz',
    addon: 'gravityformsquiz',
    build: (id) => [{
      id,
      type: 'quiz',
      label: 'Capital of France?',
      inputType: 'radio',
      choices: [
        { text: 'Paris', value: 'gquizParis', isCorrect: true },
        { text: 'Lyon', value: 'gquizLyon', isCorrect: false },
      ],
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'gquizParis' }),
    assert: (e, _f, id) => (eq(e[id], 'gquizParis')
      ? { pass: true, detail: 'radio quiz → single token string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },
  {
    type: 'poll',
    addon: 'gravityformspolls',
    build: (id) => [{
      id,
      type: 'poll',
      label: 'Favorite color?',
      inputType: 'radio',
      choices: choices([['Blue', 'gpollBlue'], ['Red', 'gpollRed']]),
    }],
    seed: (f, c, id) => c.createEntry(f, { [id]: 'gpollBlue' }),
    assert: (e, _f, id) => (eq(e[id], 'gpollBlue')
      ? { pass: true, detail: 'radio poll → single token string' }
      : { pass: false, detail: `got ${JSON.stringify(e[id])}` }),
  },

  // ─── Add-on: Signature (entry value is written only on canvas submission) ───
  {
    type: 'signature',
    addon: 'gravityformssignature',
    guards: 'real add-on registers the field',
    build: (id) => [{ id, type: 'signature', label: 'Sign' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'signature'
        ? { pass: true, detail: 'real add-on registered the field' }
        : { pass: false, detail: 'signature field not present after create' };
    },
    note: 'Entry stores the saved-image filename (get_value_save_entry → maybe_save_signature); written on canvas submission, which REST cannot drive.',
  },

  // ─── Nested form (real GP Nested Forms add-on) ─────────────────────────────
  {
    type: 'form',
    addon: 'gp-nested-forms',
    guards: 'real child entry ids stored as one comma-separated string',
    // Create the child form + two real child entries first, then point the
    // nested-form field at the child form (gpnfForm) and store their ids.
    setup: async (c) => {
      const res = await c._gf.post('/forms', {
        title: `BENCH GPNF child ${Date.now()}`,
        fields: [{ id: 1, type: 'text', label: 'Item' }],
      });
      const childFormId = Number(res.data?.id ?? res.data);
      const a = await c.createEntry(childFormId, { 1: 'Child A' });
      const b = await c.createEntry(childFormId, { 1: 'Child B' });
      return { childFormId, childEntryIds: [a, b] };
    },
    build: (id, ctx) => [{ id, type: 'form', label: 'Children', gpnfForm: String(ctx.childFormId) }],
    seed: (f, c, id, ctx) => c.createEntry(f, { [id]: ctx.childEntryIds.join(',') }),
    assert: (e, _f, id, ctx) => {
      const want = ctx.childEntryIds.join(',');
      return eq(e[id], want) || (has(e[id], String(ctx.childEntryIds[0])) && has(e[id], String(ctx.childEntryIds[1])))
        ? { pass: true, detail: `stored child entry ids "${e[id]}"` }
        : { pass: false, detail: `expected "${want}", got ${JSON.stringify(e[id])}` };
    },
    teardown: (c, ctx) => c.deleteForm(ctx.childFormId),
  },

  // ─── No-value / layout types ────────────────────────────────────────────────
  {
    type: 'html',
    novalue: true,
    build: (id) => [{ id, type: 'html', label: 'HTML', content: '<p>hi</p>' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'html'
        ? { pass: true, detail: 'display-only field, no entry value' }
        : { pass: false, detail: 'html field not present' };
    },
  },
  {
    type: 'section',
    novalue: true,
    build: (id) => [{ id, type: 'section', label: 'Section' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'section'
        ? { pass: true, detail: 'layout field, no entry value' }
        : { pass: false, detail: 'section field not present' };
    },
  },
  {
    type: 'page',
    novalue: true,
    build: (id) => [{ id, type: 'page', label: 'Page Break' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'page'
        ? { pass: true, detail: 'pagination field, no entry value' }
        : { pass: false, detail: 'page field not present' };
    },
  },
  {
    type: 'captcha',
    novalue: true,
    build: (id) => [{ id, type: 'captcha', label: 'CAPTCHA' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'captcha'
        ? { pass: true, detail: 'validation field, stores no data' }
        : { pass: false, detail: 'captcha field not present' };
    },
  },
  {
    type: 'password',
    novalue: true,
    guards: 'password field type is registered',
    build: (id) => [{ id, type: 'password', label: 'Password' }],
    seed: () => null,
    assert: (_e, form, id) => {
      const field = (form.fields || []).find((x) => String(x.id) === String(id));
      return field && field.type === 'password'
        ? { pass: true, detail: 'password field registered' }
        : { pass: false, detail: 'password field not present' };
    },
    note: 'GF stashes/hydrates the value only during submission; the stored entry value is "" (test_not_saving_passwords).',
  },
];
