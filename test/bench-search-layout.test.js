/**
 * Bench grader rigor for the horizontal search-bar layout task.
 *
 * The trap this pins: GravityView stores a real side-by-side layout as an
 * `area_settings` pseudo-slot (`layout: "row"`) inside a search_fields_section
 * position bucket, but a top-level `search_layout: "horizontal"` widget setting
 * ALSO persists while rendering nothing (the area stays stacked). A grader that
 * accepted `search_layout` would pass on a visually-broken View. These tests
 * lock the grader to the pseudo-slot — the exact key the front-end reads.
 *
 * node:test; runs under `npm run test:node` (no site, no model).
 */

import test from 'node:test';
import assert from 'node:assert';
import { searchBarIsHorizontal } from '../bench/tasks/helpers.mjs';
import search from '../bench/tasks/search.mjs';

const byId = (arr, id) => {
  const t = arr.find((x) => x.id === id);
  if (!t) throw new Error(`task "${id}" not found`);
  return t;
};
const fakeClient = (cfg) => ({ viewConfig: async () => cfg });

/** A search_bar widget tree with one position bucket; `areaSettings` is injected as-is. */
const barWith = ({ areaSettings, extraWidgetKeys = {} } = {}) => ({
  header_top: {
    'slot-uid': {
      id: 'search_bar',
      ...extraWidgetKeys,
      search_fields_section: {
        'search-general_top': {
          'sf-uid-1': { id: 'search_all', type: 'search_all' },
          'sf-uid-2': { id: '3', type: '1::3', label: 'Last Name' },
          ...(areaSettings ? { area_settings: areaSettings } : {}),
        },
      },
    },
  },
});

test('searchBarIsHorizontal: recognizes the area_settings row pseudo-slot', () => {
  const widgets = barWith({ areaSettings: { layout: 'row', id: 'area_settings', label: 'Column' } });
  assert.strictEqual(searchBarIsHorizontal(widgets), true);
});

test('searchBarIsHorizontal: rejects the search_layout false positive', () => {
  // search_layout: "horizontal" persists but only class-decorates the <form>;
  // the area stays flex-direction: column. Must NOT count as horizontal.
  const widgets = barWith({ extraWidgetKeys: { search_layout: 'horizontal' } });
  assert.strictEqual(searchBarIsHorizontal(widgets), false);
});

test('searchBarIsHorizontal: rejects an explicit column layout', () => {
  const widgets = barWith({ areaSettings: { layout: 'column', id: 'area_settings' } });
  assert.strictEqual(searchBarIsHorizontal(widgets), false);
});

test('searchBarIsHorizontal: false when there is no search_bar', () => {
  assert.strictEqual(searchBarIsHorizontal({ header_top: { s: { id: 'page_info' } } }), false);
  assert.strictEqual(searchBarIsHorizontal({}), false);
});

test('search.horizontal-layout: grader requires the row layout AND the field', async (t) => {
  const task = byId(search, 'search.horizontal-layout');

  await t.test('fails when the bar exists but is not horizontal (search_layout only)', async () => {
    const cfg = { widgets: barWith({ extraWidgetKeys: { search_layout: 'horizontal' } }) };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, false);
  });

  await t.test('passes when area_settings.layout=row and Last Name is present', async () => {
    const cfg = { widgets: barWith({ areaSettings: { layout: 'row', id: 'area_settings' } }) };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, true);
  });

  await t.test('fails when horizontal with only the keyword field (nothing beside it)', async () => {
    const cfg = {
      widgets: {
        header_top: {
          s: {
            id: 'search_bar',
            search_fields_section: {
              'search-general_top': {
                'sf-1': { id: 'search_all', type: 'search_all' },
                area_settings: { layout: 'row', id: 'area_settings' },
              },
            },
          },
        },
      },
    };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, false);
  });

  await t.test('fails when horizontal with Last Name but no keyword search', async () => {
    const cfg = {
      widgets: {
        header_top: {
          s: {
            id: 'search_bar',
            search_fields_section: {
              'search-general_top': {
                'sf-2': { id: '3', type: '1::3', label: 'Last Name' },
                area_settings: { layout: 'row', id: 'area_settings' },
              },
            },
          },
        },
      },
    };
    const grade = await task.grade({ client: fakeClient(cfg), state: { viewId: 1 } });
    assert.strictEqual(grade.pass, false);
  });
});
