/**
 * gf_list_field_types filters: category and feature are closed sets, so an
 * unknown value must be rejected with the valid ones named. Before, both fell
 * through to a filter that could never match and answered `total: 0`, which an
 * agent reads as "this site has no field types".
 */

import test from 'node:test';
import assert from 'node:assert';
import { fieldOperationHandlers } from '../src/field-operations/index.js';
import fieldRegistry from '../src/field-definitions/field-registry.js';

const list = (params, registry = fieldRegistry) =>
  fieldOperationHandlers.gf_list_field_types(params, { fieldRegistry: registry });

const registryCategories = [...new Set(Object.values(fieldRegistry).map((d) => d.category))];

test('gf_list_field_types - category', async (t) => {
  await t.test('an exact category still filters', async () => {
    const result = await list({ category: 'standard' });
    assert.ok(result.total > 0);
    assert.ok(result.field_types.every((f) => f.category === 'standard'));
  });

  await t.test('is case-insensitive, matching what search already does', async () => {
    const lower = await list({ category: 'standard' });
    const mixed = await list({ category: 'Standard' });
    assert.deepStrictEqual(mixed, lower);
    assert.ok(mixed.total > 0);
  });

  await t.test('ignores surrounding whitespace', async () => {
    const lower = await list({ category: 'standard' });
    assert.deepStrictEqual(await list({ category: ' STANDARD ' }), lower);
  });

  await t.test('rejects an unknown category and names every valid one', async () => {
    await assert.rejects(() => list({ category: 'basic' }), (error) => {
      assert.match(error.message, /Unknown category 'basic'/);
      for (const category of registryCategories) {
        assert.ok(error.message.includes(category), `message should name '${category}': ${error.message}`);
      }
      return true;
    });
  });

  await t.test('takes its valid set from the registry, so a new category cannot drift', async () => {
    const registry = { widget: { label: 'Widget', category: 'newcat' } };
    const result = await list({ category: 'NewCat' }, registry);
    assert.strictEqual(result.total, 1);
    await assert.rejects(() => list({ category: 'standard' }, registry), /newcat/);
  });

  await t.test('a valid category narrowed to nothing by search is still an empty list, not an error', async () => {
    const result = await list({ category: 'standard', search: 'zzzz-no-such-type' });
    assert.strictEqual(result.total, 0);
  });
});

test('gf_list_field_types - feature', async (t) => {
  await t.test('required and conditional still filter', async () => {
    assert.ok((await list({ feature: 'required' })).total > 0);
    assert.ok((await list({ feature: 'conditional' })).total > 0);
  });

  await t.test('is case-insensitive', async () => {
    assert.deepStrictEqual(await list({ feature: 'Required' }), await list({ feature: 'required' }));
  });

  await t.test('rejects an unknown feature and names the supported ones', async () => {
    await assert.rejects(() => list({ feature: 'nonexistent' }), (error) => {
      assert.match(error.message, /Unknown feature 'nonexistent'/);
      assert.match(error.message, /required/);
      assert.match(error.message, /conditional/);
      return true;
    });
  });

  await t.test('rejects a raw registry property name instead of passing it through', async () => {
    await assert.rejects(() => list({ feature: 'supportsRequired' }), /Unknown feature/);
  });

  await t.test('rejects a documented feature that no registry entry declares', async () => {
    // "duplicate" has no entry with supportsDuplicate, so accepting it would
    // answer an empty list for a fact about the registry, not about the site.
    await assert.rejects(() => list({ feature: 'duplicate' }), /Unknown feature 'duplicate'/);
  });

  await t.test('takes its supported set from the registry', async () => {
    const registry = { widget: { label: 'Widget', category: 'standard', supportsPrepopulate: true } };
    const result = await list({ feature: 'prepopulate' }, registry);
    assert.strictEqual(result.total, 1);
    await assert.rejects(() => list({ feature: 'required' }, registry), /prepopulate/);
  });
});

test('gf_list_field_types - detail mode', async (t) => {
  await t.test('supports.conditional reflects the registry flag', async () => {
    const result = await list({ detail: true, feature: 'conditional' });
    assert.ok(result.total > 0);
    assert.ok(result.field_types.every((f) => f.supports.conditional === true));
  });
});
