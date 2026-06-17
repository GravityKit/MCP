/**
 * Bench agent runner robustness. The gate drives the `claude` CLI via spawn;
 * if that binary is missing / not executable, the ChildProcess emits 'error'.
 * Without a handler that event is unhandled — it crashes the whole gate or
 * leaves the run's Promise pending forever. runOnce must instead resolve with a
 * hardError so the run scores as a failure and the suite keeps going.
 *
 * Dev-only bench tooling; runs with the node:test suite.
 */

import test from 'node:test';
import assert from 'node:assert';
import { runOnce } from '../bench/lib/agent.mjs';

test('runOnce resolves with a hardError when the claude binary cannot spawn', async () => {
  // 5th arg pins the binary; a path that does not exist forces an ENOENT spawn error.
  const res = await runOnce('hi', '/tmp/nonexistent-mcp.json', null, 1, '/nonexistent/claude-binary-xyz');
  assert.ok(res, 'runOnce must resolve (not reject or hang) on spawn failure');
  assert.match(String(res.hardError || ''), /spawn_failed/, 'hardError should mark the spawn failure');
  assert.strictEqual(res.turns, 0);
});
