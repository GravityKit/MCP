#!/usr/bin/env node

/**
 * Tests for compact utility (stripEmpty)
 * Verifies null/empty stripping behavior used in MCP response compaction.
 * Strips: null, ''
 * Preserves: false, 0, "0"
 */

import { stripEmpty, stripEntryMeta, stripEntryMetaFromResponse } from '../utils/compact.js';
import { TestRunner, TestAssert } from './helpers.js';

const runner = new TestRunner('Compact Utility Tests');

// --- stripEmpty: basic value handling ---

runner.test('stripEmpty: returns primitives unchanged', () => {
  TestAssert.equal(stripEmpty(42), 42, 'numbers unchanged');
  TestAssert.equal(stripEmpty('hello'), 'hello', 'strings unchanged');
  TestAssert.equal(stripEmpty(true), true, 'true unchanged');
  TestAssert.equal(stripEmpty(false), false, 'false unchanged');
  TestAssert.equal(stripEmpty(0), 0, 'zero unchanged');
  TestAssert.equal(stripEmpty(''), '', 'empty string unchanged at top level');
  TestAssert.equal(stripEmpty(undefined), undefined, 'undefined unchanged');
});

runner.test('stripEmpty: returns null unchanged at top level', () => {
  TestAssert.equal(stripEmpty(null), null, 'null at top level passes through');
});

runner.test('stripEmpty: preserves "0" string (GF boolean pattern)', () => {
  TestAssert.equal(stripEmpty('0'), '0', '"0" string preserved');
  TestAssert.equal(stripEmpty('1'), '1', '"1" string preserved');
});

// --- stripEmpty: object stripping ---

runner.test('stripEmpty: strips null values from objects', () => {
  const input = { a: 1, b: null, c: 'hello' };
  const result = stripEmpty(input);
  TestAssert.equal(result.a, 1, 'a preserved');
  TestAssert.equal(result.c, 'hello', 'c preserved');
  TestAssert.equal(result.b, undefined, 'null b stripped');
  TestAssert.equal(Object.keys(result).length, 2, 'only 2 keys remain');
});

runner.test('stripEmpty: strips empty string values from objects', () => {
  const input = { a: 1, b: '', c: 'hello' };
  const result = stripEmpty(input);
  TestAssert.equal(result.b, undefined, 'empty string b stripped');
  TestAssert.equal(Object.keys(result).length, 2, 'only 2 keys remain');
});

runner.test('stripEmpty: preserves false values (semantic meaning)', () => {
  const input = { a: 1, b: false, c: true };
  const result = stripEmpty(input);
  TestAssert.equal(result.b, false, 'false b preserved');
  TestAssert.equal(result.c, true, 'true c preserved');
  TestAssert.equal(Object.keys(result).length, 3, 'all 3 keys remain');
});

runner.test('stripEmpty: preserves zero values', () => {
  const input = { a: 0, b: null };
  const result = stripEmpty(input);
  TestAssert.equal(result.a, 0, 'zero preserved');
  TestAssert.equal(Object.keys(result).length, 1, 'only 1 key remains');
});

// --- stripEmpty: nested objects ---

runner.test('stripEmpty: strips nested null/empty recursively, preserves false', () => {
  const input = {
    a: 1,
    nested: {
      b: null,
      c: '',
      d: false,
      e: 'keep',
      deeper: {
        f: null,
        g: 42
      }
    }
  };
  const result = stripEmpty(input);
  TestAssert.equal(result.a, 1, 'top-level preserved');
  TestAssert.equal(result.nested.e, 'keep', 'nested string preserved');
  TestAssert.equal(result.nested.b, undefined, 'nested null stripped');
  TestAssert.equal(result.nested.c, undefined, 'nested empty string stripped');
  TestAssert.equal(result.nested.d, false, 'nested false preserved');
  TestAssert.equal(result.nested.deeper.g, 42, 'deep value preserved');
  TestAssert.equal(result.nested.deeper.f, undefined, 'deep null stripped');
});

// --- stripEmpty: arrays ---

runner.test('stripEmpty: processes array elements', () => {
  const input = [
    { a: 1, b: null },
    { c: '', d: 'keep' }
  ];
  const result = stripEmpty(input);
  TestAssert.equal(result.length, 2, 'array length preserved');
  TestAssert.equal(result[0].a, 1, 'first element a preserved');
  TestAssert.equal(result[0].b, undefined, 'first element null stripped');
  TestAssert.equal(result[1].d, 'keep', 'second element d preserved');
  TestAssert.equal(result[1].c, undefined, 'second element empty stripped');
});

runner.test('stripEmpty: handles empty arrays', () => {
  const result = stripEmpty([]);
  TestAssert.equal(result.length, 0, 'empty array stays empty');
});

