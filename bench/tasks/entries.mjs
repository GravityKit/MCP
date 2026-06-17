/**
 * Entry tasks — the Gravity Forms plane. validate-no-save is the highest-stakes
 * grader in the suite: gf_validate_form MUST NOT persist an entry (the old bug
 * POSTed to /submissions and created one). The grader checks the entry count
 * is unchanged — objective, and impossible to fake from the agent's narration.
 */

import { uniqueLabel } from './helpers.mjs';

export default [
  {
    id: 'entries.validate-without-saving',
    category: 'entries',
    async setup(client) {
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const before = await client.countEntries(form.id);
      return { formId: form.id, before };
    },
    prompt: (s) =>
      `For Gravity Forms form ${s.formId}, check whether a submission with First Name "A" and Email "not-an-email" ` +
      `would be valid. Only VALIDATE it — do not actually submit or save an entry.`,
    async grade({ client, state }) {
      const after = await client.countEntries(state.formId);
      const created = after - state.before;
      return {
        pass: created === 0,
        detail: created === 0 ? '' : `validate created ${created} entr(y/ies) — it must not persist`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
  {
    id: 'entries.submit',
    category: 'entries',
    async setup(client) {
      const form = await client.createForm(uniqueLabel('BENCH Form'));
      const before = await client.countEntries(form.id);
      return { formId: form.id, before };
    },
    prompt: (s) =>
      `Submit an entry to Gravity Forms form ${s.formId} with First Name "Benchmark" and Email "bench@benchmark.test".`,
    async grade({ client, state }) {
      const after = await client.countEntries(state.formId);
      if (after - state.before !== 1) return { pass: false, detail: `expected 1 new entry, saw ${after - state.before}` };
      // Grade on the First Name (a plain text field) — the Email field can be
      // rejected by site-level email validation, which is not what this task tests.
      const entries = await client.getEntries(state.formId);
      const match = entries.some((e) => String(e['1'] || '') === 'Benchmark');
      return { pass: match, detail: match ? '' : 'an entry was created but the First Name value did not land' };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
];
