/**
 * Unit tests for collectAbilityNames (abilities-catalog pagination).
 */

import test from 'node:test';
import assert from 'node:assert';
import { collectAbilityNames } from '../scripts/lib/ability-catalog.mjs';

// Mock WordPressClient: serves one array of abilities per page and reports
// the page count via the X-WP-TotalPages header, like the real endpoint.
function mockClient(pages) {
  return {
    baseUrl: 'http://example.test',
    httpClient: {
      request: async ({ params }) => ({
        data: pages[(params?.page ?? 1) - 1] ?? [],
        headers: { 'x-wp-totalpages': String(pages.length) },
      }),
    },
  };
}

test('collectAbilityNames: accumulates matching names across ALL pages', async () => {
  const client = mockClient([
    [{ name: 'gk-gravityview/view-create' }, { name: 'core/get-site-info' }],
    [{ name: 'gk-gravityview/views-scan' }],
  ]);
  const names = await collectAbilityNames(client);
  assert.deepEqual([...names].sort(), ['gk-gravityview/view-create', 'gk-gravityview/views-scan']);
});

test('collectAbilityNames: filters by prefix', async () => {
  const client = mockClient([[{ name: 'gk-gravityview/view-create' }, { name: 'core/get-site-info' }]]);
  const names = await collectAbilityNames(client);
  assert.deepEqual([...names], ['gk-gravityview/view-create']);
});

test('collectAbilityNames: single page when only one page exists', async () => {
  const client = mockClient([[{ name: 'gk-gravityview/layouts-list' }]]);
  const names = await collectAbilityNames(client);
  assert.deepEqual([...names], ['gk-gravityview/layouts-list']);
});

test('collectAbilityNames: collects every GravityKit product namespace, not just gravityview', async () => {
  const client = mockClient([[
    { name: 'gk-gravityview/layouts-list' },
    { name: 'gk-multiple-forms/list-joins' },
    { name: 'core/get-site-info' },
  ]]);
  const names = await collectAbilityNames(client);
  assert.deepEqual([...names].sort(), ['gk-gravityview/layouts-list', 'gk-multiple-forms/list-joins']);
});
