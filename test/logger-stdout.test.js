/**
 * The MCP server speaks JSON-RPC over stdout. ANY log byte written to stdout
 * corrupts the transport and breaks the MCP handshake (the client sees a
 * malformed message and the server hangs in "pending" with 0 tools).
 *
 * Logs must therefore go to stderr whenever the process runs as a server —
 * which is the default for every NODE_ENV except an explicit test context. The
 * original detection (`!NODE_ENV || NODE_ENV === 'production'`) got this
 * backwards: it routed the common `NODE_ENV=development` to stdout.
 *
 * Each case runs the logger in a child process so NODE_ENV is fully isolated.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGGER = join(__dirname, '..', 'src', 'utils', 'logger.js');

function runLogger(env) {
  const script = `import logger from ${JSON.stringify(LOGGER)}; logger.info('LOG_MARKER');`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('info logs stay off stdout in server mode (NODE_ENV=development)', () => {
  const { stdout, stderr } = runLogger({ NODE_ENV: 'development' });
  assert.ok(!stdout.includes('LOG_MARKER'), `stdout must stay clean for JSON-RPC, got: ${JSON.stringify(stdout)}`);
  assert.ok(stderr.includes('LOG_MARKER'), 'info should be on stderr');
});

test('info logs stay off stdout when NODE_ENV is unset (server mode)', () => {
  const { stdout, stderr } = runLogger({ NODE_ENV: '' });
  assert.ok(!stdout.includes('LOG_MARKER'), `stdout must stay clean, got: ${JSON.stringify(stdout)}`);
  assert.ok(stderr.includes('LOG_MARKER'), 'info should be on stderr');
});

test('info logs stay off stdout in production (server mode)', () => {
  const { stdout, stderr } = runLogger({ NODE_ENV: 'production' });
  assert.ok(!stdout.includes('LOG_MARKER'), `stdout must stay clean, got: ${JSON.stringify(stdout)}`);
  assert.ok(stderr.includes('LOG_MARKER'), 'info should be on stderr');
});

test('explicit test mode (NODE_ENV=test) may use stdout', () => {
  const { stdout } = runLogger({ NODE_ENV: 'test' });
  assert.ok(stdout.includes('LOG_MARKER'), 'test mode logs to stdout for visibility');
});
