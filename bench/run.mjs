/**
 * AI release gate — runs the task suite through a SMALL model over the MCP and
 * exits non-zero if any task falls below the success threshold.
 *
 * Why a small model: a well-designed tool surface should not require frontier
 * intelligence. If Haiku can't reliably reach the correct end state, the tools
 * (descriptions / schemas / error messages) need work — not the gate.
 *
 * Usage:
 *   node bench/run.mjs                 # full suite
 *   node bench/run.mjs --task search   # only tasks whose id includes "search"
 *   BENCH_RUNS=5 node bench/run.mjs    # override runs/task
 *
 * Requires: `claude` CLI on PATH, ANTHROPIC auth, and GRAVITY_FORMS_TEST_ (or
 * GRAVITY_FORMS_) credentials pointing at a site that runs the GravityView /
 * Foundation code under test.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG, resolveTarget } from './config.mjs';
import { writeMcpConfig, makeClient } from './lib/target.mjs';
import { provisionSite, destroySite } from './lib/siteminter.mjs';
import { runAgent } from './lib/agent.mjs';
import { scoreRun, aggregateTask, decideGate } from './lib/score.mjs';
import { report } from './lib/report.mjs';
import { TASKS } from './tasks/index.mjs';

function parseArgs(argv) {
  const out = { filter: null, mint: false, keep: false, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') out.filter = argv[++i];
    else if (argv[i] === '--mint') out.mint = true;       // provision a fresh siteminter target
    else if (argv[i] === '--keep') out.keep = true;       // don't destroy the minted site
    else if (argv[i] === '--fresh') out.fresh = true;     // re-mint even if the site exists
  }
  return out;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { return { __error: e?.message || String(e), fallback }; }
}

async function runTask(task, client, mcpConfigPath, traceDir) {
  const runs = [];
  for (let i = 0; i < CONFIG.runsPerTask; i++) {
    let state = {};
    let grade = { pass: false, detail: '' };
    let telemetry = { toolCalls: [], turns: 0, tokens: { input: 0, output: 0 }, hardError: 'not-run' };
    try {
      if (task.setup) state = await task.setup(client);
      const prompt = typeof task.prompt === 'function' ? task.prompt(state) : task.prompt;
      telemetry = await runAgent(prompt, mcpConfigPath, join(traceDir, `${task.id}.run${i + 1}.jsonl`), task.maxTurns);
      grade = await task.grade({ client, state, telemetry });
    } catch (e) {
      grade = { pass: false, detail: `harness error: ${e?.message || e}` };
    } finally {
      if (task.teardown) await safe(() => task.teardown({ client, state }));
    }
    const scored = scoreRun(grade, telemetry);
    runs.push(scored);
    const flag = scored.pass ? '✓' : '✗';
    const overExp = task.expectedTurns && scored.turns > task.expectedTurns ? '⚠' : '';
    const budget = `exp ${task.expectedTurns ?? '–'}, max ${task.maxTurns ?? CONFIG.maxTurns}`;
    process.stdout.write(
      `  ${flag} ${task.id.padEnd(32)} run ${i + 1}/${CONFIG.runsPerTask}` +
        ` · ${String(scored.turns).padStart(2)} turns${overExp}` +
        ` · ${scored.errors} err  (${budget})\n`,
    );
  }
  return aggregateTask(task, runs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = args.filter ? TASKS.filter((t) => t.id.includes(args.filter)) : TASKS;
  if (!tasks.length) {
    console.error(`No tasks match "${args.filter}".`);
    process.exit(2);
  }

  let target;
  let mintedName = null;
  if (args.mint) {
    const prov = await provisionSite({ fresh: args.fresh, log: (m) => console.log(`[siteminter] ${m}`) });
    target = prov.target;
    mintedName = prov.name;
  } else {
    target = resolveTarget();
  }

  const client = makeClient(target);
  const mcpConfigPath = writeMcpConfig(target);
  const stamp = new Date().toISOString();
  const traceDir = join(CONFIG.outDir, 'traces', stamp.replace(/[:.]/g, '-'));

  console.log(`\nGate target: ${target.baseUrl}`);
  console.log(`Tasks: ${tasks.length}  ·  model: ${CONFIG.model}  ·  runs/task: ${CONFIG.runsPerTask}`);
  console.log(`Transcripts: ${traceDir}\n`);

  const aggregates = [];
  for (const task of tasks) {
    aggregates.push(await runTask(task, client, mcpConfigPath, traceDir));
    // Persist after every task so a long run (or a killed shell) still yields
    // partial results to inspect.
    try {
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(join(traceDir, 'partial.json'), JSON.stringify(aggregates, null, 2));
    } catch { /* best effort */ }
  }

  const gate = decideGate(aggregates, CONFIG.successThreshold);
  report({ aggregates, gate, stamp });

  if (mintedName && !args.keep) {
    console.log(`[siteminter] destroying "${mintedName}" (pass --keep to retain it for inspection)`);
    try { destroySite(mintedName); } catch (e) { console.error(`[siteminter] destroy failed: ${e?.message || e}`); }
  } else if (mintedName) {
    console.log(`[siteminter] keeping "${mintedName}" — destroy with: (cd "$SITEMINTER_DIR" && npm run cli -- destroy ${mintedName} --yes)`);
  }

  process.exit(gate.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nBench runner crashed: ${e?.stack || e}\n`);
  process.exit(2);
});
