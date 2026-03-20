/**
 * Feeds Endpoint Tests for Gravity MCP
 * Tests all 7 add-on feed management tools
 */

import GravityFormsClient from '../gravity-forms-client.js';
import {
  TestRunner,
  TestAssert,
  MockHttpClient,
  MockResponse,
  setupTestEnvironment,
  generateMockFeed,
  generateId
} from './helpers.js';

const suite = new TestRunner('Feeds Endpoint Tests');

let client;
let mockHttpClient;
let testEnv;

suite.beforeEach(() => {
  testEnv = setupTestEnvironment();
  mockHttpClient = new MockHttpClient();

  client = new GravityFormsClient(testEnv);
  client.httpClient = mockHttpClient;
  client.allowDelete = true;

  mockHttpClient.setMockResponse('GET', '/forms', new MockResponse({ forms: [] }));
});

// =================================
// LIST FEEDS TESTS
// =================================

suite.test('List Feeds: Should list all feeds', async () => {
  const mockFeeds = [
    generateMockFeed(1, 'gravityformsmailchimp'),
    generateMockFeed(2, 'gravityformspaypal')
  ];

  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse(mockFeeds));

  const result = await client.listFeeds();

  TestAssert.lengthOf(result.feeds, 2);
  TestAssert.equal(result.feeds[0].addon_slug, 'gravityformsmailchimp');
});

suite.test('List Feeds: Should filter by addon', async () => {
  const mailchimpFeeds = [
    generateMockFeed(1, 'gravityformsmailchimp', { id: 10 }),
    generateMockFeed(2, 'gravityformsmailchimp', { id: 11 })
  ];

  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse(mailchimpFeeds));

  const result = await client.listFeeds({ addon: 'gravityformsmailchimp' });

  TestAssert.lengthOf(result.feeds, 2);
  result.feeds.forEach(feed => {
    TestAssert.equal(feed.addon_slug, 'gravityformsmailchimp');
  });
});

suite.test('List Feeds: Should filter by form_id', async () => {
  const formFeeds = [
    generateMockFeed(5, 'gravityformsmailchimp'),
    generateMockFeed(5, 'gravityformsstripe')
  ];

  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse(formFeeds));

  const result = await client.listFeeds({ form_id: 5 });

  TestAssert.lengthOf(result.feeds, 2);
  result.feeds.forEach(feed => {
    TestAssert.equal(feed.form_id, 5);
  });
});

suite.test('List Feeds: Should validate addon slug format', async () => {
  await TestAssert.throwsAsync(
    () => client.listFeeds({ addon: 'Invalid Addon!' }),
    'valid slug format',
    'Should validate addon slug'
  );
});

// =================================
// GET FEED TESTS
// =================================

suite.test('Get Feed: Should get specific feed by ID', async () => {
  const mockFeed = generateMockFeed(1, 'gravityformsmailchimp', { id: 123 });

  mockHttpClient.setMockResponse('GET', '/feeds/123', new MockResponse(mockFeed));

  const result = await client.getFeed({ id: 123 });

  TestAssert.equal(result.feed.id, 123);
  TestAssert.equal(result.feed.addon_slug, 'gravityformsmailchimp');
  TestAssert.equal(result.feed.form_id, 1);
  TestAssert.isTrue(result.feed.is_active);
});

suite.test('Get Feed: Should handle complex feed configuration', async () => {
  const complexFeed = generateMockFeed(1, 'gravityformsstripe', {
    id: 1,
    meta: {
      feedName: 'Product Purchase',
      transactionType: 'product',
      paymentAmount: 'form_total',
      billingCycle_length: '1',
      billingCycle_unit: 'month',
      trial_enabled: '1',
      trial_amount: '0',
      trial_duration: '7',
      setupFee_enabled: '0',
      conditionalLogic: {
        enabled: true,
        actionType: 'show',
        rules: [
          { fieldId: '5', operator: 'is', value: 'premium' }
        ]
      }
    }
  });

  mockHttpClient.setMockResponse('GET', '/feeds/1', new MockResponse(complexFeed));

  const result = await client.getFeed({ id: 1 });

  TestAssert.equal(result.feed.meta.transactionType, 'product');
  TestAssert.isTrue(result.feed.meta.conditionalLogic.enabled);
});

suite.test('Get Feed: Should handle non-existent feed (404)', async () => {
  mockHttpClient.setMockResponse('GET', '/feeds/999', new MockResponse(
    { message: 'Feed not found' },
    404
  ));

  await TestAssert.throwsAsync(
    () => client.getFeed({ id: 999 }),
    'not found',
    'Should handle 404 error'
  );
});

// =================================
// LIST FORM FEEDS TESTS
// =================================

