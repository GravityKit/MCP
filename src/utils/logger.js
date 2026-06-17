/**
 * Logger utility for MCP server.
 *
 * The server speaks JSON-RPC over stdout, so ANY log byte on stdout corrupts the
 * transport and breaks the MCP handshake (the client gets a malformed message
 * and the server hangs unconnected with 0 tools). Logs therefore go to stderr
 * whenever the process runs as a server — which is EVERY environment except an
 * explicit test context. Only a test (no JSON-RPC peer to corrupt) may use
 * stdout, for readable assertions/output.
 *
 * The mode is resolved PER CALL (not memoized at import) so it always reflects
 * the current environment and stays unit-testable. The previous detection
 * (`!NODE_ENV || NODE_ENV === 'production'`) was inverted: it routed the common
 * `NODE_ENV=development` to stdout and silently broke the handshake.
 */

/** True only in an explicit test context — the one case stdout is safe. */
function isTestContext() {
  return process.env.NODE_ENV === 'test'
    || process.env.GRAVITYKIT_MCP_TEST_MODE === 'true'
    || process.env.GRAVITYMCP_TEST_MODE === 'true';
}

/**
 * Send a log message. Errors and all server-mode logs go to stderr; only an
 * explicit test context uses stdout.
 */
export function sendLogMessage(message, level = 'info') {
  // Errors always go to stderr — never risk the JSON-RPC stream.
  if (level === 'error') {
    console.error(message);
    return;
  }
  if (isTestContext()) {
    console.log(message);
    return;
  }
  // Server mode (default): keep stdout clean for JSON-RPC.
  console.error(`[${level}] ${message}`);
}

export default {
  info: (message) => sendLogMessage(message, 'info'),
  error: (message) => sendLogMessage(message, 'error'),
  warn: (message) => sendLogMessage(message, 'warn'),
  debug: (message) => sendLogMessage(message, 'debug')
};