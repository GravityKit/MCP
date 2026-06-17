/**
 * Reporting — a readable console summary + a machine-readable JSON artifact
 * (so results can be diffed across releases / fed a before-after delta).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../config.mjs';

const pct = (n) => `${Math.round(n * 100)}%`;
const pad = (s, n) => String(s).padEnd(n);

/**
 * Print the summary and write a JSON artifact. Returns the artifact path.
 *
 * @param {object} params
 * @param {ReturnType<import('./score.mjs').aggregateTask>[]} params.aggregates
 * @param {ReturnType<import('./score.mjs').decideGate>} params.gate
 * @param {string} params.stamp ISO timestamp (passed in — the runtime forbids Date.now in some contexts)
 */
export function report({ aggregates, gate, stamp }) {
  const lines = [];
  lines.push('');
  lines.push(`AI release gate — model: ${CONFIG.model}  ·  runs/task: ${CONFIG.runsPerTask}  ·  threshold: ${pct(gate.threshold)}`);
  lines.push('─'.repeat(78));
  lines.push(`${pad('TASK', 34)} ${pad('SUCCESS', 9)} ${pad('ERR', 5)} ${pad('TURNS', 6)} ${pad('TOKENS', 8)} FLAKY`);
  lines.push('─'.repeat(78));

  const byCat = groupBy(aggregates, (a) => a.category);
  for (const [cat, items] of byCat) {
    lines.push(`▸ ${cat}`);
    for (const a of items) {
      const mark = a.successRate >= gate.threshold ? ' ' : '✗';
      lines.push(
        `${mark} ${pad(a.id, 32)} ${pad(`${pct(a.successRate)} (${a.passes}/${a.runs})`, 9)} ` +
          `${pad(a.meanErrors, 5)} ${pad(a.meanTurns, 6)} ${pad(a.meanTokens, 8)} ${a.flaky ? 'yes' : ''}`,
      );
      if (a.errorCodes.length) lines.push(`    ↳ errors seen: ${a.errorCodes.join(', ')}`);
    }
  }

  lines.push('─'.repeat(78));
  if (gate.passed) {
    lines.push(`✅ GATE PASSED — every task ≥ ${pct(gate.threshold)} on ${CONFIG.model}`);
  } else {
    lines.push(`❌ GATE FAILED — ${gate.failures.length} task(s) below ${pct(gate.threshold)} on a small model:`);
    for (const f of gate.failures) {
      lines.push(`   • ${f.id}: ${pct(f.successRate)}`);
      const s = f.sample;
      if (!s) continue;
      if (s.detail) lines.push(`     why:     ${s.detail}`);
      if (s.tools?.length) {
        const seq = s.tools.slice(-12).map((t) => `${t.name}${t.denied ? '∅' : t.isError ? `✗(${t.errorCode || 'err'})` : '✓'}`).join(' → ');
        lines.push(`     tools:   ${seq}`);
      }
      if (s.firstError) lines.push(`     error:   ${s.firstError}`);
      if (s.hardError) lines.push(`     hard:    ${s.hardError}`);
      if (s.finalText) lines.push(`     agent:   ${s.finalText}`);
      if (s.logFile) lines.push(`     trace:   ${s.logFile}`);
    }
    lines.push('   A small model failing here means the tool surface is too hard — fix descriptions/schemas/errors, not the gate.');
  }
  lines.push('');

  const text = lines.join('\n');
  console.log(text);

  mkdirSync(CONFIG.outDir, { recursive: true });
  const artifact = join(CONFIG.outDir, `gate-${stamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(artifact, JSON.stringify({ stamp, model: CONFIG.model, config: { runsPerTask: CONFIG.runsPerTask, threshold: gate.threshold }, aggregates, gate }, null, 2));
  console.log(`Report: ${artifact}\n`);
  return artifact;
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}
