/**
 * Run one task through a real agent (the small model) over the MCP, and capture
 * the telemetry the gate scores on: which tools were called, which returned
 * errors, how many turns, how many tokens.
 *
 * The agent is the actual `claude` CLI in headless mode with ONLY the MCP under
 * test exposed (no filesystem, no web). It must accomplish the task through the
 * tools or fail — exactly the real-world condition we want to measure.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG } from '../config.mjs';

/**
 * The `claude` binary to drive the gate. Resolved by name through PATH by
 * default, BUT `npm run` prepends every ancestor `node_modules/.bin` to PATH —
 * so a stray `claude` shim anywhere above cwd (e.g. an old global-ish install in
 * `~/node_modules`) silently shadows the real CLI and every run dies at
 * arg-parse ("unknown option '--model'"), scoring 0 turns. Set CLAUDE_BIN to an
 * absolute path to pin the intended CLI and stay immune to PATH pollution.
 */
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * A clean, empty working directory for the agent. Claude Code auto-loads
 * `CLAUDE.md` (and its `@AGENTS.md` import) from the cwd and every ancestor — so
 * running the agent inside this repo would hand it the MCP's own internal docs
 * (tool catalog, architecture). That's a cheat sheet that invalidates the
 * tool-surface test: we must measure the agent working from ONLY the tool
 * descriptions. An empty dir under the OS tmp root has no project memory in its
 * ancestry. Created once, reused across runs.
 */
let AGENT_CWD = null;
function agentCwd() {
  if (!AGENT_CWD) AGENT_CWD = mkdtempSync(join(tmpdir(), 'gvbench-agent-'));
  return AGENT_CWD;
}

/**
 * Seconds the agent waits at startup before its first inference. claude -p does
 * NOT block on a stdio MCP server finishing its connection — it fires the first
 * turn immediately, so without a delay the agent starts with 0 tools and bails.
 * This must comfortably cover: spawning the server process + the MCP handshake +
 * the abilities-catalog fetch (~3s against a remote site). Defaulted high on
 * purpose — being too short makes the whole gate flaky; the cost is just a few
 * seconds per run on a gate that runs rarely. Bump via BENCH_MCP_WARMUP_SEC for
 * slower machines / larger catalogs / CI.
 */
const WARMUP_SEC = Number(process.env.BENCH_MCP_WARMUP_SEC) || 8;

/**
 * A clean Claude config dir for the agent — no operator settings (hooks), no
 * global CLAUDE.md, no auto-memory; full isolation so the test measures ONLY the
 * MCP tool surface (auth falls back to ANTHROPIC_API_KEY). It carries ONE
 * deliberate SessionStart hook that sleeps WARMUP_SEC, which is what gives the
 * MCP server time to connect before the first inference (see WARMUP_SEC).
 * Created once and reused.
 */
let AGENT_CONFIG_DIR = null;
function agentConfigDir() {
  if (!AGENT_CONFIG_DIR) {
    AGENT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gvbench-cfg-'));
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `sleep ${WARMUP_SEC}` }] }] },
    };
    writeFileSync(join(AGENT_CONFIG_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
  }
  return AGENT_CONFIG_DIR;
}

/**
 * Every built-in Claude Code tool, denied so the agent can ONLY use the MCP
 * under test. (MCP servers other than ours are already excluded by
 * --strict-mcp-config.) disallowedTools is honored even under bypassPermissions.
 */
// The allow-list (--allowedTools mcp__gravitymcp, no bypassPermissions) is the
// real fence: in headless mode anything not allow-listed is denied. This denylist
// is belt-and-suspenders, so it must use NAMES THIS CLI KNOWS — unknown names
// emit "matches no known tool" warnings. (MultiEdit/LS/SlashCommand aren't tools
// in this version.)
const BUILTIN_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'Read', 'NotebookEdit',
  'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ExitPlanMode',
  // Claude Code 2.x meta-tools — keep the agent from wandering into tool search /
  // skills / language-server lookups instead of just calling the MCP.
  'ToolSearch', 'Skill', 'AskUserQuestion', 'Agent',
];

/** Strip the `mcp__server__` prefix for readable reporting. */
const shortName = (name) => (name || '').replace(/^mcp__[^_]+__/, '');

/** Pull plain text out of a tool_result content (string | array of blocks). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('');
  return '';
}

/**
 * Parse Claude Code stream-json (one JSON object per line) into telemetry.
 *
 * @param {string} stdout Raw stream-json output.
 */
