/**
 * gf_update_field refuses input it would otherwise ignore.
 *
 * Measured 2026-10-09: { form_id: 73, field_id: 12, placeholder: "—" } returned
 * success: true and the field kept no placeholder, because the handler reads
 * field changes only from `properties`. The empty update still wrote the form
 * back unchanged, so the caller had every reason to believe it had worked.
 *
 * The server's rule for input that would do nothing is to refuse it and name
 * the shape that works (field_values on gf_submit_form_data, top-level paging
 * keys on gf_list_entries). These tests pin that rule for gf_update_field, and
 * that a refused call never writes the form.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldOperationHandlers, createFieldOperations } from '../src/field-operations/index.js';
import fieldRegistry from '../src/field-definitions/field-registry.js';
import FieldAwareValidator from '../src/config/field-validation.js';

const FORM_ID = 73;

function makeRig() {
  const site = {
    form: { id: FORM_ID, title: 'Contact', fields: [{ id: 12, type: 'text', label: 'Name' }] },
    writes: 0,
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const api = {
    async getForm() {
      return { form: clone(site.form) };
    },
    async replaceForm(id, form) {
      site.writes += 1;
      site.form = clone(form);
      return { form: clone(form) };
    },
  };
  const ops = createFieldOperations(api, fieldRegistry, new FieldAwareValidator());
  const update = (params) => fieldOperationHandlers.gf_update_field(params, ops);
  return { site, update };
}

test('a field property passed at the top level is refused, not ignored', async () => {
  const { site, update } = makeRig();

  await assert.rejects(
    () => update({ form_id: FORM_ID, field_id: 12, placeholder: '—' }),
    (error) => {
      assert.match(error.message, /placeholder/, 'the ignored key is named');
      assert.match(error.message, /properties: \{ placeholder/, 'the working shape is shown');
      return true;
    }
  );
  assert.equal(site.writes, 0, 'a refused call writes nothing');
  assert.equal(site.form.fields[0].placeholder, undefined);
});

test('top-level keys are refused even when properties is also given', async () => {
  const { site, update } = makeRig();

  await assert.rejects(
    () => update({ form_id: FORM_ID, field_id: 12, properties: { label: 'Full name' }, cssClass: 'wide', isRequired: true }),
    /cssClass, isRequired/
  );
  assert.equal(site.writes, 0);
  assert.equal(site.form.fields[0].label, 'Name', 'the half that was nested is not applied either');
});

test('a call with no properties is refused', async () => {
  const { site, update } = makeRig();

  await assert.rejects(() => update({ form_id: FORM_ID, field_id: 12 }), /properties/);
  assert.equal(site.writes, 0);
});

test('an empty properties object is refused', async () => {
  const { site, update } = makeRig();

  await assert.rejects(() => update({ form_id: FORM_ID, field_id: 12, properties: {} }), /properties/);
  assert.equal(site.writes, 0);
});

test('properties that is not an object is refused', async () => {
  const { site, update } = makeRig();

  for (const bad of ['placeholder', ['placeholder'], 5]) {
    await assert.rejects(() => update({ form_id: FORM_ID, field_id: 12, properties: bad }), /properties/);
  }
  assert.equal(site.writes, 0);
});

test('properties nested correctly still updates the field', async () => {
  const { site, update } = makeRig();

  const result = await update({ form_id: FORM_ID, field_id: 12, properties: { placeholder: '—' }, force: false });

  assert.equal(result.success, true);
  assert.equal(site.writes, 1);
  assert.equal(site.form.fields[0].placeholder, '—');
});
