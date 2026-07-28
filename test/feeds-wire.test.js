/**
 * Wire tests for the feed update path + the ValidationSchema root cause.
 *
 * ValidationSchema.validate() used to materialize a key for EVERY declared
 * field, including ones the caller omitted (`meta: undefined`). The
 * fetch-then-merge in updateFeed then spread that `undefined` over the
 * fetched meta, so the PUT body shipped with NO `meta` at all — a partial
 * update (e.g. toggling is_active) silently wiped the feed's configuration.
 *
 * These tests assert on the ACTUAL outgoing request body (what axios
 * serializes), not just the method's return value.
 */

import test from 'node:test';
import assert from 'node:assert';
import { GravityFormsClient } from '../src/gravity-forms-client.js';
import { ValidationSchema, validate } from '../src/config/validation-chain.js';

function makeClient() {
  return new GravityFormsClient({
    GRAVITY_FORMS_BASE_URL: 'https://example.test',
    GRAVITY_FORMS_CONSUMER_KEY: 'user',
    GRAVITY_FORMS_CONSUMER_SECRET: 'pass',
  });
}

// What actually goes on the wire: JSON.stringify drops undefined-valued keys.
const wireBody = (data) => JSON.parse(JSON.stringify(data));

test('gf_update_feed: partial update preserves the fetched meta on the wire', async () => {
  const client = makeClient();
  const existingFeed = {
    id: 5,
    form_id: 1,
    addon_slug: 'gravityformsmailchimp',
    is_active: true,
    meta: { feedName: 'My Feed', listId: 'abc' },
  };
  const puts = [];
  client.httpClient.get = async () => ({ data: existingFeed });
  client.httpClient.put = async (path, data) => {
    puts.push({ path, data });
    return { data: { ...data } };
  };

  await client.updateFeed({ id: 5, is_active: false });

  assert.equal(puts.length, 1, 'expected exactly one PUT');
  const body = wireBody(puts[0].data);
  assert.deepEqual(
    body.meta,
    existingFeed.meta,
    'PUT body must carry the existing meta when the caller did not send one'
  );
  assert.equal(body.is_active, false, 'the requested change must still apply');
  assert.equal(body.addon_slug, 'gravityformsmailchimp');
});

test('gf_update_feed: a caller-supplied meta still replaces the fetched one', async () => {
  const client = makeClient();
  const existingFeed = { id: 5, form_id: 1, addon_slug: 'slug', meta: { feedName: 'Old' } };
  const puts = [];
  client.httpClient.get = async () => ({ data: existingFeed });
  client.httpClient.put = async (path, data) => {
    puts.push({ path, data });
    return { data: { ...data } };
  };

  await client.updateFeed({ id: 5, meta: { feedName: 'New' } });

  assert.deepEqual(wireBody(puts[0].data).meta, { feedName: 'New' });
});

test('gf_patch_feed: omitted declared fields do not appear in the PATCH body at all', async () => {
  const client = makeClient();
  const patches = [];
  client.httpClient.patch = async (path, data) => {
    patches.push({ path, data });
    return { data: { id: 5, ...data } };
  };

  await client.patchFeed({ id: 5, is_active: false });

  assert.equal(patches.length, 1);
  const raw = patches[0].data;
  assert.ok(!('meta' in raw), 'omitted meta must not be materialized as an undefined key');
  assert.deepEqual(raw, { is_active: false });
});

test('ValidationSchema.validate: does not materialize keys for omitted optional fields', () => {
  const schema = new ValidationSchema()
    .field('id', validate('id').required().positiveInteger())
    .field('meta', validate('meta').object())
    .field('is_active', validate('is_active').boolean());

  const out = schema.validate({ id: 5 });

  assert.ok(!('meta' in out), 'omitted meta must not be present');
  assert.ok(!('is_active' in out), 'omitted is_active must not be present');
  assert.deepEqual(out, { id: 5 });
});

test('ValidationSchema.validate: still throws for a missing required field', () => {
  const schema = new ValidationSchema().field('id', validate('id').required().positiveInteger());
  assert.throws(() => schema.validate({}), /Validation failed/);
});

test('ValidationSchema.validate: falsy-but-real values (false, 0, null) survive', () => {
  const schema = new ValidationSchema()
    .field('is_active', validate('is_active').boolean())
    .field('anything', validate('anything'));

  const out = schema.validate({ is_active: false, anything: null });
  assert.equal(out.is_active, false);
  assert.equal(out.anything, null);
  assert.ok('anything' in out);
});

test('gf_update_form: partial update preserves unmentioned form properties on the wire', async () => {
  // Guard the same merge contract on the form path — forms use a pass-through
  // validator today, but this pins the fetch-then-merge behavior regardless of
  // which validation layer forms adopt later.
  const client = makeClient();
  const existingForm = {
    id: 9,
    title: 'Old Title',
    fields: [{ id: 1, type: 'text', label: 'Name' }],
    confirmations: { a: { type: 'message' } },
  };
  const puts = [];
  client.httpClient.get = async () => ({ data: existingForm });
  client.httpClient.put = async (path, data) => {
    puts.push({ path, data });
    return { data: { ...data } };
  };

  await client.updateForm({ id: 9, title: 'New Title' });

  const body = wireBody(puts[0].data);
  assert.equal(body.title, 'New Title');
  assert.deepEqual(body.fields, existingForm.fields, 'fields must survive a title-only update');
  assert.deepEqual(body.confirmations, existingForm.confirmations);
});
