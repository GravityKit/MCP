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

// --- include reaches the wire as GF's feed-id filter ---

test('gf_list_feeds: include ids go out as the feed-id filter GF reads', async () => {
  // GF's /feeds controller reads $request['include'] as the feed ids
  // (class-controller-feeds.php get_items). Dropping it returned every feed on the
  // site while the caller believed the result was narrowed to the ids asked for.
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => {
    gets.push({ path, params: config?.params });
    return { data: [{ id: 153, form_id: 159 }] };
  };

  await client.listFeeds({ include: [153, 154] });

  assert.equal(gets[0].path, '/feeds');
  assert.deepEqual(gets[0].params.include, [153, 154], 'include must reach GF');
});

test('gf_list_feeds: include composes with the addon and form_id filters', async () => {
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => {
    gets.push(config?.params);
    return { data: [{ id: 153, form_id: 159 }, { id: 154, form_id: 70 }] };
  };

  const out = await client.listFeeds({ include: [153, 154], addon: 'gravityformsmailchimp', form_id: 159 });

  assert.deepEqual(gets[0].include, [153, 154]);
  assert.equal(gets[0].addon, 'gravityformsmailchimp');
  assert.deepEqual(out.feeds.map((feed) => feed.id), [153], 'form_id scoping still applies on top');
});

test('gf_list_feeds: a non-numeric include id is refused rather than dropped', async () => {
  const client = makeClient();
  client.httpClient.get = async () => ({ data: [] });

  await assert.rejects(() => client.listFeeds({ include: ['abc'] }), /include/);
});

test('gf_list_feeds: no include means no include param (still lists everything asked for)', async () => {
  const client = makeClient();
  const gets = [];
  client.httpClient.get = async (path, config) => { gets.push(config?.params); return { data: [] }; };

  await client.listFeeds({ addon: 'gravityformsmailchimp' });

  assert.ok(!('include' in gets[0]), 'an absent include must not become an empty filter');
});

// --- gf_update_feed must not silently drop stored meta keys ---
//
// `{...existingFeed, ...updates}` is shallow, so a submitted `meta` replaces the
// stored one whole. A webhook feed updated with only a new feedName lost its URL,
// method and format, stayed active, and the call reported success.

const WEBHOOK_FEED = {
  id: 154,
  form_id: 161,
  addon_slug: 'gravityformswebhooks',
  is_active: '1',
  meta: { feedName: 'Hook', requestURL: 'https://example.com/hook', requestMethod: 'POST', requestFormat: 'json' },
};

function clientWithStoredFeed(feed = WEBHOOK_FEED) {
  const client = makeClient();
  const puts = [];
  client.httpClient.get = async () => ({ data: feed });
  client.httpClient.put = async (path, data) => {
    puts.push({ path, data });
    return { data: { ...data } };
  };
  return { client, puts };
}

test('gf_update_feed: a meta that omits stored keys is refused, naming each dropped key, and nothing is written', async () => {
  const { client, puts } = clientWithStoredFeed();

  await assert.rejects(
    () => client.updateFeed({ id: 154, meta: { feedName: 'MCP P6 Updated' } }),
    (error) => {
      assert.match(error.message, /requestURL/);
      assert.match(error.message, /requestMethod/);
      assert.match(error.message, /requestFormat/);
      assert.ok(!/feedName/.test(error.message.split('drop')[1] || ''), 'a key that was sent is not reported as dropped');
      assert.match(error.message, /gf_patch_feed/, 'points at the partial-update tool');
      assert.match(error.message, /replace: \["meta"\]/, 'and at the explicit opt-in');
      return true;
    }
  );
  assert.equal(puts.length, 0, 'the feed on the site must be untouched');
});

test('gf_update_feed: replace ["meta"] replaces meta on purpose and reports what it removed', async () => {
  const { client, puts } = clientWithStoredFeed();

  const out = await client.updateFeed({ id: 154, meta: { feedName: 'Only this' }, replace: ['meta'] });

  const body = wireBody(puts[0].data);
  assert.deepEqual(body.meta, { feedName: 'Only this' });
  assert.ok(!('replace' in body), 'the opt-in is ours, not a feed property');
  assert.deepEqual(out.removed_keys.sort(), ['meta.requestFormat', 'meta.requestMethod', 'meta.requestURL']);
});

