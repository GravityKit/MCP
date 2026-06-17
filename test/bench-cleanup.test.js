/**
 * Minted-site cleanup decision. The gate/scripts must tear a minted Docker site
 * down even when the run throws — otherwise a crash leaks a running site. The
 * decision logic is extracted so it can be unit-tested with an injected destroy;
 * the callers invoke it from a finally block (verified by reading + the gate's
 * own end-to-end run).
 *
 * Dev-only bench tooling; runs with the node:test suite.
 */

import test from 'node:test';
import assert from 'node:assert';
import { cleanupMintedSite } from '../bench/lib/siteminter.mjs';

test('cleanupMintedSite', async (t) => {
  await t.test('destroys a minted site by default', () => {
    let destroyed = null;
    cleanupMintedSite('site-x', { destroy: (n) => { destroyed = n; } });
    assert.strictEqual(destroyed, 'site-x');
  });
  await t.test('keeps the site when keep=true', () => {
    let destroyed = null;
    cleanupMintedSite('site-x', { keep: true, destroy: (n) => { destroyed = n; } });
    assert.strictEqual(destroyed, null);
  });
  await t.test('no-ops when there is no minted site (non-mint run)', () => {
    let called = false;
    cleanupMintedSite(null, { destroy: () => { called = true; } });
    assert.strictEqual(called, false);
  });
  await t.test('swallows destroy errors so a finally never masks the original throw', () => {
    assert.doesNotThrow(() =>
      cleanupMintedSite('site-x', { destroy: () => { throw new Error('boom'); }, error: () => {} }));
  });
});
