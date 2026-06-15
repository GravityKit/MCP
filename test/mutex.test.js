/**
 * Tests for ResourceMutex — proves concurrent mutations are serialized.
 *
 * These tests verify that:
 * 1. The mutex serializes operations on the same key
 * 2. Operations on different keys run concurrently
 * 3. Errors release the lock (no deadlocks)
 * 4. withLock() convenience method works correctly
 */

import { TestRunner, TestAssert, wait } from './helpers.js';
import ResourceMutex, { resourceMutex } from '../src/utils/mutex.js';

const suite = new TestRunner('Mutex & Concurrency Tests');

// ─────────────────────────────────────────────────────────
// Core mutex behavior
// ─────────────────────────────────────────────────────────

suite.test('Mutex serializes operations on the same key', async () => {
  const mutex = new ResourceMutex();
  const order = [];

  // Start two "operations" on the same key concurrently.
  const op1 = (async () => {
    const lock = await mutex.acquire('form:1');
    order.push('op1-start');
    await wait(50); // Simulate API call
    order.push('op1-end');
    lock.release();
  })();

  const op2 = (async () => {
    // Small delay so op1 acquires first
    await wait(5);
    const lock = await mutex.acquire('form:1');
    order.push('op2-start');
    await wait(10);
    order.push('op2-end');
    lock.release();
  })();

  await Promise.all([op1, op2]);

  // op2 must not start until op1 finishes
  TestAssert.deepEqual(
    order,
    ['op1-start', 'op1-end', 'op2-start', 'op2-end'],
    `Expected serialized order, got: ${order.join(', ')}`
  );
});

suite.test('Mutex allows concurrent operations on different keys', async () => {
  const mutex = new ResourceMutex();
  const order = [];

  const op1 = (async () => {
    const lock = await mutex.acquire('form:1');
    order.push('form1-start');
    await wait(50);
    order.push('form1-end');
    lock.release();
  })();

  const op2 = (async () => {
    await wait(5);
    const lock = await mutex.acquire('form:2');
    order.push('form2-start');
    await wait(10);
    order.push('form2-end');
    lock.release();
  })();

  await Promise.all([op1, op2]);

  // form2 should start before form1 ends (concurrent)
  const form2StartIdx = order.indexOf('form2-start');
  const form1EndIdx = order.indexOf('form1-end');
  TestAssert.isTrue(
    form2StartIdx < form1EndIdx,
    `form2 should start before form1 ends (concurrent). Order: ${order.join(', ')}`
  );
});

suite.test('Mutex releases lock on error (no deadlock)', async () => {
  const mutex = new ResourceMutex();
  const order = [];

  // op1 throws after acquiring lock
  const op1 = (async () => {
    try {
      await mutex.withLock('form:1', async () => {
        order.push('op1-start');
        throw new Error('Simulated failure');
      });
    } catch {
      order.push('op1-error');
    }
  })();

  // op2 should still be able to acquire the lock after op1 fails
  const op2 = (async () => {
    await wait(5);
    await mutex.withLock('form:1', async () => {
      order.push('op2-start');
      order.push('op2-end');
    });
  })();

  await Promise.all([op1, op2]);

  TestAssert.isTrue(
    order.includes('op2-start'),
    `op2 should run after op1 error. Order: ${order.join(', ')}`
  );
  TestAssert.isTrue(
    order.indexOf('op1-error') < order.indexOf('op2-start'),
    `op2 should start after op1 error released the lock. Order: ${order.join(', ')}`
  );
});

suite.test('withLock returns the function result', async () => {
  const mutex = new ResourceMutex();

  const result = await mutex.withLock('test:1', async () => {
    return { value: 42 };
  });

  TestAssert.equal(result.value, 42, 'withLock should return the function result');
});

suite.test('withLock propagates errors', async () => {
  const mutex = new ResourceMutex();

  await TestAssert.throwsAsync(
    () => mutex.withLock('test:2', async () => {
      throw new Error('Expected failure');
    }),
    'Expected failure',
    'withLock should propagate errors'
  );
});

