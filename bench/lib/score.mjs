/**
 * Scoring — pure functions, no I/O, so the gate logic is unit-testable in
 * isolation from the (slow, stochastic) agent runs.
 *
 * Success is the primary signal; tool errors and tokens/turns are the
 * efficiency signals that catch "the agent eventually succeeded but flailed"
 * (e.g. a flaky tool the model had to retry around).
 */

/**
 * Score a single run from its grade + telemetry.
 *
 * @param {{pass:boolean, detail?:string}} grade
 * @param {{toolCalls:Array, turns:number, tokens:{input:number,output:number}, hardError:string|null}} telemetry
 */
export function scoreRun(grade, telemetry) {
  const toolCalls = telemetry.toolCalls || [];
  // Real failures are MCP tool errors — NOT the sandbox denying a built-in the
  // agent probed (denied). Denials are tracked for visibility but never fail a task.
  const errorCalls = toolCalls.filter((c) => c.isError && !c.denied);
  return {
    pass: !!grade.pass && !telemetry.hardError,
    detail: (grade.detail || '').replace(/\s+/g, ' ').trim(),
    toolCalls: toolCalls.length,
    errors: errorCalls.length,
    deniedAttempts: toolCalls.filter((c) => c.denied).length,
    errorCodes: [...new Set(errorCalls.map((c) => c.errorCode).filter(Boolean))],
    turns: telemetry.turns || 0,
    tokens: (telemetry.tokens?.input || 0) + (telemetry.tokens?.output || 0),
    hardError: telemetry.hardError || null,
    // Diagnostics: the tool sequence + first error text + the agent's final
    // words + the on-disk transcript, so a failure is debuggable without a re-run.
    tools: toolCalls.map((c) => ({ name: c.name, isError: c.isError && !c.denied, denied: !!c.denied, errorCode: c.errorCode || null })),
    firstError: (errorCalls[0]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    finalText: (telemetry.finalText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    logFile: telemetry.logFile || null,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A task's median turns may exceed expectedTurns by up to this factor before
// we flag it — absorbs the small model's run-to-run variance (it sometimes
// verifies its own work) so the SOFT budget doesn't cry wolf. Tune per env.
const TURNS_TOLERANCE = Number(process.env.BENCH_TURNS_TOLERANCE) || 2;

/**
 * Aggregate a task's runs into the metrics the gate + report use.
 *
 * @param {{id:string, category:string}} task
 * @param {ReturnType<typeof scoreRun>[]} runs
 */
export function aggregateTask(task, runs) {
  const passes = runs.filter((r) => r.pass).length;
  const failing = runs.find((r) => !r.pass) || null;
  const medianTurns = median(runs.map((r) => r.turns));
  const expectedTurns = task.expectedTurns ?? null;
  return {
    id: task.id,
    category: task.category,
    runs: runs.length,
    passes,
    successRate: runs.length ? passes / runs.length : 0,
    meanErrors: round(mean(runs.map((r) => r.errors))),
    meanTurns: round(mean(runs.map((r) => r.turns))),
    medianTurns,
    meanTokens: Math.round(mean(runs.map((r) => r.tokens))),
    errorCodes: [...new Set(runs.flatMap((r) => r.errorCodes))],
    flaky: passes > 0 && passes < runs.length,
    // Per-task turn budgets. maxTurns is the HARD ceiling (enforced at run time
    // by killing the agent → graded incomplete). expectedTurns is the SOFT
    // efficiency budget: turnsOverBudget flags a surface that still passes but
    // got harder to drive (median > expected × tolerance). It is REPORTED, not
    // gated — turn counts are too stochastic to hard-fail on.
    expectedTurns,
    maxTurns: task.maxTurns ?? null,
    turnsOverBudget: expectedTurns != null && medianTurns > expectedTurns * TURNS_TOLERANCE,
    // The full picture of one failing run — written to the JSON artifact and
    // summarized in the console so a failure needs no re-run to diagnose.
    failingSample: failing && {
      detail: failing.detail,
      hardError: failing.hardError,
      turns: failing.turns,
      tokens: failing.tokens,
      tools: failing.tools,
      firstError: failing.firstError,
      finalText: failing.finalText,
      logFile: failing.logFile,
    },
  };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * The gate decision. Passes only if every task clears the success threshold.
 * A flaky task (passes some runs, fails others) on a SMALL model means the tool
 * surface is ambiguous enough that the model can't follow it reliably — that's
 * a real failure, not noise to wave away.
 *
 * @param {ReturnType<typeof aggregateTask>[]} aggregates
 * @param {number} threshold
 */
export function decideGate(aggregates, threshold) {
  const failures = aggregates
    .filter((a) => a.successRate < threshold)
    .map((a) => ({ id: a.id, successRate: a.successRate, errorCodes: a.errorCodes, sample: a.failingSample }));
  return { passed: failures.length === 0, threshold, failures };
}

/**
 * Compare two runs (before/after) per task. Positive deltas are improvements.
 *
 * @param {ReturnType<typeof aggregateTask>[]} after
 * @param {ReturnType<typeof aggregateTask>[]} before
 */
export function delta(after, before) {
  const byId = new Map(before.map((b) => [b.id, b]));
  return after.map((a) => {
    const b = byId.get(a.id);
    if (!b) return { id: a.id, new: true, successRate: a.successRate };
    return {
      id: a.id,
      successRate: round(a.successRate - b.successRate),
      errors: round(a.meanErrors - b.meanErrors),
      tokens: a.meanTokens - b.meanTokens,
      before: b.successRate,
      after: a.successRate,
    };
  });
}
