/**
 * Per-resource mutex for serializing concurrent mutations.
 *
 * Prevents race conditions in fetch-then-merge update patterns by ensuring
 * only one mutation runs at a time for a given resource (e.g., form ID).
 *
 * Usage:
 *   const lock = await mutex.acquire('form:42');
 *   try { ... } finally { lock.release(); }
 */

import { AsyncLocalStorage } from 'node:async_hooks';

class ResourceMutex {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.locks = new Map();
    /**
     * Keys held by the current async call chain. withLock() consults it so a
     * holder that asks for the same key again (a field operation holding
     * form:42 calls replaceForm, which takes form:42) runs inside the lock it
     * already owns instead of waiting on itself forever.
     * @type {AsyncLocalStorage<Set<string>>}
     */
    this.held = new AsyncLocalStorage();
  }

  /**
   * Acquire a lock for a resource key.
   *
   * If another operation holds the lock for this key, waits until it completes.
   * Returns a lock object with a release() method.
   *
   * @param {string} key - Resource identifier (e.g., 'form:42', 'entry:100').
   * @returns {Promise<{release: () => void}>} Lock handle.
   */
  async acquire(key) {
    // Wait for any existing lock on this key to release.
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create a new lock (a Promise that resolves when released).
    let releaseFn;
    const lockPromise = new Promise((resolve) => {
      releaseFn = resolve;
    });

    this.locks.set(key, lockPromise);

    return {
      release: () => {
        this.locks.delete(key);
        releaseFn();
      }
    };
  }

  /**
   * Execute a function while holding the lock for a resource key.
   *
   * Acquires the lock, runs the function, and releases the lock when done
   * (even if the function throws). Reentrant per async call chain: a function
   * running under a key may call withLock() on that same key and runs at once.
   * acquire() is not reentrant; only withLock() is.
   *
   * @param {string} key - Resource identifier.
   * @param {() => Promise<T>} fn - Async function to execute under the lock.
   * @returns {Promise<T>} The function's return value.
   * @template T
   */
  async withLock(key, fn) {
    const heldKeys = this.held.getStore();
    const alreadyHeld = heldKeys !== undefined && heldKeys.has(key);
    if (alreadyHeld) {
      // Reentrant: this call chain owns the key. Waiting would deadlock, and
      // exclusion against everyone else already holds.
      return fn();
    }

    const lock = await this.acquire(key);
    try {
      const nowHeld = new Set(heldKeys || []);
      nowHeld.add(key);
      return await this.held.run(nowHeld, fn);
    } finally {
      lock.release();
    }
  }
}

// Singleton instance shared across the client.
export const resourceMutex = new ResourceMutex();
export default ResourceMutex;