suite.test('List Form Feeds: Should get all feeds for specific form', async () => {
  const formFeeds = [
    generateMockFeed(10, 'gravityformsmailchimp'),
    generateMockFeed(10, 'gravityformsstripe'),
    generateMockFeed(10, 'gravityformspaypal')
  ];

  mockHttpClient.setMockResponse('GET', '/forms/10/feeds', new MockResponse(formFeeds));

  const result = await client.listFormFeeds({ form_id: 10 });

  TestAssert.lengthOf(result.feeds, 3);
});

suite.test('List Form Feeds: Should handle form with no feeds', async () => {
  mockHttpClient.setMockResponse('GET', '/forms/1/feeds', new MockResponse([]));

  const result = await client.listFormFeeds({ form_id: 1 });

  TestAssert.lengthOf(result.feeds, 0);
});

suite.test('List Form Feeds: Should require form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.listFormFeeds({}),
    'form_id',
    'Should require form_id'
  );
});

// =================================
// CREATE FEED TESTS
// =================================

suite.test('Create Feed: Should create new MailChimp feed', async () => {
  const newFeed = generateMockFeed(1, 'gravityformsmailchimp', { id: 500 });

  mockHttpClient.setMockResponse('POST', '/feeds', new MockResponse(newFeed));

  const result = await client.createFeed({
    addon_slug: 'gravityformsmailchimp',
    form_id: 1,
    is_active: true,
    meta: {
      feedName: 'Newsletter Signup',
      mailchimpList: 'list123',
      mappedFields_EMAIL: '2',
      mappedFields_FNAME: '1.3',
      mappedFields_LNAME: '1.6'
    }
  });

  TestAssert.equal(result.feed.id, 500);
  TestAssert.equal(result.feed.addon_slug, 'gravityformsmailchimp');
});

suite.test('Create Feed: Should create Stripe feed with complex settings', async () => {
  const stripeFeed = {
    addon_slug: 'gravityformsstripe',
    form_id: 5,
    is_active: true,
    meta: {
      feedName: 'Subscription',
      transactionType: 'subscription',
      paymentAmount: 'form_total',
      billingCycle_length: '1',
      billingCycle_unit: 'month',
      recurringAmount: '99.99',
      setupFee_enabled: '1',
      setupFee_amount: '25.00'
    }
  };

  mockHttpClient.setMockResponse('POST', '/feeds', new MockResponse({
    ...stripeFeed,
    id: 600
  }));

  const result = await client.createFeed(stripeFeed);

  TestAssert.equal(result.feed.meta.transactionType, 'subscription');
  TestAssert.equal(result.feed.meta.setupFee_amount, '25.00');
});

suite.test('Create Feed: Should require addon_slug', async () => {
  await TestAssert.throwsAsync(
    () => client.createFeed({ form_id: 1, meta: {} }),
    'addon_slug',
    'Should require addon_slug'
  );
});

suite.test('Create Feed: Should require form_id', async () => {
  await TestAssert.throwsAsync(
    () => client.createFeed({ addon_slug: 'test', meta: {} }),
    'form_id',
    'Should require form_id'
  );
});

suite.test('Create Feed: Should require meta object', async () => {
  await TestAssert.throwsAsync(
    () => client.createFeed({ addon_slug: 'test', form_id: 1 }),
    'meta',
    'Should require meta object'
  );
});

// =================================
// UPDATE FEED TESTS
// =================================

suite.test('Update Feed: Should update existing feed completely', async () => {
  const updatedFeed = generateMockFeed(1, 'gravityformsmailchimp', {
    id: 100,
    meta: {
      feedName: 'Updated Feed Name',
      mailchimpList: 'newlist456'
    }
  });

  mockHttpClient.setMockResponse('PUT', '/feeds/100', new MockResponse(updatedFeed));

  const result = await client.updateFeed({
    id: 100,
    is_active: true,
    meta: {
      feedName: 'Updated Feed Name',
      mailchimpList: 'newlist456'
    }
  });

  TestAssert.equal(result.feed.meta.feedName, 'Updated Feed Name');
});

suite.test('Update Feed: Should handle conditional logic updates', async () => {
  const feedWithLogic = {
    id: 1,
    is_active: true,
    meta: {
      conditionalLogic: {
        enabled: true,
        actionType: 'hide',
        rules: [
          { fieldId: '10', operator: 'isnot', value: 'exclude' }
        ]
      }
    }
  };

  mockHttpClient.setMockResponse('PUT', '/feeds/1', new MockResponse({
    ...feedWithLogic,
    addon_slug: 'gravityformsmailchimp',
    form_id: 1
  }));

  const result = await client.updateFeed(feedWithLogic);

  TestAssert.isTrue(result.feed.meta.conditionalLogic.enabled);
  TestAssert.equal(result.feed.meta.conditionalLogic.actionType, 'hide');
});

// =================================
// PATCH FEED TESTS
// =================================

