/**
 * View widget CRUD — add + remove. Widgets live in the header/footer zones of a
 * View (distinct from fields and from the search bar's internal layout).
 */

import { uniqueLabel, widgetIds } from './helpers.mjs';

async function seedView(client) {
  const title = uniqueLabel('BENCH View');
  const form = await client.createForm(uniqueLabel('BENCH Form'));
  const view = await client.createView(form.id, title, 'gravityview-layout-builder');
  return { formId: form.id, viewId: view.id, title };
}

const hasWidget = (cfg, id) => widgetIds(cfg.widgets).includes(id);

export default [
  {
    id: 'view-widgets.add',
    category: 'view-widgets',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) { return seedView(client); },
    prompt: (s) => `Add a "pagination info" widget (shows "Displaying x–y of z") to the footer of the GravityView View "${s.title}" (id ${s.viewId}).`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const ok = hasWidget(cfg, 'page_info');
      return { pass: ok, detail: ok ? '' : `no page_info widget added; widgets=[${widgetIds(cfg.widgets).join(',')}]` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'view-widgets.add-then-remove',
    category: 'view-widgets',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) { return seedView(client); },
    prompt: (s) => `On the GravityView View "${s.title}" (id ${s.viewId}), add a pagination info widget to the header, then remove it again.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const ok = !hasWidget(cfg, 'page_info');
      return { pass: ok, detail: ok ? '' : 'page_info widget is still present after the remove step' };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },
];