runner.test('stripEmpty: handles arrays with primitives', () => {
  const result = stripEmpty([1, 'two', null, true, 0]);
  TestAssert.equal(result.length, 5, 'array length preserved');
  TestAssert.equal(result[0], 1);
  TestAssert.equal(result[1], 'two');
  TestAssert.equal(result[2], null, 'null in array preserved (only object keys stripped)');
  TestAssert.equal(result[3], true);
  TestAssert.equal(result[4], 0);
});

// --- stripEmpty: Gravity Forms realistic data ---

runner.test('stripEmpty: compacts a realistic GF entry', () => {
  const entry = {
    id: '123',
    form_id: '5',
    '1': 'John Doe',
    '2': 'john@example.com',
    '3': '',
    '4': '',
    '5': null,
    '6': 'Some value',
    status: 'active',
    is_starred: false,
    is_read: false,
    ip: '127.0.0.1',
    source_url: 'https://example.com',
    user_agent: '',
    currency: 'USD',
    payment_status: null,
    payment_date: null,
    payment_amount: null,
    payment_method: '',
    transaction_id: null,
    created_by: '1',
    date_created: '2024-01-15 10:30:00',
    date_updated: '2024-01-15 10:30:00'
  };
  const result = stripEmpty(entry);

  // Kept values
  TestAssert.equal(result.id, '123', 'id preserved');
  TestAssert.equal(result['1'], 'John Doe', 'field 1 preserved');
  TestAssert.equal(result['6'], 'Some value', 'field 6 preserved');
  TestAssert.equal(result.status, 'active', 'status preserved');
  TestAssert.equal(result.currency, 'USD', 'currency preserved');
  TestAssert.equal(result.is_starred, false, 'false is_starred preserved');
  TestAssert.equal(result.is_read, false, 'false is_read preserved');

  // Stripped values (null and empty string)
  TestAssert.equal(result['3'], undefined, 'empty field 3 stripped');
  TestAssert.equal(result['4'], undefined, 'empty field 4 stripped');
  TestAssert.equal(result['5'], undefined, 'null field 5 stripped');
  TestAssert.equal(result.payment_status, undefined, 'null payment_status stripped');
  TestAssert.equal(result.payment_method, undefined, 'empty payment_method stripped');
  TestAssert.equal(result.transaction_id, undefined, 'null transaction_id stripped');
  TestAssert.equal(result.user_agent, undefined, 'empty user_agent stripped');

  // Count keys stripped
  const originalKeys = Object.keys(entry).length;
  const compactKeys = Object.keys(result).length;
  TestAssert.isTrue(compactKeys < originalKeys, `compact (${compactKeys}) < original (${originalKeys})`);
});

runner.test('stripEmpty: preserves GF "0"/"1" string booleans', () => {
  const form = {
    id: '5',
    is_active: '1',
    is_trash: '0',
    enableHoneypot: '',
    enableAnimation: null
  };
  const result = stripEmpty(form);
  TestAssert.equal(result.is_active, '1', '"1" string preserved');
  TestAssert.equal(result.is_trash, '0', '"0" string preserved');
  TestAssert.equal(result.enableHoneypot, undefined, 'empty string stripped');
  TestAssert.equal(result.enableAnimation, undefined, 'null stripped');
});

// --- stripEmpty: edge cases ---

runner.test('stripEmpty: handles empty object', () => {
  const result = stripEmpty({});
  TestAssert.equal(Object.keys(result).length, 0, 'empty object stays empty');
});

runner.test('stripEmpty: handles object where all values are strippable', () => {
  const input = { a: null, b: '' };
  const result = stripEmpty(input);
  TestAssert.equal(Object.keys(result).length, 0, 'all keys stripped');
});

runner.test('stripEmpty: preserves object with only false values', () => {
  const input = { a: false, b: false };
  const result = stripEmpty(input);
  TestAssert.equal(Object.keys(result).length, 2, 'both keys preserved');
  TestAssert.equal(result.a, false, 'false a preserved');
  TestAssert.equal(result.b, false, 'false b preserved');
});

runner.test('stripEmpty: does not mutate original object', () => {
  const input = { a: 1, b: null, c: '' };
  stripEmpty(input);
  TestAssert.equal(input.b, null, 'original null preserved');
  TestAssert.equal(input.c, '', 'original empty string preserved');
  TestAssert.equal(Object.keys(input).length, 3, 'original key count unchanged');
});

// --- stripEntryMeta ---

