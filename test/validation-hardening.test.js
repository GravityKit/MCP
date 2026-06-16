/**
 * Adversarial / edge-case validation hardening tests.
 *
 * These pin GF-faithful behavior for the validation layer against inputs that
 * the previous implementation silently mishandled (lax integer coercion,
 * dropped sorting.is_numeric / paging.offset, page/per_page wire leak, the
 * NOTIN multi-value alias, value:null serialization, entry_id:0, current_page
 * consistency, and forwarding of no-op /forms params).
 *
 * Run directly: node --test test/validation-hardening.test.js
 *
 * GF source references (gravityforms 2.10.3):
 *  - sorting.is_numeric: includes/webapi/v2/includes/controllers/class-gf-rest-controller.php:64-66
 *                        includes/query/class-gf-query.php:177
 *  - paging.offset:      class-gf-rest-controller.php:75
 *  - top-level paging:   GF /entries uses paging[...] only, not page/per_page
 *  - NOTIN alias:        includes/query/class-gf-query.php:336 (case 'NOTIN' -> NIN)
 *  - /forms params:      includes/webapi/v2/includes/controllers/class-controller-forms.php:88
 *                        (only `include` is read; status/active/exclude are no-ops)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationFactory,
  BaseValidator,
} from '../src/config/validation.js';
import { buildEntriesQuery } from '../src/gravity-forms-client.js';

const validate = (tool, input) => ValidationFactory.validateToolInput(tool, input);

// ---------------------------------------------------------------------------
// Fix 1 — lax integer coercion (PositiveIntegerRule + BaseValidator.validateId)
// GF types these as integers and 400s non-integer-formatted input. Only genuine
// integers must be accepted: Number.isInteger && Number.isSafeInteger && > 0,
// or a string of decimal digits (/^\d+$/).
// ---------------------------------------------------------------------------

test('Fix1: rejects JS-hex string "0x10" as include id', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: ['0x10'] }),
    /positive integer/,
    '"0x10" must not coerce to 16'
  );
});

test('Fix1: rejects boolean true as include id', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [true] }),
    /positive integer/,
    'true must not coerce to 1'
  );
});

test('Fix1: rejects JS-hex string "0x2" as form_ids id', () => {
  assert.throws(
    () => validate('gf_list_entries', { form_ids: ['0x2'] }),
    /positive integer/,
    '"0x2" must not coerce to 2'
  );
});

test('Fix1: rejects scientific-notation literal 1e21 (float > 2^53)', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [1e21] }),
    /positive integer/,
    '1e21 is not a safe integer'
  );
});

test('Fix1: rejects integer beyond MAX_SAFE_INTEGER (silent rounding)', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [9007199254740993] }),
    /positive integer/,
    '9007199254740993 rounds to ...992 and must be rejected'
  );
});

test('Fix1: rejects form_id:true on entry create', () => {
  assert.throws(
    () => validate('gf_create_entry', { form_id: true }),
    /positive integer/,
    'form_id:true must not coerce to 1'
  );
});

test('Fix1: validateId rejects boolean / hex / unsafe directly', () => {
  assert.throws(() => BaseValidator.validateId(true, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId('0x10', 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(1e21, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(Number.MAX_SAFE_INTEGER + 2, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId('12.0', 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(' 5', 'id'), /positive integer/);
});

test('Fix1: genuine integers still accepted (numbers and decimal strings)', () => {
  assert.equal(BaseValidator.validateId(5, 'id'), 5);
  assert.equal(BaseValidator.validateId('5', 'id'), 5);
  assert.equal(BaseValidator.validateId(Number.MAX_SAFE_INTEGER, 'id'), Number.MAX_SAFE_INTEGER);
  const ok = validate('gf_list_entries', { include: [1, '2', 3] });
  assert.deepEqual(ok.include, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Fix 2 — validateSorting drops is_numeric (GF reads sorting.is_numeric)
// ---------------------------------------------------------------------------

test('Fix2: sorting.is_numeric (true) is preserved as boolean', () => {
  const out = BaseValidator.validateSorting({ key: '4', direction: 'asc', is_numeric: true });
  assert.equal(out.is_numeric, true);
  assert.equal(out.key, '4');
  assert.equal(out.direction, 'asc');
});

test('Fix2: sorting.is_numeric coerces truthy/falsy to boolean', () => {
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: 1 }).is_numeric, true);
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: 0 }).is_numeric, false);
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: false }).is_numeric, false);
});

test('Fix2: sorting without is_numeric does not invent the key', () => {
  const out = BaseValidator.validateSorting({ key: '4', direction: 'desc' });
  assert.ok(!('is_numeric' in out), 'is_numeric must be absent when not provided');
});

test('Fix2: is_numeric flows through gf_list_entries validator', () => {
  const out = validate('gf_list_entries', { sorting: { key: '4', direction: 'asc', is_numeric: true } });
  assert.equal(out.sorting.is_numeric, true);
});

// ---------------------------------------------------------------------------
// Fix 3 — paging.offset is dropped
// ---------------------------------------------------------------------------

test('Fix3: paging.offset is kept when provided', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 20, offset: 40 } });
  assert.equal(out.paging.offset, 40);
  assert.equal(out.paging.page_size, 20);
});

test('Fix3: offset:0 is kept (a valid offset)', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 20, offset: 0 } });
  assert.equal(out.paging.offset, 0);
});

test('Fix3: negative / non-integer offset is rejected', () => {
  assert.throws(
    () => validate('gf_list_entries', { paging: { offset: -5 } }),
    /offset/,
    'negative offset must be rejected'
  );
  assert.throws(
    () => validate('gf_list_entries', { paging: { offset: '0x10' } }),
    /offset/,
    'hex-string offset must be rejected'
  );
});

// ---------------------------------------------------------------------------
// Fix 4 — top-level page/per_page must not reach the wire for gf_list_entries
// (GF /entries uses paging[...] only)
// ---------------------------------------------------------------------------

test('Fix4: validateListEntriesParams does not emit page/per_page', () => {
  const out = validate('gf_list_entries', { page: 2, per_page: 25 });
  assert.ok(!('page' in out), 'page must not be emitted');
  assert.ok(!('per_page' in out), 'per_page must not be emitted');
});

test('Fix4: buildEntriesQuery never puts page/per_page on the wire', () => {
  const validated = validate('gf_list_entries', { page: 3, per_page: 10, paging: { page_size: 10, current_page: 3 } });
  const query = buildEntriesQuery(validated);
  assert.ok(!('page' in query), 'page must not be on the wire');
  assert.ok(!('per_page' in query), 'per_page must not be on the wire');
  assert.deepEqual(query.paging, { page_size: 10, current_page: 3 });
});

// ---------------------------------------------------------------------------
// Fix 5 — NOTIN multi-value alias must preserve the array
// ---------------------------------------------------------------------------

test('Fix5: NOTIN with an array preserves the array (no String() flatten)', () => {
  const out = BaseValidator.validateFieldFilter({ key: '1', operator: 'NOTIN', value: [1, 2, 3] });
  assert.ok(Array.isArray(out.value), 'NOTIN value must stay an array');
  assert.deepEqual(out.value, ['1', '2', '3']);
});

test('Fix5: all GF multi-value aliases keep the array (any case)', () => {
  // GF's filter-operator switch (class-gf-query.php) accepts these membership
  // aliases — IN, NOT IN, and NOTIN (any case). The literal "NIN" is an internal
  // GF_Query_Condition constant, NOT a user-facing filter operator, so it is not
  // in the fieldOperators enum and is correctly rejected as an invalid operator.
  for (const op of ['in', 'IN', 'not in', 'NOT IN', 'notin', 'NOTIN']) {
    const out = BaseValidator.validateFieldFilter({ key: '1', operator: op, value: [7, 8] });
    assert.ok(Array.isArray(out.value), `${op} value must stay an array`);
    assert.deepEqual(out.value, ['7', '8'], `${op} must map to ["7","8"]`);
  }
});

test('Fix5: literal "NIN" is rejected (not a GF filter operator)', () => {
  assert.throws(
    () => BaseValidator.validateFieldFilter({ key: '1', operator: 'NIN', value: [1, 2] }),
    /Invalid operator/,
    'NIN is an internal constant, not a GF filter operator'
  );
});

test('Fix5: scalar operators still flatten to a string', () => {
  const out = BaseValidator.validateFieldFilter({ key: '1', operator: 'IS', value: 'hello' });
  assert.equal(out.value, 'hello');
  assert.equal(typeof out.value, 'string');
});

// ---------------------------------------------------------------------------
// Fix 6 — value:null is rejected (was serialized to "null")
// ---------------------------------------------------------------------------

test('Fix6: field filter value:null is rejected like missing value', () => {
  assert.throws(
    () => BaseValidator.validateFieldFilter({ key: '1', operator: 'IS', value: null }),
    /value/,
    'null value must be rejected'
  );
});

test('Fix6: value:null never serializes to the literal "null"', () => {
  let serialized;
  try {
    serialized = BaseValidator.validateFieldFilter({ key: '1', value: null });
  } catch (_) {
    serialized = undefined;
  }
  assert.notEqual(serialized && serialized.value, 'null', 'must not produce the text "null"');
});

// ---------------------------------------------------------------------------
// Fix 7 — gf_send_notifications entry_id:0 -> "positive integer", not "required"
// ---------------------------------------------------------------------------

test('Fix7: entry_id:0 yields a positive-integer error, not "required"', () => {
  assert.throws(
    () => validate('gf_send_notifications', { entry_id: 0 }),
    /positive integer/,
    'entry_id:0 must complain about positive integer'
  );
});

test('Fix7: entry_id present-but-invalid keeps existing positive-integer errors', () => {
  assert.throws(() => validate('gf_send_notifications', { entry_id: -1 }), /positive integer/);
  assert.throws(() => validate('gf_send_notifications', { entry_id: 'abc' }), /positive integer/);
});

test('Fix7: truly-missing entry_id still says required', () => {
  assert.throws(() => validate('gf_send_notifications', {}), /entry_id is required/);
  assert.throws(() => validate('gf_send_notifications', { entry_id: null }), /entry_id is required/);
});

// ---------------------------------------------------------------------------
// Fix 8 — current_page consistency: 0 rejected like -1
// ---------------------------------------------------------------------------

test('Fix8: current_page:0 is rejected (consistent with -1)', () => {
  assert.throws(
    () => validate('gf_list_entries', { paging: { current_page: 0 } }),
    /current_page|positive integer/,
    'current_page:0 must be rejected'
  );
});

test('Fix8: current_page:-1 is rejected', () => {
  assert.throws(
    () => validate('gf_list_entries', { paging: { current_page: -1 } }),
    /current_page|positive integer/
  );
});

test('Fix8: current_page:1 is accepted', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 10, current_page: 1 } });
  assert.equal(out.paging.current_page, 1);
});

// ---------------------------------------------------------------------------
// Fix 9 — gf_list_forms drops status/active/exclude (GF only reads include)
// ---------------------------------------------------------------------------

test('Fix9: gf_list_forms keeps include only', () => {
  const out = validate('gf_list_forms', { include: [1, 2] });
  assert.deepEqual(out.include, [1, 2]);
});

test('Fix9: gf_list_forms does not forward status/active/exclude', () => {
  const out = validate('gf_list_forms', {
    include: [1],
    status: 'active',
    active: true,
    exclude: [9],
  });
  assert.ok(!('status' in out), 'status is a GF no-op and must be dropped');
  assert.ok(!('active' in out), 'active is a GF no-op and must be dropped');
  assert.ok(!('exclude' in out), 'exclude is a GF no-op and must be dropped');
});

test('Fix9: gf_list_forms still validates include ids', () => {
  assert.throws(
    () => validate('gf_list_forms', { include: ['0x2'] }),
    /positive integer/,
    'include ids still validated'
  );
});
