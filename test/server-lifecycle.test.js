/**
 * The stdio MCP server MUST exit when its stdin closes — i.e. when the client
 * disconnects or is killed. The MCP handshake runs over stdin/stdout; when the
 * client goes away, stdin reaches EOF and the server has nothing left to do.
 *
 * Without an explicit exit on that EOF, every crashed/killed client (or, in the
 * benchmark harness, every SIGKILL'd run) leaves an orphaned `node src/index.js`
 * process running forever. Those orphans accumulate and starve the next server's
 * startup, which surfaces as agents booting with 0 MCP tools.
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'index.js');

test('server exits when stdin closes (no orphan on client disconnect)', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Wait until the server reports it is up (logged on connect). The readiness
  // line may land on either stream depending on logger mode, so watch both.
  await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`server never reported ready; saw:\n${seen}`)), 8000);
    const onData = (d) => {
      seen += d.toString();
      if (/running on stdio/i.test(seen)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => { clearTimeout(timer); reject(new Error('server exited before it was ready')); });
  });

  // The client disconnects: close the server's stdin (EOF).
  child.stdin.end();

  // It must exit promptly. If it is still alive after the window, it leaked.
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    child.on('close', () => { clearTimeout(timer); resolve(true); });
  });

  if (!exited) child.kill('SIGKILL');
  assert.ok(exited, 'server should exit within 4s of stdin closing, but it kept running (orphan)');
});