suite.test('Patch Feed: Should partially update feed', async () => {
  const patchedFeed = generateMockFeed(1, 'gravityformsmailchimp', {
    id: 100,
    is_active: false
  });

  mockHttpClient.setMockResponse('PATCH', '/feeds/100', new MockResponse(patchedFeed));

  const result = await client.patchFeed({
    id: 100,
    is_active: false
  });

  TestAssert.isFalse(result.feed.is_active);
});

suite.test('Patch Feed: Should update only specified meta fields', async () => {
  const originalMeta = {
    feedName: 'Original Name',
    mailchimpList: 'list123',
    mappedFields_EMAIL: '2'
  };

  const patchedFeed = generateMockFeed(1, 'gravityformsmailchimp', {
    id: 1,
    meta: {
      ...originalMeta,
      feedName: 'New Name'
    }
  });

  mockHttpClient.setMockResponse('PATCH', '/feeds/1', new MockResponse(patchedFeed));

  const result = await client.patchFeed({
    id: 1,
    meta: { feedName: 'New Name' }
  });

  TestAssert.equal(result.feed.meta.feedName, 'New Name');
  TestAssert.equal(result.feed.meta.mailchimpList, 'list123');
});

// =================================
// DELETE FEED TESTS
// =================================

suite.test('Delete Feed: Should delete feed', async () => {
  mockHttpClient.setMockResponse('DELETE', '/feeds/100', new MockResponse({}));

  const result = await client.deleteFeed({ id: 100 });

  TestAssert.isTrue(result.deleted);
  TestAssert.equal(result.feed_id, 100);
});

suite.test('Delete Feed: Should require ALLOW_DELETE=true', async () => {
  client.allowDelete = false;

  await TestAssert.throwsAsync(
    () => client.deleteFeed({ id: 1 }),
    'Delete operations are disabled',
    'Should check delete permission'
  );
});

// =================================
// EDGE CASES AND FAILURE MODES
// =================================

suite.test('Edge Case: Should handle feeds for all supported addons', async () => {
  const supportedAddons = [
    'gravityformsmailchimp',
    'gravityformsstripe',
    'gravityformspaypal',
    'gravityformsauthorizenet',
    'gravityformszapier',
    'gravityformsactivecampaign',
    'gravityformshubspot',
    'gravityformsslack',
    'gravityformstwilio',
    'gravityformsdropbox'
  ];

  const feeds = supportedAddons.map((addon, i) =>
    generateMockFeed(1, addon, { id: i + 1 })
  );

  mockHttpClient.setMockResponse('GET', '/feeds', new MockResponse(feeds));

  const result = await client.listFeeds();

  TestAssert.lengthOf(result.feeds, 10);
  TestAssert.equal(result.feeds[9].addon_slug, 'gravityformsdropbox');
});

suite.test('Edge Case: Should handle feed with complex field mappings', async () => {
  const complexMapping = {
    id: 1,
    addon_slug: 'gravityformshubspot',
    form_id: 1,
    meta: {
      feedName: 'HubSpot Integration',
      mappedFields: {
        email: '2',
        firstname: '1.3',
        lastname: '1.6',
        phone: '5',
        company: '10',
        website: '11',
        address: '12.1',
        city: '12.3',
        state: '12.4',
        zip: '12.5',
        country: '12.6'
      },
      customFields: [
        { key: 'custom_field_1', value: '15' },
        { key: 'custom_field_2', value: '16' }
      ]
    }
  };

  mockHttpClient.setMockResponse('GET', '/feeds/1', new MockResponse(complexMapping));

  const result = await client.getFeed({ id: 1 });

  TestAssert.equal(result.feed.meta.mappedFields.email, '2');
  TestAssert.lengthOf(result.feed.meta.customFields, 2);
});

suite.test('Failure Mode: Should handle addon not installed', async () => {
  mockHttpClient.setMockResponse('POST', '/feeds', new MockResponse(
    { message: 'Add-on gravityformsunknown is not installed or active' },
    400
  ));

  await TestAssert.throwsAsync(
    () => client.createFeed({
      addon_slug: 'gravityformsunknown',
      form_id: 1,
      meta: {}
    }),
    'not installed',
    'Should handle missing addon'
  );
});

suite.test('Failure Mode: Should handle invalid field mappings', async () => {
  mockHttpClient.setMockResponse('POST', '/feeds', new MockResponse(
    { message: 'Invalid field mapping: Field 99 does not exist' },
    400
  ));

  await TestAssert.throwsAsync(
    () => client.createFeed({
      addon_slug: 'gravityformsmailchimp',
      form_id: 1,
      meta: { mappedFields_EMAIL: '99' }
    }),
    'Invalid field mapping',
    'Should validate field mappings'
  );
});

// Run tests when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
suite.run().then(results => {
  process.exit(results.failed > 0 ? 1 : 0);
});

}

export default suite;