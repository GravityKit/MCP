/**
 * Pure-function tests for the shared merge guard behind gf_update_form and
 * gf_update_feed. The wire behaviour (no PUT on refusal) is pinned in
 * forms.test.js and feeds-wire.test.js; these pin the rule itself.
 */

import test from 'node:test';
import assert from 'node:assert';
import { droppedPaths, guardMerge } from '../src/utils/merge-guard.js';

test('droppedPaths: a stored key the sent object omits is recorded with its path', () => {
  assert.deepEqual(droppedPaths({ a: 1, b: 2 }, { a: 1 }, 'meta'), ['meta.b']);
});

test('droppedPaths: recurses into nested objects', () => {
  assert.deepEqual(droppedPaths({ x: { y: 1, z: 2 } }, { x: { y: 1 } }, 'meta'), ['meta.x.z']);
});

test('droppedPaths: arrays of objects with ids are matched by id, not position', () => {
  const stored = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(droppedPaths(stored, [{ id: 3 }, { id: 1 }], 'fields'), ['fields[2]']);
});

test('droppedPaths: recurses into matched array members (string and number ids meet)', () => {
  const stored = [{ id: 7, label: 'L', choices: [{ text: 'a' }] }];
  assert.deepEqual(droppedPaths(stored, [{ id: '7', label: 'L' }], 'fields'), ['fields[7].choices']);
});

test('droppedPaths: arrays without ids (choices, rules) replace whole, with no check', () => {
  assert.deepEqual(droppedPaths([{ text: 'a' }, { text: 'b' }], [{ text: 'a' }], 'choices'), []);
  assert.deepEqual(droppedPaths(['a', 'b'], ['a'], 'list'), []);
});

test('droppedPaths: a stored null or empty string is skipped (the compact reader never shows it)', () => {
  assert.deepEqual(droppedPaths({ a: null, b: '', c: 1 }, { c: 1 }), []);
});

test('droppedPaths: a stored false and 0 are real values and count', () => {
  assert.deepEqual(droppedPaths({ a: false, b: 0 }, {}, 'm').sort(), ['m.a', 'm.b']);
});

test('droppedPaths: sending null or a scalar for a stored key is an explicit replacement, not a drop', () => {
  assert.deepEqual(droppedPaths({ a: { b: 1 }, c: [{ id: 1 }] }, { a: null, c: 'x' }), []);
});

test('droppedPaths: a key set to undefined is absent (it never reaches the wire)', () => {
  assert.deepEqual(droppedPaths({ a: 1 }, { a: undefined }, 'm'), ['m.a']);
});

test('droppedPaths: new keys and new array members are never drops', () => {
  assert.deepEqual(droppedPaths({ a: 1 }, { a: 1, b: 2 }), []);
  assert.deepEqual(droppedPaths([{ id: 1 }], [{ id: 1 }, { id: 2 }], 'f'), []);
});

test('droppedPaths: mismatched shapes are not compared', () => {
  assert.deepEqual(droppedPaths({ a: 1 }, [1], 'm'), []);
  assert.deepEqual(droppedPaths([{ id: 1 }], { a: 1 }, 'm'), []);
});

test('guardMerge: throws naming every offending property in one error, and what to do', () => {
  const stored = { fields: [{ id: 1 }, { id: 2 }], button: { type: 'text', text: 'Go' }, title: 'T' };
  const sent = { fields: [{ id: 1 }], button: { text: 'x' }, title: 'New' };

  assert.throws(
    () => guardMerge({ tool: 'gf_update_form', noun: 'form', stored, updates: sent, replace: [] }),
    (error) => {
      assert.match(error.message, /^gf_update_form replaces fields and button whole/);
      assert.match(error.message, /2 stored key\(s\)/);
      assert.match(error.message, /fields\[2\]/);
      assert.match(error.message, /button\.type/);
      assert.match(error.message, /The form was not changed/);
      assert.match(error.message, /replace: \["fields", "button"\]/);
      return true;
    }
  );
});

test('guardMerge: replace lets the named property through and returns its paths', () => {
  const removed = guardMerge({ tool: 'gf_update_form', noun: 'form', stored: { c: { a: 1, b: 2 } }, updates: { c: { a: 1 } }, replace: ['c'] });
  assert.deepEqual(removed, ['c.b']);
});

test('guardMerge: caps the list at 40 paths and says how many more', () => {
  const stored = { m: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, 1])) };
  assert.throws(
    () => guardMerge({ tool: 'gf_update_feed', noun: 'feed', stored, updates: { m: {} }, replace: [] }),
    /…and 5 more/
  );
});

test('guardMerge: a property absent from the stored resource has nothing to drop', () => {
  assert.deepEqual(guardMerge({ tool: 't', noun: 'form', stored: {}, updates: { meta: { a: 1 } }, replace: [] }), []);
});

test('guardMerge: scalars replace freely', () => {
  assert.deepEqual(guardMerge({ tool: 't', noun: 'form', stored: { title: 'A', is_active: true }, updates: { title: 'B', is_active: false }, replace: [] }), []);
});

test('guardMerge: replace naming a property the call does not send is refused', () => {
  assert.throws(
    () => guardMerge({ tool: 't', noun: 'form', stored: { a: { b: 1 } }, updates: { title: 'x' }, replace: ['a'] }),
    /replace names a, which this call does not send/
  );
});
