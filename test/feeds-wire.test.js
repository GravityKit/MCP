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

test('gf_create_feed: is_active:false produces an inactive feed on the wire', async () => {
  // The tool schema advertises is_active, but the create branch of
  // getFeedDataSchema omitted it, so validation silently dropped it. And
  // GF's POST /feeds only consumes form_id/meta/addon_slug (GFAPI::add_feed),
  // so honoring is_active:false requires a follow-up PATCH after the create.
  const client = makeClient();
  const posts = [];
  const patches = [];
  client.httpClient.post = async (path, data) => {
    posts.push({ path, data });
    return { data: { id: 7, form_id: 1, addon_slug: data.addon_slug, is_active: '1', meta: data.meta } };
  };
  client.httpClient.patch = async (path, data) => {
    patches.push({ path, data });
    return { data: { id: 7, form_id: 1, addon_slug: 'gravityformsmailchimp', is_active: '0', meta: { feedName: 'X' } } };
  };

  const { feed } = await client.createFeed({
    addon_slug: 'gravityformsmailchimp',
    form_id: 1,
    meta: { feedName: 'X' },
    is_active: false,
  });

  assert.equal(posts.length, 1, 'expected one POST');
  assert.equal(patches.length, 1, 'is_active:false requires a follow-up PATCH (GF ignores it on POST)');
  assert.equal(patches[0].path, '/feeds/7');
  assert.deepEqual(wireBody(patches[0].data), { is_active: false });
  assert.equal(feed.is_active, '0', 'returned feed must reflect the inactive state');
});

test('gf_create_feed: no follow-up PATCH when is_active is omitted or true', async () => {
  const client = makeClient();
  const patches = [];
  client.httpClient.post = async (path, data) => ({ data: { id: 8, is_active: '1', ...data } });
  client.httpClient.patch = async (path, data) => { patches.push({ path, data }); return { data: {} }; };

  await client.createFeed({ addon_slug: 'slug', form_id: 1, meta: { feedName: 'A' } });
  await client.createFeed({ addon_slug: 'slug', form_id: 1, meta: { feedName: 'B' }, is_active: true });

  assert.equal(patches.length, 0, 'active feeds need no follow-up PATCH');
});

test('gf_create_feed: a failed deactivation still returns the feed id', async () => {
  // The feed exists by the time the PATCH runs. Throwing loses the id, so a caller
  // that retries creates a second feed.
  const client = makeClient();
  client.httpClient.post = async () => ({ data: { id: 77 } });
  client.httpClient.patch = async () => { throw new Error('boom'); };

  const out = await client.createFeed({ form_id: 1, addon_slug: 'x', meta: {}, is_active: false });

  assert.equal(out.feed.id, 77, 'the id survives so nobody creates a duplicate');
  assert.equal(out.is_active, true, 'and it is reported as still active');
  assert.match(out.warning, /could not be deactivated/);
});
