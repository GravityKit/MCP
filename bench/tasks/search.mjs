/**
 * Search-bar editing — the flakiest surface (5-piece nested identity inside a
 * search_bar widget). This is where the enriched tool descriptions earn their
 * keep: a small model must locate the widget and add a search field correctly.
 */

import { uniqueLabel, searchBarHasField, searchFieldFor, searchFieldInput } from './helpers.mjs';

export default [
  {
    id: 'search.add-last-name-field',
    category: 'search',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      const title = uniqueLabel('BENCH SearchView');
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const view = await client.createView(form.id, title, 'gravityview-layout-builder');
      return { formId: form.id, viewId: view.id, title };
    },
    prompt: (s) =>
      `The GravityView View titled "${s.title}" (id ${s.viewId}) needs a search bar so visitors can search by the ` +
      `"Last Name" field. Add a search bar to the View with a Last Name search field.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const has = searchBarHasField(cfg.widgets, 3); // Last Name = field id 3
      return {
        pass: has,
        detail: has ? '' : 'no search_bar widget references the Last Name field (id 3) after the run',
      };
    },
    async teardown({ client, state }) {
      if (state.viewId) await client.deleteView(state.viewId);
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'search.add-and-configure-input',
    category: 'search',
    expectedTurns: 4,
    maxTurns: 10,
    async setup(client) {
      const title = uniqueLabel('BENCH SearchView');
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const view = await client.createView(form.id, title, 'gravityview-layout-builder');
      return { formId: form.id, viewId: view.id, title };
    },
    prompt: (s) =>
      `On the GravityView View "${s.title}" (id ${s.viewId}), add a search bar with a search field for the ` +
      `"Status" field (field id 4), and configure that search field to use radio-button input instead of the ` +
      `default drop-down.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const field = searchFieldFor(cfg.widgets, 4);
      const input = searchFieldInput(field);
      const ok = !!field && /radio/i.test(input);
      return { pass: ok, detail: ok ? '' : field ? `Status search field input="${input}" (want radio)` : 'no Status search field was added' };
    },
    async teardown({ client, state }) {
      if (state.viewId) await client.deleteView(state.viewId);
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'search.multi-field-bar',
    category: 'search',
    expectedTurns: 4,
    maxTurns: 12,
    async setup(client) {
      const title = uniqueLabel('BENCH SearchView');
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const view = await client.createView(form.id, title, 'gravityview-layout-builder');
      return { formId: form.id, viewId: view.id, title };
    },
    prompt: (s) =>
      `On the GravityView View "${s.title}" (id ${s.viewId}), add a search bar with three search fields: ` +
      `a keyword search (search everything), the "Last Name" field (id 3), and a submit button.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const hasAll = searchBarHasField(cfg.widgets, 'search_all');
      const hasLast = searchBarHasField(cfg.widgets, 3);
      const hasSubmit = searchBarHasField(cfg.widgets, 'submit');
      const ok = hasAll && hasLast && hasSubmit;
      return { pass: ok, detail: ok ? '' : `missing fields — search_all:${hasAll} lastName:${hasLast} submit:${hasSubmit}` };
    },
    async teardown({ client, state }) {
      if (state.viewId) await client.deleteView(state.viewId);
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'search.role-restricted-field',
    category: 'search',
    expectedTurns: 4,
    maxTurns: 12,
    async setup(client) {
      const title = uniqueLabel('BENCH SearchView');
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const view = await client.createView(form.id, title, 'gravityview-layout-builder');
      return { formId: form.id, viewId: view.id, title };
    },
    prompt: (s) =>
      `On the GravityView View "${s.title}" (id ${s.viewId}), add a search bar with a search field for the ` +
      `"Status" field (id 4), and restrict that search field so it is only visible to logged-in users with the ` +
      `"manage_options" capability.`,
    async grade({ client, state }) {
      const cfg = await client.viewConfig(state.viewId);
      const field = searchFieldFor(cfg.widgets, 4);
      const loggedIn = field && (field.only_loggedin === true || field.only_loggedin === 1 || String(field.only_loggedin) === '1');
      const cap = /manage_options/.test(String(field?.only_loggedin_cap || ''));
      const ok = !!field && loggedIn && cap;
      return {
        pass: ok,
        detail: ok ? '' : field ? `Status field only_loggedin=${JSON.stringify(field.only_loggedin)} cap=${JSON.stringify(field.only_loggedin_cap)}` : 'no Status search field added',
      };
    },
    async teardown({ client, state }) {
      if (state.viewId) await client.deleteView(state.viewId);
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
];
