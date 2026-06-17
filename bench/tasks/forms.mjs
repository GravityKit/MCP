/**
 * Gravity Forms plane — form + field CRUD, notifications, confirmations.
 * Graders read the persisted form object (GF REST), never the agent's narration.
 */

import { uniqueLabel } from './helpers.mjs';

const fields = (form) => (Array.isArray(form.fields) ? form.fields : []);
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const hasType = (form, type) => fields(form).some((f) => String(f.type) === type);

export default [
  {
    id: 'forms.create-complex',
    category: 'forms',
    async setup() { return { title: uniqueLabel('BENCH Form') }; },
    prompt: (s) =>
      `Create a new Gravity Forms form titled "${s.title}" for event registration with these fields: ` +
      `a Name field, an Email field, a Phone field, a dropdown for "T-shirt size" with options Small/Medium/Large, ` +
      `and a paragraph (multi-line) "Notes" field.`,
    async grade({ client, state }) {
      const form = await client.findFormByTitle(state.title);
      if (!form) return { pass: false, detail: 'no form with that title was created' };
      state.formId = form.id;
      const full = await client.getForm(form.id);
      const ok = fields(full).length >= 5 && hasType(full, 'email') && hasType(full, 'select') && hasType(full, 'textarea');
      return { pass: ok, detail: ok ? '' : `created with ${fields(full).length} fields; types=[${fields(full).map((f) => f.type).join(',')}] (want email+select+textarea)` };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'forms.add-field',
    category: 'forms',
    async setup(client) { return { formId: (await client.createForm(uniqueLabel('BENCH Form'))).id }; },
    prompt: (s) => `Add a Date field labeled "Event Date" to Gravity Forms form ${s.formId}.`,
    async grade({ client, state }) {
      const form = await client.getForm(state.formId);
      const ok = fields(form).some((f) => String(f.type) === 'date' && /event date/i.test(f.label || ''));
      return { pass: ok, detail: ok ? '' : 'no Date field labeled "Event Date" on the form' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'forms.make-field-required',
    category: 'forms',
    async setup(client) { return { formId: (await client.createForm(uniqueLabel('BENCH Form'))).id }; },
    prompt: (s) => `On Gravity Forms form ${s.formId}, make the Email field required.`,
    async grade({ client, state }) {
      const form = await client.getForm(state.formId);
      const email = fields(form).find((f) => String(f.id) === '2');
      const ok = !!email && (email.isRequired === true || email.isRequired === '1' || email.isRequired === 1);
      return { pass: ok, detail: ok ? '' : 'Email field is not marked required' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'forms.delete-field',
    category: 'forms',
    async setup(client) { return { formId: (await client.createForm(uniqueLabel('BENCH Form'))).id }; },
    prompt: (s) => `Remove the Last Name field from Gravity Forms form ${s.formId}.`,
    async grade({ client, state }) {
      const form = await client.getForm(state.formId);
      const stillThere = fields(form).some((f) => String(f.id) === '3' || /last name/i.test(f.label || ''));
      return { pass: !stillThere, detail: stillThere ? 'Last Name field is still on the form' : '' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'forms.add-notification',
    category: 'forms',
    async setup(client) { return { formId: (await client.createForm(uniqueLabel('BENCH Form'))).id }; },
    prompt: (s) =>
      `Add an admin email notification to Gravity Forms form ${s.formId} that fires when the form is submitted, ` +
      `sending to admin@example.com with the subject "New registration".`,
    async grade({ client, state }) {
      const form = await client.getForm(state.formId);
      const ok = list(form.notifications).some((n) => /admin@example\.com/.test(JSON.stringify(n?.to || '')) || /admin@example\.com/.test(JSON.stringify(n)));
      return { pass: ok, detail: ok ? '' : 'no notification targeting admin@example.com was added' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },

  {
    id: 'forms.add-confirmation',
    category: 'forms',
    async setup(client) { return { formId: (await client.createForm(uniqueLabel('BENCH Form'))).id }; },
    prompt: (s) => `Add a confirmation to Gravity Forms form ${s.formId} that shows the message "Thanks for registering!".`,
    async grade({ client, state }) {
      const form = await client.getForm(state.formId);
      const ok = list(form.confirmations).some((c) => /thanks for registering/i.test(String(c?.message || '')));
      return { pass: ok, detail: ok ? '' : 'no confirmation with the expected message was added' };
    },
    async teardown({ client, state }) { if (state.formId) await client.deleteForm(state.formId); },
  },
];
