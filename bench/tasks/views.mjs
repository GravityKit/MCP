/**
 * View lifecycle — settings, status, duplicate, delete. (Create + seed is in
 * authoring.mjs; discovery/list/scan is in discovery.mjs.) Each task seeds a
 * View fixture so the verb under test acts on a known View.
 */

import { uniqueLabel, noToolErrors, calledOk } from './helpers.mjs';

async function seedView(client, templateId = 'gravityview-layout-builder') {
  const title = uniqueLabel('BENCH View');
  const form = await client.createForm(uniqueLabel('BENCH Form'));
  const view = await client.createView(form.id, title, templateId);
  return { formId: form.id, viewId: view.id, title };
}

export default [
  {
    id: 'views.update-settings',
    category: 'views',
    expectedTurns: 3,
    maxTurns: 8,
    async setup(client) { return seedView(client); },
    prompt: (s) => `On the GravityView View "${s.title}" (id ${s.viewId}), set the number of entries shown per page to 25.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const ps = String(cfg.template_settings?.page_size ?? cfg.settings?.page_size ?? '');
      return { pass: ps === '25', detail: ps === '25' ? '' : `page_size is "${ps}" (want 25)` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'views.set-status-publish',
    category: 'views',
    expectedTurns: 2,
    maxTurns: 8,
    async setup(client) { return seedView(client); },
    prompt: (s) => `The GravityView View "${s.title}" (id ${s.viewId}) is a draft. Publish it.`,
    async grade({ client, state }) {
      const row = await client.findViewByTitle(state.title);
      const status = String(row?.status || '');
      return { pass: status === 'publish', detail: status === 'publish' ? '' : `status is "${status}" (want publish)` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'views.duplicate',
    category: 'views',
    expectedTurns: 3,
    maxTurns: 8,
    async setup(client) { return seedView(client); },
    prompt: (s) => `Duplicate the GravityView View "${s.title}" (id ${s.viewId}).`,
    async grade({ telemetry }) {
      // Copy naming isn't contractually fixed, so grade on a clean duplicate call.
      const ok = calledOk(telemetry, 'view_duplicate') && noToolErrors(telemetry);
      return { pass: ok, detail: ok ? '' : 'no clean gv_view_duplicate call completed' };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },

  {
    id: 'views.delete',
    category: 'views',
    expectedTurns: 2,
    maxTurns: 8,
    async setup(client) { return seedView(client); },
    prompt: (s) => `Delete the GravityView View "${s.title}" (id ${s.viewId}).`,
    async grade({ client, state }) {
      const row = await client.findViewByTitle(state.title);
      const gone = !row || String(row.status) === 'trash';
      return { pass: gone, detail: gone ? '' : `View still present with status "${row?.status}"` };
    },
    async teardown({ client, state }) { await client.deleteView(state.viewId); await client.deleteForm(state.formId); },
  },
];
