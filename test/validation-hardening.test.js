/**
 * Adversarial / edge-case validation tests for the gf_* input layer. They pin
 * GF-faithful behavior for inputs that are easy to mishandle: integer-id
 * coercion, sorting.is_numeric, paging.offset, top-level page/per_page, the
 * NOTIN multi-value alias, value:null filters, entry_id 0, current_page bounds,
 * and the no-op /forms params.
 *
 * Run directly: node --test test/validation-hardening.test.js
 *
 * Contract sources in Gravity Forms:
 *  - sorting.is_numeric / paging.offset: parse_entry_search_params (class-gf-rest-controller.php) feeds GF_Query (class-gf-query.php).
 *  - NOTIN alias: GF_Query's filter-operator switch (case 'NOTIN').
 *  - /forms: get_items (class-controller-forms.php) reads only `include`; status/active/exclude are no-ops.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationFactory,
  BaseValidator,
} from '../src/config/validation.js';
import { buildEntriesQuery } from '../src/gravity-forms-client.js';
import FieldAwareValidator from '../src/config/field-validation.js';
import { formatErrorMessage } from '../src/config/validation-config.js';

test('validateURL accepts a dotless host (localhost/intranet) for confirmation redirects', () => {
  assert.equal(BaseValidator.validateURL('https://localhost/thanks'), 'https://localhost/thanks');
  assert.equal(BaseValidator.validateURL('https://intranet/thanks'), 'https://intranet/thanks');
});

test('validateURL still rejects non-http(s) schemes', () => {
  assert.throws(() => BaseValidator.validateURL('javascript:alert(1)'));
  assert.throws(() => BaseValidator.validateURL('file:///etc/passwd'));
  assert.throws(() => BaseValidator.validateURL('https://has space/x'));
});

test('formatErrorMessage replaces every {field} and treats values literally', () => {
  assert.equal(formatErrorMessage('{field} or {field}', 'X'), 'X or X');
  assert.equal(formatErrorMessage('{field} bad', 'a$&b'), 'a$&b bad');
});

const validate = (tool, input) => ValidationFactory.validateToolInput(tool, input);

test('validateFormFields([null]) throws a clean validation error, not a TypeError', () => {
  let err;
  try { FieldAwareValidator.validateFormFields([null]); } catch (e) { err = e; }
  assert.ok(err, 'should throw');
  assert.notStrictEqual(err.constructor.name, 'TypeError');
  assert.match(err.message, /must be an object/);
});

test('validateFieldFilter rejects a non-scalar (object) value instead of stringifying it', () => {
  assert.throws(
    () => BaseValidator.validateFieldFilter({ key: '1', operator: 'is', value: { a: 1 } }),
    /value/
  );
});

// ---------------------------------------------------------------------------
// Lax integer coercion is rejected (PositiveIntegerRule + BaseValidator.validateId)
// GF types these as integers and 400s non-integer-formatted input. Only genuine
// integers must be accepted: Number.isInteger && Number.isSafeInteger && > 0,
// or a string of decimal digits (/^\d+$/).
// ---------------------------------------------------------------------------

test('rejects JS-hex string "0x10" as include id', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: ['0x10'] }),
    /positive integer/,
    '"0x10" must not coerce to 16'
  );
});

test('rejects boolean true as include id', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [true] }),
    /positive integer/,
    'true must not coerce to 1'
  );
});

test('rejects JS-hex string "0x2" as form_ids id', () => {
  assert.throws(
    () => validate('gf_list_entries', { form_ids: ['0x2'] }),
    /positive integer/,
    '"0x2" must not coerce to 2'
  );
});

test('rejects scientific-notation literal 1e21 (float > 2^53)', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [1e21] }),
    /positive integer/,
    '1e21 is not a safe integer'
  );
});

test('rejects integer beyond MAX_SAFE_INTEGER (silent rounding)', () => {
  assert.throws(
    () => validate('gf_list_entries', { include: [9007199254740993] }),
    /positive integer/,
    '9007199254740993 rounds to ...992 and must be rejected'
  );
});

test('rejects form_id:true on entry create', () => {
  assert.throws(
    () => validate('gf_create_entry', { form_id: true }),
    /positive integer/,
    'form_id:true must not coerce to 1'
  );
});

test('validateId rejects boolean / hex / unsafe directly', () => {
  assert.throws(() => BaseValidator.validateId(true, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId('0x10', 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(1e21, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(Number.MAX_SAFE_INTEGER + 2, 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId('12.0', 'id'), /positive integer/);
  assert.throws(() => BaseValidator.validateId(' 5', 'id'), /positive integer/);
});

test('genuine integers still accepted (numbers and decimal strings)', () => {
  assert.equal(BaseValidator.validateId(5, 'id'), 5);
  assert.equal(BaseValidator.validateId('5', 'id'), 5);
  assert.equal(BaseValidator.validateId(Number.MAX_SAFE_INTEGER, 'id'), Number.MAX_SAFE_INTEGER);
  const ok = validate('gf_list_entries', { include: [1, '2', 3] });
  assert.deepEqual(ok.include, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// validateSorting carries sorting.is_numeric (GF reads it) only when truthy
// ---------------------------------------------------------------------------

test('sorting.is_numeric (true) is preserved as boolean', () => {
  const out = BaseValidator.validateSorting({ key: '4', direction: 'asc', is_numeric: true });
  assert.equal(out.is_numeric, true);
  assert.equal(out.key, '4');
  assert.equal(out.direction, 'asc');
});

test('truthy is_numeric → true; falsy is_numeric is OMITTED (not sent as false)', () => {
  // GF never intvals sorting.is_numeric — any non-empty string is truthy, so
  // is_numeric=false on the wire ("false") would still force numeric ordering.
  // The only wire-safe "not numeric" is to omit it; GF defaults to lexical.
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: 1 }).is_numeric, true);
  assert.ok(!('is_numeric' in BaseValidator.validateSorting({ key: '4', is_numeric: 0 })), 'is_numeric:0 must be omitted');
  assert.ok(!('is_numeric' in BaseValidator.validateSorting({ key: '4', is_numeric: false })), 'is_numeric:false must be omitted');
});

test('string is_numeric is interpreted strictly: "true"/"1" → true, "false"/"0" → omitted', () => {
  // A non-conformant client may send the boolean as a string. "false"/"0" are
  // truthy in JS, so a naive truthy check would force numeric ordering. Only
  // true-equivalents carry; everything else is omitted.
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: 'true' }).is_numeric, true);
  assert.equal(BaseValidator.validateSorting({ key: '4', is_numeric: '1' }).is_numeric, true);
  assert.ok(!('is_numeric' in BaseValidator.validateSorting({ key: '4', is_numeric: 'false' })), 'is_numeric:"false" must be omitted');
  assert.ok(!('is_numeric' in BaseValidator.validateSorting({ key: '4', is_numeric: '0' })), 'is_numeric:"0" must be omitted');
});

test('sorting without is_numeric does not invent the key', () => {
  const out = BaseValidator.validateSorting({ key: '4', direction: 'desc' });
  assert.ok(!('is_numeric' in out), 'is_numeric must be absent when not provided');
});

test('is_numeric flows through gf_list_entries validator', () => {
  const out = validate('gf_list_entries', { sorting: { key: '4', direction: 'asc', is_numeric: true } });
  assert.equal(out.sorting.is_numeric, true);
});

test('is_numeric:false never reaches the wire (full path)', () => {
  const out = validate('gf_list_entries', { sorting: { key: '4', direction: 'asc', is_numeric: false } });
  assert.ok(!('is_numeric' in out.sorting), 'validator drops is_numeric:false');
  const q = buildEntriesQuery(out);
  assert.ok(!('is_numeric' in (q.sorting || {})), 'is_numeric:false absent from the wire query');
});

// ---------------------------------------------------------------------------
// paging.offset is carried through (GF reads it when current_page is absent)
// ---------------------------------------------------------------------------

test('paging.offset is kept when provided', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 20, offset: 40 } });
  assert.equal(out.paging.offset, 40);
  assert.equal(out.paging.page_size, 20);
});

test('offset:0 is kept (a valid offset)', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 20, offset: 0 } });
  assert.equal(out.paging.offset, 0);
});

test('negative / non-integer offset is rejected', () => {
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
// top-level page/per_page must not reach the wire for gf_list_entries
// (GF /entries uses paging[...] only)
// ---------------------------------------------------------------------------

test('validateListEntriesParams does not emit page/per_page', () => {
  const out = validate('gf_list_entries', { page: 2, per_page: 25 });
  assert.ok(!('page' in out), 'page must not be emitted');
  assert.ok(!('per_page' in out), 'per_page must not be emitted');
});

test('buildEntriesQuery never puts page/per_page on the wire', () => {
  const validated = validate('gf_list_entries', { page: 3, per_page: 10, paging: { page_size: 10, current_page: 3 } });
  const query = buildEntriesQuery(validated);
  assert.ok(!('page' in query), 'page must not be on the wire');
  assert.ok(!('per_page' in query), 'per_page must not be on the wire');
  assert.deepEqual(query.paging, { page_size: 10, current_page: 3 });
});

// ---------------------------------------------------------------------------
// NOTIN multi-value alias must preserve the array
// ---------------------------------------------------------------------------

test('NOTIN with an array preserves the array (no String() flatten)', () => {
  const out = BaseValidator.validateFieldFilter({ key: '1', operator: 'NOTIN', value: [1, 2, 3] });
  assert.ok(Array.isArray(out.value), 'NOTIN value must stay an array');
  assert.deepEqual(out.value, ['1', '2', '3']);
});

test('all GF multi-value aliases keep the array (any case)', () => {
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

test('literal "NIN" is rejected (not a GF filter operator)', () => {
  assert.throws(
    () => BaseValidator.validateFieldFilter({ key: '1', operator: 'NIN', value: [1, 2] }),
    /Invalid operator/,
    'NIN is an internal constant, not a GF filter operator'
  );
});

test('scalar operators still flatten to a string', () => {
  const out = BaseValidator.validateFieldFilter({ key: '1', operator: 'IS', value: 'hello' });
  assert.equal(out.value, 'hello');
  assert.equal(typeof out.value, 'string');
});

// ---------------------------------------------------------------------------
// value:null is rejected (String(null) would match the literal text "null")
// ---------------------------------------------------------------------------

test('field filter value:null is rejected like missing value', () => {
  assert.throws(
    () => BaseValidator.validateFieldFilter({ key: '1', operator: 'IS', value: null }),
    /value/,
    'null value must be rejected'
  );
});

test('value:null never serializes to the literal "null"', () => {
  let serialized;
  try {
    serialized = BaseValidator.validateFieldFilter({ key: '1', value: null });
  } catch (_) {
    serialized = undefined;
  }
  assert.notEqual(serialized && serialized.value, 'null', 'must not produce the text "null"');
});

// ---------------------------------------------------------------------------
// gf_send_notifications entry_id:0 -> "positive integer", not "required"
// ---------------------------------------------------------------------------

test('entry_id:0 yields a positive-integer error, not "required"', () => {
  assert.throws(
    () => validate('gf_send_notifications', { entry_id: 0 }),
    /positive integer/,
    'entry_id:0 must complain about positive integer'
  );
});

test('entry_id present-but-invalid keeps existing positive-integer errors', () => {
  assert.throws(() => validate('gf_send_notifications', { entry_id: -1 }), /positive integer/);
  assert.throws(() => validate('gf_send_notifications', { entry_id: 'abc' }), /positive integer/);
});

test('truly-missing entry_id still says required', () => {
  assert.throws(() => validate('gf_send_notifications', {}), /entry_id is required/);
  assert.throws(() => validate('gf_send_notifications', { entry_id: null }), /entry_id is required/);
});

// ---------------------------------------------------------------------------
// current_page consistency: 0 rejected like -1
// ---------------------------------------------------------------------------

test('current_page:0 is rejected (consistent with -1)', () => {
  assert.throws(
    () => validate('gf_list_entries', { paging: { current_page: 0 } }),
    /current_page|positive integer/,
    'current_page:0 must be rejected'
  );
});

test('current_page:-1 is rejected', () => {
  assert.throws(
    () => validate('gf_list_entries', { paging: { current_page: -1 } }),
    /current_page|positive integer/
  );
});

test('current_page:1 is accepted', () => {
  const out = validate('gf_list_entries', { paging: { page_size: 10, current_page: 1 } });
  assert.equal(out.paging.current_page, 1);
});

// ---------------------------------------------------------------------------
// gf_list_forms drops status/active/exclude (GF only reads include)
// ---------------------------------------------------------------------------

test('gf_list_forms keeps include only', () => {
  const out = validate('gf_list_forms', { include: [1, 2] });
  assert.deepEqual(out.include, [1, 2]);
});

test('gf_list_forms does not forward status/active/exclude', () => {
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

test('gf_list_forms still validates include ids', () => {
  assert.throws(
    () => validate('gf_list_forms', { include: ['0x2'] }),
    /positive integer/,
    'include ids still validated'
  );
});

// --- field_values contract (gf_submit_form_data / gf_validate_form) ---
// GF declares field_values as type ['string','array'] (dynamic population);
// submitted values are the separate input_N keys. An object is the wrong shape
// and GF 400s it.
test('gf_submit_form_data: field_values must be a GF string|array, not an object', () => {
  assert.throws(
    () => ValidationFactory.validateToolInput('gf_submit_form_data', { form_id: 1, field_values: { '1': 'x' } }),
    /field_values/,
    'an object must be rejected (GF rejects it)'
  );
  assert.doesNotThrow(
    () => ValidationFactory.validateToolInput('gf_submit_form_data', { form_id: 1, field_values: 'p1=a&p2=b' }),
    'a query string must be accepted'
  );
  assert.doesNotThrow(
    () => ValidationFactory.validateToolInput('gf_submit_form_data', { form_id: 1, field_values: ['a', 'b'] }),
    'an array must be accepted'
  );
});

test('gf_submit_form_data: submission values pass through as input_N keys', () => {
  const v = ValidationFactory.validateToolInput('gf_submit_form_data', { form_id: 1, input_1: 'John', input_2: 'j@x.com' });
  assert.equal(v.input_1, 'John');
  assert.equal(v.input_2, 'j@x.com');
});

test('gf_validate_form: field_values object likewise rejected, string accepted', () => {
  assert.throws(() => ValidationFactory.validateToolInput('gf_validate_form', { form_id: 1, field_values: { a: 1 } }), /field_values/);
  assert.doesNotThrow(() => ValidationFactory.validateToolInput('gf_validate_form', { form_id: 1, field_values: 'a=1' }));
});
