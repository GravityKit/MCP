/**
 * Bench grader rigor — unit tests for the AI release-gate task grade() functions.
 *
 * The gate's value is its grading: a grader that passes on the agent echoing the
 * prompt (no tool call), or on a field landing in the wrong area, gives false
 * confidence. These tests pin the contract each grader must enforce, exercised
 * with crafted telemetry / view-config fixtures (no live site, no model).
 *
 * bench/ is dev-only tooling; these tests run with the rest of the node:test
 * suite (`npm run test:node`).
 */

import test from 'node:test';
import assert from 'node:assert';
import entriesCrud from '../bench/tasks/entries-crud.mjs';
import viewFields from '../bench/tasks/view-fields.mjs';
import grid from '../bench/tasks/grid.mjs';

const byId = (arr, id) => {
  const t = arr.find((x) => x.id === id);
  if (!t) throw new Error(`task "${id}" not found`);
  return t;
};
const fakeClient = (cfg) => ({ viewConfig: async () => cfg });

test('entries.search: a clean answer is not enough — the search tool must run', async (t) => {
  const task = byId(entriesCrud, 'entries.search');
  await t.test('fails when the answer echoes the email but no tool ran', async () => {
    const grade = await task.grade({ telemetry: { toolCalls: [], finalText: 'Sure, that is ada@example.com.' } });
    assert.strictEqual(grade.pass, false);
  });
  await t.test('passes when gf_list_entries ran cleanly and isolated the match', async () => {
    const grade = await task.grade({ telemetry: { toolCalls: [{ name: 'gf_list_entries', isError: false }], finalText: 'Found ada@example.com' } });
    assert.strictEqual(grade.pass, true);
  });
  await t.test('still fails when the non-matching entry leaks into the answer', async () => {
    const grade = await task.grade({ telemetry: { toolCalls: [{ name: 'gf_list_entries', isError: false }], finalText: 'ada@example.com and charles@example.com' } });
    assert.strictEqual(grade.pass, false);
  });
});

test('entries.read: the read tool must run (not a prompt echo)', async (t) => {
  const task = byId(entriesCrud, 'entries.read');
  await t.test('fails on prompt echo with no tool call', async () => {
    const grade = await task.grade({ telemetry: { toolCalls: [], finalText: 'ada@example.com' } });
    assert.strictEqual(grade.pass, false);
  });
  await t.test('passes when gf_get_entry ran cleanly', async () => {
    const grade = await task.grade({ telemetry: { toolCalls: [{ name: 'gf_get_entry', isError: false }], finalText: 'ada@example.com' } });
    assert.strictEqual(grade.pass, true);
  });
});

test('view-fields.add: the check is scoped to the table-columns area', async (t) => {
  const task = byId(viewFields, 'view-fields.add');
  await t.test('fails when Email lands outside the directory columns area', async () => {
    const cfg = { fields: { 'directory_table-columns': [], 'single_table-columns': [{ id: '2' }] } };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, false);
  });
  await t.test('passes when Email is in the directory columns area', async () => {
    const cfg = { fields: { 'directory_table-columns': [{ id: '2' }] } };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, true);
  });
});

test('view-fields.remove: removal is judged in the columns area only', async (t) => {
  const task = byId(viewFields, 'view-fields.remove');
  await t.test('passes when First Name is gone from columns even if present elsewhere', async () => {
    const cfg = { fields: { 'directory_table-columns': [{ id: '2' }], 'single_table-columns': [{ id: '1' }] } };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, true);
  });
  await t.test('fails when First Name still occupies a column', async () => {
    const cfg = { fields: { 'directory_table-columns': [{ id: '1' }, { id: '2' }] } };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, false);
  });
});

test('grid.add-row-and-place-field: Email must land in a NEW area, not just anywhere', async (t) => {
  const task = byId(grid, 'grid.add-row-and-place-field');
  const state = { viewId: 1, beforeAreas: 1, beforeAreaKeys: ['directory_table-columns'] };
  await t.test('fails when Email sits in a pre-existing area', async () => {
    const cfg = { fields: { 'directory_table-columns': [{ id: '2' }], 'row-x-left': [] } };
    const grade = await task.grade({ client: fakeClient(cfg), state });
    assert.strictEqual(grade.pass, false);
  });
  await t.test('passes when Email is placed in the newly added row area', async () => {
    const cfg = { fields: { 'directory_table-columns': [], 'row-x-left': [{ id: '2' }] } };
    const grade = await task.grade({ client: fakeClient(cfg), state });
    assert.strictEqual(grade.pass, true);
  });
});
