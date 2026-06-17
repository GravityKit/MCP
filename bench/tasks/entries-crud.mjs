/**
 * Entry CRUD + search. Read/search tasks grade on a clean tool run + the answer
 * containing the right value; update/delete grade on persisted state.
 */

import { uniqueLabel, noToolErrors, calledOk } from './helpers.mjs';

async function formWithEntries(client, entries) {
  const form = await client.createForm(uniqueLabel('BENCH Form'));
  const ids = [];
  for (const e of entries) ids.push(await client.createEntry(form.id, e));
  return { formId: form.id, entryIds: ids };
}

export default [
  {
    id: 'entries.read',
    category: 'entries',
    expectedTurns: 2,
    maxTurns: 8,
    async setup(client) {
      const s = await formWithEntries(client, [{ '1': 'Ada', '2': 'ada@example.com' }]);
      return { ...s, entryId: s.entryIds[0] };
    },
    prompt: (s) => `Show me the details of Gravity Forms entry ${s.entryId}.`,
    async grade({ telemetry }) {
      const calledRead = calledOk(telemetry, 'get_entry') || calledOk(telemetry, 'list_entries');
      const ok = noToolErrors(telemetry) && calledRead && /ada@example\.com/i.test(telemetry.finalText || '');
      return { pass: ok, detail: ok ? '' : 'the entry email was not surfaced cleanly via a real read call' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'entries.search',
    category: 'entries',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      return formWithEntries(client, [
        { '1': 'Ada', '2': 'ada@example.com' },
        { '1': 'Babbage', '2': 'charles@example.com' },
      ]);
    },
    prompt: (s) => `Find the entries on Gravity Forms form ${s.formId} whose Email is "ada@example.com".`,
    async grade({ telemetry }) {
      const text = telemetry.finalText || '';
      const ok = noToolErrors(telemetry) && calledOk(telemetry, 'list_entries') && /ada@example\.com/i.test(text) && !/charles@example\.com/i.test(text);
      return { pass: ok, detail: ok ? '' : 'search did not isolate the matching entry' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'entries.update',
    category: 'entries',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      const s = await formWithEntries(client, [{ '1': 'Ada', '2': 'ada@example.com' }]);
      return { ...s, entryId: s.entryIds[0] };
    },
    prompt: (s) => `Change the Email on Gravity Forms entry ${s.entryId} to "ada.lovelace@example.com".`,
    async grade({ client, state }) {
      const entry = await client.getEntry(state.entryId);
      const ok = String(entry['2'] || '').toLowerCase() === 'ada.lovelace@example.com';
      return { pass: ok, detail: ok ? '' : `entry email is "${entry['2']}" (want ada.lovelace@example.com)` };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'entries.delete',
    category: 'entries',
    expectedTurns: 2,
    maxTurns: 8,
    async setup(client) {
      const s = await formWithEntries(client, [{ '1': 'Ada', '2': 'ada@example.com' }]);
      return { ...s, entryId: s.entryIds[0], before: await client.countEntries(s.formId) };
    },
    prompt: (s) => `Delete Gravity Forms entry ${s.entryId}.`,
    async grade({ client, state }) {
      const after = await client.countEntries(state.formId);
      const ok = after === state.before - 1;
      return { pass: ok, detail: ok ? '' : `entry count went ${state.before} → ${after} (expected -1)` };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },
];