test('gf_update_feed: a meta carrying every stored key (changed or added) is not refused', async () => {
  const { client, puts } = clientWithStoredFeed();
  const meta = { ...WEBHOOK_FEED.meta, feedName: 'Renamed', extra: 'new' };

  const out = await client.updateFeed({ id: 154, meta });

  assert.deepEqual(wireBody(puts[0].data).meta, meta);
  assert.ok(!('removed_keys' in out), 'nothing was removed, so nothing is reported');
});

test('gf_update_feed: is_active alone still leaves meta untouched', async () => {
  const { client, puts } = clientWithStoredFeed();

  await client.updateFeed({ id: 154, is_active: false });

  assert.deepEqual(wireBody(puts[0].data).meta, WEBHOOK_FEED.meta);
});

test('gf_update_feed: a stored feed with no meta has nothing to drop', async () => {
  const { client, puts } = clientWithStoredFeed({ id: 9, form_id: 1, addon_slug: 'x', is_active: '1' });

  await client.updateFeed({ id: 9, meta: { feedName: 'First config' } });

  assert.deepEqual(wireBody(puts[0].data).meta, { feedName: 'First config' });
});

test('gf_update_feed: replace must be an array of strings', async () => {
  const { client } = clientWithStoredFeed();
  // A meta carrying every stored key cannot trip the drop guard, so only the
  // type check on replace can refuse this call.
  await assert.rejects(() => client.updateFeed({ id: 154, meta: { ...WEBHOOK_FEED.meta }, replace: 'meta' }), /replace/);
  await assert.rejects(() => client.updateFeed({ id: 154, meta: { ...WEBHOOK_FEED.meta }, replace: [true] }), /replace/);
});

test('gf_patch_feed: replace is refused instead of silently ignored', async () => {
  const client = makeClient();
  client.httpClient.patch = async () => ({ data: {} });
  await assert.rejects(
    () => client.patchFeed({ id: 154, meta: { feedName: 'x' }, replace: ['meta'] }),
    /replace.*gf_update_feed/
  );
});

test('gf_update_feed: a stored empty value the compact reader never showed is not counted as dropped', async () => {
  // gf_get_feed compacts by default and stripEmpty drops null and '', so a caller
  // who reads, edits and sends back is missing every empty key they never saw.
  // Refusing that caller would refuse exactly the one who did the right thing.
  const feed = { ...WEBHOOK_FEED, meta: { ...WEBHOOK_FEED.meta, requestBodyType: '', requestHeaders: null } };
  const { client, puts } = clientWithStoredFeed(feed);

  const out = await client.updateFeed({ id: 154, meta: { ...WEBHOOK_FEED.meta, feedName: 'Renamed' } });

  assert.equal(puts.length, 1, 'the feed is written');
  assert.ok(!('removed_keys' in out), 'an empty key that was never sent is not a removal');
});

test('gf_update_feed: a nested object inside meta that drops stored keys is refused too', async () => {
  const feed = { ...WEBHOOK_FEED, meta: { ...WEBHOOK_FEED.meta, fieldMap: { email: '3', name: '1' } } };
  const { client, puts } = clientWithStoredFeed(feed);

  await assert.rejects(
    () => client.updateFeed({ id: 154, meta: { ...WEBHOOK_FEED.meta, fieldMap: { email: '3' } } }),
    /meta\.fieldMap\.name/
  );
  assert.equal(puts.length, 0);
});

test('gf_update_feed: replace names a property the call does not send is refused', async () => {
  const { client, puts } = clientWithStoredFeed();

  await assert.rejects(() => client.updateFeed({ id: 154, is_active: false, replace: ['meta'] }), /meta/);
  assert.equal(puts.length, 0);
});
