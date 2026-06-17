/**
 * View field CRUD — add, add-with-settings, reorder, remove. Edit verbs are
 * phrased as multi-step flows (add then act) so each grades on final persisted
 * config without a brittle pre-seeded fixture.
 *
 * Fixture form field ids: 1 = First Name, 2 = Email, 3 = Last Name.
 */

import { uniqueLabel, fieldIdsInTree, findSlotById, slotsInTree } from './helpers.mjs';

async function seedTableView(client) {
  const title = uniqueLabel('BENCH View');
  const form = await client.createForm(uniqueLabel('BENCH Form'));
  const view = await client.createView(form.id, title, 'default_table');
  return { formId: form.id, viewId: view.id, title };
}

/** Field ids in the table-columns area, in display order. */
function columnIds(cfg) {
  const tree = cfg.fields || {};
  const area = tree['directory_table-columns'] ? { 'directory_table-columns': tree['directory_table-columns'] } : tree;
  return slotsInTree(area).map((s) => String(s.id ?? s.field_id)).filter(Boolean);
}

export default [
  {
    id: 'view-fields.add',
    category: 'view-fields',
    expectedTurns: 3,
    maxTurns: 8,
    async setup(client) { return seedTableView(client); },
    prompt: (s) => `Add the Email field as a column to the GravityView View "${s.title}" (id ${s.viewId}).`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const ok = fieldIdsInTree(cfg.fields).includes('2');
      return { pass: ok, detail: ok ? '' : `Email (id 2) not in fields; have [${fieldIdsInTree(cfg.fields).join(',')}]` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'view-fields.add-with-label',
    category: 'view-fields',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) { return seedTableView(client); },
    prompt: (s) => `Add the First Name field to the GravityView View "${s.title}" (id ${s.viewId}) and set its column label to "Given Name".`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const slot = findSlotById(cfg.fields, 1);
      const label = String(slot?.custom_label || slot?.label || '');
      const ok = !!slot && /given name/i.test(label);
      return { pass: ok, detail: ok ? '' : `First Name slot label is "${label}" (want "Given Name")` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'view-fields.reorder',
    category: 'view-fields',
    expectedTurns: 4,
    maxTurns: 12,
    async setup(client) { return seedTableView(client); },
    prompt: (s) => `On the GravityView View "${s.title}" (id ${s.viewId}), add First Name and Email as columns, with Email shown first (before First Name).`,
    async grade({ client, state }) {
      const ids = columnIds(await client.viewConfig(state.viewId));
      const e = ids.indexOf('2');
      const f = ids.indexOf('1');
      const ok = e >= 0 && f >= 0 && e < f;
      return { pass: ok, detail: ok ? '' : `column order [${ids.join(',')}] (want Email(2) before First Name(1))` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'view-fields.remove',
    category: 'view-fields',
    expectedTurns: 3,
    maxTurns: 8,
    async setup(client) { return seedTableView(client); },
    prompt: (s) => `On the GravityView View "${s.title}" (id ${s.viewId}), add First Name and Email as columns, then remove the First Name column (keep Email).`,
    async grade({ client, state }) {
      const ids = fieldIdsInTree((await client.viewConfig(state.viewId)).fields);
      const ok = ids.includes('2') && !ids.includes('1');
      return { pass: ok, detail: ok ? '' : `fields are [${ids.join(',')}] (want Email only)` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },
];
