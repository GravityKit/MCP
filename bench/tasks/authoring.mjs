/**
 * View authoring — the seeded create path that used to 400 (create-view chained
 * into apply_config, whose payload arrived empty). A small model should be able
 * to create a configured View in one shot.
 */

import { uniqueLabel, fieldIdsInTree } from './helpers.mjs';

export default [
  {
    id: 'authoring.create-view-seeded',
    category: 'authoring',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      const title = uniqueLabel('BENCH View');
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      return { formId: form.id, title };
    },
    prompt: (s) =>
      `Create a new GravityView View titled "${s.title}" for Gravity Forms form ${s.formId}, using the Table layout, ` +
      `showing two columns: the First Name field and the Email field.`,
    async grade({ client, state, telemetry }) {
      const view = await client.findViewByTitle(state.title);
      if (!view) return { pass: false, detail: `no View titled "${state.title}" was created (errors: ${(telemetry.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode).filter(Boolean).join(', ') || 'none'})` };
      state.viewId = view.view_id;
      const cfg = await client.viewConfig(view.view_id);
      const template = String(cfg.template_id || cfg.template || '');
      const ids = fieldIdsInTree(cfg.fields);
      const hasTable = /table/i.test(template);
      const hasFields = ids.includes('1') && ids.includes('2');
      return {
        pass: hasTable && hasFields,
        detail: hasTable && hasFields ? '' : `template="${template}" fields=[${ids.join(',')}] (want a table layout with fields 1 & 2)`,
      };
    },
    async teardown({ client, state }) {
      if (state.viewId) await client.deleteView(state.viewId);
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
];
