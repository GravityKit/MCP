/**
 * Concurrent field operations on one form.
 *
 * Measured live: ten parallel gf_add_field calls all returned success and the
 * SAME new field id, and the form kept one of the ten. The field operations
 * read the form, changed it, then wrote it back, and the lock covered only the
 * write, so every call worked from the same stored state.
 *
 * These tests drive the real GravityFormsClient and FieldManager against a fake
 * Gravity Forms whose GET waits at a gate. The gate opens once every caller has
 * issued its GET (or after a short timeout), so callers that are NOT serialized
 * all read the same state, as they did in production. A test that awaits each
 * call in turn cannot reproduce this and is not what is pinned here.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { createFieldOperations } from '../src/field-operations/index.js';
import fieldRegistry from '../src/field-definitions/field-registry.js';
import FieldAwareValidator from '../src/config/field-validation.js';
import ResourceMutex from '../src/utils/mutex.js';

const FORM_ID = 176;

/**
 * Fake Gravity Forms holding one form. GET blocks at a gate that opens when
 * `expectedReaders` GETs are waiting or after `gateTimeoutMs`.
 */
function makeSite({ fields, expectedReaders, gateTimeoutMs = 25 }) {
  const site = {
    form: { id: FORM_ID, title: 'Race', fields },
    gets: 0,
    puts: 0,
    waiting: [],
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  site.get = async () => {
    site.gets += 1;
    const snapshot = clone(site.form);
    await new Promise((resolve) => {
      site.waiting.push(resolve);
      const open = () => {
        const release = site.waiting.splice(0);
        release.forEach((fn) => fn());
      };
      if (site.waiting.length >= expectedReaders) open();
      else setTimeout(open, gateTimeoutMs);
    });
    return { data: snapshot };
  };

  site.put = async (path, body) => {
    site.puts += 1;
    // A PUT takes a moment to land, as it does over the network.
    await new Promise((resolve) => setTimeout(resolve, 2));
    site.form = clone(body);
    return { data: clone(site.form) };
  };

  return site;
}

function makeRig(site) {
  const client = new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass',
    GRAVITY_FORMS_ALLOW_DELETE: 'true',
  });
  client.httpClient.get = site.get;
  client.httpClient.put = site.put;
  client.allowDelete = true;
  const { fieldManager } = createFieldOperations(client, fieldRegistry, new FieldAwareValidator());
  return { client, fieldManager };
}

const labels = (form) => form.fields.map((f) => f.label);
const ids = (form) => form.fields.map((f) => Number(f.id));

test('ten concurrent addField calls create ten fields with ten distinct ids', async () => {
  const N = 10;
  const site = makeSite({ fields: [{ id: 1, type: 'text', label: 'Base' }], expectedReaders: N });
  const { fieldManager } = makeRig(site);

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fieldManager.addField(FORM_ID, 'text', { label: `C${String(i + 1).padStart(2, '0')}` })
    )
  );

  const reportedIds = results.map((r) => Number(r.field.id));
  assert.strictEqual(new Set(reportedIds).size, N, `reported ids must be distinct, got ${reportedIds.join(',')}`);
  assert.strictEqual(site.form.fields.length, N + 1, `form holds ${site.form.fields.length} fields: ${labels(site.form).join(',')}`);
  assert.strictEqual(new Set(ids(site.form)).size, N + 1, 'stored ids are distinct');

  // Every id a caller was handed names the field that caller asked for.
  results.forEach((result, i) => {
    const stored = site.form.fields.find((f) => Number(f.id) === Number(result.field.id));
    assert.ok(stored, `field ${result.field.id} reported to caller ${i} does not exist`);
    assert.strictEqual(stored.label, `C${String(i + 1).padStart(2, '0')}`);
  });
});