// ─────────────────────────────────────────────────────────
// Serialization of 3+ operations (queue behavior)
// ─────────────────────────────────────────────────────────

suite.test('Three concurrent operations on same key run in sequence', async () => {
  const mutex = new ResourceMutex();
  const order = [];

  const ops = [1, 2, 3].map(async (n) => {
    await wait(n * 2); // Stagger start slightly
    await mutex.withLock('form:1', async () => {
      order.push(`op${n}-start`);
      await wait(20);
      order.push(`op${n}-end`);
    });
  });

  await Promise.all(ops);

  // Each op must fully complete before the next starts
  for (let i = 0; i < 3; i++) {
    const startIdx = order.indexOf(`op${i + 1}-start`);
    const endIdx = order.indexOf(`op${i + 1}-end`);
    TestAssert.isTrue(startIdx >= 0, `op${i + 1} should have started`);
    TestAssert.equal(endIdx, startIdx + 1, `op${i + 1} should end immediately after its start (no interleaving)`);
  }
});

// ─────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────

suite.test('Singleton resourceMutex is a ResourceMutex instance', () => {
  TestAssert.exists(resourceMutex, 'Singleton should exist');
  TestAssert.isTrue(
    resourceMutex instanceof ResourceMutex,
    'Singleton should be a ResourceMutex instance'
  );
});

// ─────────────────────────────────────────────────────────
// Simulated field operation race condition
// ─────────────────────────────────────────────────────────

suite.test('Simulated concurrent addField calls preserve both fields', async () => {
  const mutex = new ResourceMutex();

  // Simulate a form with 1 existing field
  let formState = { id: 1, fields: [{ id: 1, type: 'text', label: 'Name' }] };

  // Simulated "replaceForm" that uses the mutex
  async function safeAddField(fieldData) {
    return mutex.withLock(`form:${formState.id}`, async () => {
      // Simulate GET (re-read current state)
      const currentForm = JSON.parse(JSON.stringify(formState));

      // Add field
      const newId = currentForm.fields.length + 1;
      currentForm.fields.push({ id: newId, ...fieldData });

      // Simulate PUT latency
      await wait(20);

      // "Save" (simulate API response updating state)
      formState = currentForm;
      return { form: formState };
    });
  }

  // Fire two addField calls concurrently
  await Promise.all([
    safeAddField({ type: 'email', label: 'Email' }),
    safeAddField({ type: 'phone', label: 'Phone' }),
  ]);

  // Both fields should exist (no overwrite)
  TestAssert.equal(
    formState.fields.length,
    3,
    `Form should have 3 fields (1 original + 2 added), got ${formState.fields.length}: ${formState.fields.map(f => f.label).join(', ')}`
  );
});

suite.test('Without mutex, concurrent adds lose a field (proves the race)', async () => {
  // Simulate a form with 1 existing field
  let formState = { id: 1, fields: [{ id: 1, type: 'text', label: 'Name' }] };

  // UNSAFE version — no mutex, same pattern as old code
  async function unsafeAddField(fieldData) {
    // Simulate GET (snapshot BEFORE any modification)
    const currentForm = JSON.parse(JSON.stringify(formState));

    const newId = currentForm.fields.length + 1;
    currentForm.fields.push({ id: newId, ...fieldData });

    // Simulate PUT latency — the other call's PUT lands during this wait
    await wait(20);

    // "Save" — overwrites whatever the other call wrote
    formState = currentForm;
    return { form: formState };
  }

  // Fire two addField calls concurrently — this WILL race
  await Promise.all([
    unsafeAddField({ type: 'email', label: 'Email' }),
    unsafeAddField({ type: 'phone', label: 'Phone' }),
  ]);

  // The second write overwrites the first — only 2 fields instead of 3
  TestAssert.equal(
    formState.fields.length,
    2,
    `Without mutex, race condition should lose a field. Got ${formState.fields.length} fields.`
  );
});

// ─────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────

const isMain = process.argv[1]?.includes('mutex.test');
if (isMain) {
  suite.run().then(result => {
    if (result.failed > 0) process.exit(1);
  });
}

export default suite;