runner.test('stripEntryMeta: keeps core properties and field values', () => {
  const entry = {
    id: '123',
    form_id: '29',
    status: 'active',
    date_created: '2024-01-15',
    date_updated: '2024-01-15',
    is_starred: '0',
    is_read: '0',
    ip: '127.0.0.1',
    source_url: 'https://example.com',
    user_agent: 'node',
    currency: 'USD',
    created_by: '1',
    '2': 'test@example.com',
    '3': 'some survey value',
    '6': '21621',
    gv_revision_parent_id: false,
    gv_revision_date: false,
    gv_revision_date_gmt: false,
    gv_revision_user_id: false,
    gv_revision_changed: false,
    helpscout_conversation_id: false,
    conversion_bridge_session: false
  };
  const result = stripEntryMeta(entry);

  // Core properties kept
  TestAssert.equal(result.id, '123', 'id kept');
  TestAssert.equal(result.form_id, '29', 'form_id kept');
  TestAssert.equal(result.status, 'active', 'status kept');
  TestAssert.equal(result.created_by, '1', 'created_by kept');
  TestAssert.equal(result.currency, 'USD', 'currency kept');

  // Field values kept
  TestAssert.equal(result['2'], 'test@example.com', 'field 2 kept');
  TestAssert.equal(result['3'], 'some survey value', 'field 3 kept');
  TestAssert.equal(result['6'], '21621', 'field 6 kept');

  // Plugin meta stripped
  TestAssert.equal(result.gv_revision_parent_id, undefined, 'gv_revision_parent_id stripped');
  TestAssert.equal(result.gv_revision_date, undefined, 'gv_revision_date stripped');
  TestAssert.equal(result.helpscout_conversation_id, undefined, 'helpscout_conversation_id stripped');
  TestAssert.equal(result.conversion_bridge_session, undefined, 'conversion_bridge_session stripped');
});

runner.test('stripEntryMeta: keeps compound field keys (dot notation)', () => {
  const entry = {
    id: '456',
    form_id: '5',
    status: 'active',
    '5.1': '123 Main St',
    '5.2': 'Apt 4',
    '5.3': 'Springfield',
    '5.4': 'IL',
    '5.5': '62701',
    some_plugin_meta: 'value'
  };
  const result = stripEntryMeta(entry);
  TestAssert.equal(result['5.1'], '123 Main St', 'compound field 5.1 kept');
  TestAssert.equal(result['5.3'], 'Springfield', 'compound field 5.3 kept');
  TestAssert.equal(result.some_plugin_meta, undefined, 'plugin meta stripped');
});

runner.test('stripEntryMeta: keeps payment fields when present', () => {
  const entry = {
    id: '789',
    form_id: '10',
    status: 'active',
    payment_status: 'Paid',
    payment_amount: '49.99',
    payment_method: 'stripe',
    transaction_id: 'txn_123',
    custom_addon_field: 'noise'
  };
  const result = stripEntryMeta(entry);
  TestAssert.equal(result.payment_status, 'Paid', 'payment_status kept');
  TestAssert.equal(result.payment_amount, '49.99', 'payment_amount kept');
  TestAssert.equal(result.transaction_id, 'txn_123', 'transaction_id kept');
  TestAssert.equal(result.custom_addon_field, undefined, 'custom addon stripped');
});

// --- stripEntryMetaFromResponse ---

runner.test('stripEntryMetaFromResponse: handles entries array', () => {
  const response = {
    entries: [
      { id: '1', form_id: '5', status: 'active', '2': 'val', plugin_meta: 'x' },
      { id: '2', form_id: '5', status: 'active', '3': 'val', plugin_meta: 'y' }
    ],
    total_count: 2
  };
  const result = stripEntryMetaFromResponse(response);
  TestAssert.equal(result.entries.length, 2, 'array length preserved');
  TestAssert.equal(result.total_count, 2, 'total_count preserved');
  TestAssert.equal(result.entries[0].plugin_meta, undefined, 'meta stripped from first');
  TestAssert.equal(result.entries[1].plugin_meta, undefined, 'meta stripped from second');
  TestAssert.equal(result.entries[0]['2'], 'val', 'field value kept in first');
});

runner.test('stripEntryMetaFromResponse: handles single entry', () => {
  const response = {
    entry: { id: '1', form_id: '5', status: 'active', '2': 'val', plugin_meta: 'x' }
  };
  const result = stripEntryMetaFromResponse(response);
  TestAssert.equal(result.entry.plugin_meta, undefined, 'meta stripped');
  TestAssert.equal(result.entry['2'], 'val', 'field value kept');
});

runner.test('stripEntryMetaFromResponse: passes through non-entry responses', () => {
  const response = { forms: [{ id: 1 }] };
  const result = stripEntryMetaFromResponse(response);
  TestAssert.equal(result.forms[0].id, 1, 'non-entry response unchanged');
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  runner.run().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}

export default runner;