test('concurrent updateField calls on different fields all persist', async () => {
  const N = 6;
  const fields = Array.from({ length: N }, (_, i) => ({ id: i + 1, type: 'text', label: `F${i + 1}` }));
  const site = makeSite({ fields, expectedReaders: N });
  const { fieldManager } = makeRig(site);

  await Promise.all(
    fields.map((f) => fieldManager.updateField(FORM_ID, f.id, { label: `Renamed ${f.id}` }))
  );

  assert.deepStrictEqual(labels(site.form), fields.map((f) => `Renamed ${f.id}`));
});

test('concurrent deleteField calls on different fields all take effect', async () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, type: 'text', label: `F${i + 1}` }));
  const site = makeSite({ fields, expectedReaders: 5 });
  const { fieldManager } = makeRig(site);

  await Promise.all([1, 2, 3, 4, 5].map((id) => fieldManager.deleteField(FORM_ID, id)));

  assert.deepStrictEqual(ids(site.form), [6], `left: ${ids(site.form).join(',')}`);
});

test('a mix of add, update and delete in flight at once all land', async () => {
  const fields = [1, 2, 3].map((id) => ({ id, type: 'text', label: `F${id}` }));
  const site = makeSite({ fields, expectedReaders: 4 });
  const { fieldManager } = makeRig(site);

  const [added] = await Promise.all([
    fieldManager.addField(FORM_ID, 'text', { label: 'New' }),
    fieldManager.updateField(FORM_ID, 1, { label: 'One' }),
    fieldManager.deleteField(FORM_ID, 2),
    fieldManager.addField(FORM_ID, 'text', { label: 'New2' }),
  ]);

  assert.deepStrictEqual(labels(site.form).sort(), ['F3', 'New', 'New2', 'One']);
  assert.ok(site.form.fields.some((f) => Number(f.id) === Number(added.field.id)));
  assert.strictEqual(new Set(ids(site.form)).size, 4);
});

test('operations on different forms do not wait on each other', async () => {
  const mutex = new ResourceMutex();
  let release;
  const held = mutex.withLock('form:1', () => new Promise((resolve) => { release = resolve; }));
  const other = await mutex.withLock('form:2', async () => 'ran');
  assert.strictEqual(other, 'ran');
  release();
  await held;
});

test('the lock is reentrant: a holder can take the same key again without deadlock', async () => {
  const mutex = new ResourceMutex();
  const outcome = await Promise.race([
    mutex.withLock('form:1', () => mutex.withLock('form:1', async () => 'inner')),
    new Promise((resolve) => setTimeout(() => resolve('DEADLOCK'), 500)),
  ]);
  assert.strictEqual(outcome, 'inner');
});

test('a reentrant holder still excludes other callers until the outer lock ends', async () => {
  const mutex = new ResourceMutex();
  const order = [];
  const outer = mutex.withLock('form:1', async () => {
    order.push('outer-start');
    await mutex.withLock('form:1', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('inner'); });
    order.push('outer-end');
  });
  const rival = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    await mutex.withLock('form:1', async () => { order.push('rival'); });
  })();
  await Promise.all([outer, rival]);
  assert.deepStrictEqual(order, ['outer-start', 'inner', 'outer-end', 'rival']);
});

test('the lock is released when the guarded work throws', async () => {
  const mutex = new ResourceMutex();
  await assert.rejects(mutex.withLock('form:1', async () => { throw new Error('boom'); }), /boom/);
  const after = await Promise.race([
    mutex.withLock('form:1', async () => 'free'),
    new Promise((resolve) => setTimeout(() => resolve('STUCK'), 500)),
  ]);
  assert.strictEqual(after, 'free');
});

test('addField refuses to report a field that the returned form does not hold', async () => {
  const site = makeSite({ fields: [{ id: 1, type: 'text', label: 'Base' }], expectedReaders: 1 });
  const { client, fieldManager } = makeRig(site);
  // Gravity Forms answers the PUT with a form that lacks the new field.
  client.httpClient.put = async () => ({ data: { id: FORM_ID, title: 'Race', fields: [{ id: 1, type: 'text', label: 'Base' }] } });

  await assert.rejects(fieldManager.addField(FORM_ID, 'text', { label: 'Ghost' }), /not in the form Gravity Forms returned/);
});
