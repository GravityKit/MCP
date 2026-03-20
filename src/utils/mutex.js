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

class ResourceMutex {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.locks = new Map();
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
   * (even if the function throws).
   *
   * @param {string} key - Resource identifier.
   * @param {() => Promise<T>} fn - Async function to execute under the lock.
   * @returns {Promise<T>} The function's return value.
   * @template T
   */
  async withLock(key, fn) {
    const lock = await this.acquire(key);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
}

// Singleton instance shared across the client.
export const resourceMutex = new ResourceMutex();
export default ResourceMutex;