function parseStream(stdout) {
  const toolUses = new Map(); // id -> { name, input }
  const toolCalls = [];
  let turns = 0;
  let tokens = { input: 0, output: 0 };
  let finalText = '';
  let hardError = null;
  let mcpTools = 0; // MCP tools listed at init — a snapshot before the async connect finishes, so often 0 even when tools arrive (reporting hint only, never a pass/fail signal)

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }

    if (evt.type === 'system' && evt.subtype === 'init') {
      mcpTools = (evt.tools || []).filter((t) => /^mcp__/.test(t)).length;
    } else if (evt.type === 'assistant' && evt.message) {
      turns += 1;
      for (const block of evt.message.content || []) {
        if (block.type === 'tool_use') toolUses.set(block.id, { name: shortName(block.name), input: block.input });
      }
      const u = evt.message.usage;
      if (u) { tokens.input += u.input_tokens || 0; tokens.output += u.output_tokens || 0; }
    } else if (evt.type === 'user' && evt.message) {
      for (const block of evt.message.content || []) {
        if (block.type !== 'tool_result') continue;
        const use = toolUses.get(block.tool_use_id) || { name: 'unknown', input: undefined };
        const text = resultText(block.content);
        const errorCode = (text.match(/"?(?:code|error)"?\s*[:=]\s*"?(ability_[a-z_]+|rest_[a-z_]+)/i) || [])[1] || null;
        // A small model reflexively probes tools it doesn't have (Glob, memory,
        // …); the sandbox denies them with "No such tool available". That's the
        // isolation working — NOT an MCP failure — so flag it separately so it
        // doesn't count against the task.
        const denied = /no such tool available|not available in this context/i.test(text);
        toolCalls.push({
          name: use.name,
          input: use.input,
          isError: block.is_error === true || /\binput is not of type object\b|ability_invalid|ability_missing/.test(text),
          denied,
          errorCode,
          text: text.slice(0, 500),
        });
      }
    } else if (evt.type === 'result') {
      finalText = evt.result || '';
      if (evt.usage) { tokens.input = evt.usage.input_tokens ?? tokens.input; tokens.output = evt.usage.output_tokens ?? tokens.output; }
      if (typeof evt.num_turns === 'number') turns = evt.num_turns;
      if (evt.subtype && evt.subtype !== 'success') hardError = evt.subtype;
    }
  }

  return { toolCalls, turns, tokens, finalText, hardError, mcpTools };
}

/**
 * Run the agent on a single prompt. Resolves to telemetry even on timeout/crash
 * (so the gate can score it as a failed run rather than throwing).
 *
 * @param {string} prompt
 * @param {string} mcpConfigPath
 * @param {string} [logFile] If given, the full raw stream-json transcript is
 *   written here — the authoritative record for debugging a failed run.
 * @returns {Promise<{toolCalls:Array, turns:number, tokens:{input:number,output:number}, finalText:string, hardError:string|null, durationMs:number, logFile:string|null}>}
 */
function runOnce(prompt, mcpConfigPath, logFile = null) {
  const args = [
    '-p', prompt,
    '--model', CONFIG.model,
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(CONFIG.maxTurns),
    // Sandbox the agent to ONLY the MCP under test. No bypassPermissions: in
    // headless mode any tool NOT in --allowedTools is denied (no prompt to
    // answer), so the allow-list is the real fence — robust against new
    // built-ins the denylist might miss. --disallowedTools additionally
    // hard-blocks the known built-ins. allowedTools pre-approves the MCP so its
    // calls run without prompting. Keep both LAST: variadic, stop at EOF.
    '--disallowedTools', ...BUILTIN_TOOLS,
    '--allowedTools', CONFIG.allowedToolsPrefix,
  ];

  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Empty cwd → no project CLAUDE.md/AGENTS.md auto-loaded (see agentCwd).
      cwd: agentCwd(),
      env: {
        ...process.env,
        // Clean config dir: no operator hooks/CLAUDE.md/memory, plus the
        // SessionStart warmup that lets the MCP connect before turn 1 (see
        // agentConfigDir / WARMUP_SEC).
        CLAUDE_CONFIG_DIR: agentConfigDir(),
        // Generous MCP startup window so the server can register all tools.
        MCP_TIMEOUT: process.env.MCP_TIMEOUT || '120000',
      },
    });

    const timer = setTimeout(() => { child.kill('SIGKILL'); }, CONFIG.runTimeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (logFile) {
        try {
          mkdirSync(dirname(logFile), { recursive: true });
          writeFileSync(logFile, stdout + (stderr ? `\n\n--- stderr ---\n${stderr}` : ''));
        } catch { /* logging is best-effort */ }
      }
      const telemetry = parseStream(stdout);
      const timedOut = signal === 'SIGKILL';
      resolvePromise({
        ...telemetry,
        durationMs: Date.now() - started,
        timedOut,
        exitCode: code,
        hardError: telemetry.hardError || (timedOut ? 'timeout' : null) || (code !== 0 && !telemetry.finalText ? `exit_${code}` : null),
        stderr: stderr.slice(-500),
        logFile: logFile || null,
      });
    });
  });
}

/**
 * Run the agent, retrying only on a genuine process-level failure — the CLI
 * crashed or exited without producing any result, a transient a re-run can
 * clear.
 *
 * Deliberately NOT retried on the init MCP-tool count: that snapshot is captured
 * before the server finishes its async connect, so it routinely reads 0 even
 * when the tools arrive moments later (the agent goes on to use them). Whether a
 * task succeeded is judged by the grader, not by the init event. A timeout is
 * also not retried — it means the agent genuinely hung, which is real signal.
 */
export async function runAgent(prompt, mcpConfigPath, logFile = null) {
  const maxAttempts = 2;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runOnce(prompt, mcpConfigPath, logFile);
    last.attempts = attempt;
    const processCrashed = !last.finalText && /^exit_/.test(last.hardError || '');
    if (!processCrashed) return last;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}
