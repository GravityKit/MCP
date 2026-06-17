/**
 * Layout Builder grid rows — add a multi-column row and populate it. Grading
 * uses the area-key count (a row materializes new area keys) plus field
 * placement, which is objective without depending on the row-uid format.
 */

import { uniqueLabel, areaKeyCount, fieldIdsInTree } from './helpers.mjs';

async function seedBuilderView(client) {
  const title = uniqueLabel('BENCH View');
  const form = await client.createForm(uniqueLabel('BENCH Form'));
  const view = await client.createView(form.id, title, 'gravityview-layout-builder');
  const before = areaKeyCount((await client.viewConfig(view.id)).fields);
  return { formId: form.id, viewId: view.id, title, beforeAreas: before };
}

export default [
  {
    id: 'grid.add-row',
    category: 'grid',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) { return seedBuilderView(client); },
    prompt: (s) => `Add a new two-column (50/50) grid row to the GravityView View "${s.title}" (id ${s.viewId}).`,
    async grade({ client, state }) {
      const after = areaKeyCount((await client.viewConfig(state.viewId)).fields);
      const ok = after > state.beforeAreas;
      return { pass: ok, detail: ok ? '' : `area keys ${state.beforeAreas} → ${after} (a new row should add areas)` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'grid.add-row-and-place-field',
    category: 'grid',
    expectedTurns: 4,
    maxTurns: 12,
    async setup(client) { return seedBuilderView(client); },
    prompt: (s) => `On the GravityView View "${s.title}" (id ${s.viewId}), add a two-column grid row and place the Email field in its left column.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const moreAreas = areaKeyCount(cfg.fields) > state.beforeAreas;
      const hasEmail = fieldIdsInTree(cfg.fields).includes('2');
      return { pass: moreAreas && hasEmail, detail: moreAreas && hasEmail ? '' : `moreAreas=${moreAreas} emailPlaced=${hasEmail}` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },
];
