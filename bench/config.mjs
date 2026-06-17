/**
 * Benchmark configuration — the release gate's knobs in one place.
 *
 * The gate runs a SMALL model against the MCP on purpose: a well-designed tool
 * surface (clear descriptions, honest schemas, actionable errors) should be
 * usable WITHOUT a frontier model. If Haiku can't reliably drive the MCP to a
 * correct end state, the tools — not the model — need work.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root (one level up from bench/). */
export const REPO_ROOT = resolve(HERE, '..');

/** The MCP server entry point under test. */
export const MCP_ENTRY = resolve(REPO_ROOT, 'src', 'index.js');

const env = process.env;
const num = (v, d) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const CONFIG = {
  /**
   * The SMALL model is the gate. Override with BENCH_MODEL only to A/B the
   * surface against a different tier — never to "make the gate pass".
   */
  model: env.BENCH_MODEL || 'claude-haiku-4-5-20251001',

  /** Runs per task. AI is stochastic; success is a rate, not a coin flip. */
  runsPerTask: num(env.BENCH_RUNS, 3),

  /** Hard ceiling on agent turns per task — catches loops / give-ups. */
  maxTurns: num(env.BENCH_MAX_TURNS, 25),

  /**
   * Gate threshold: every task's success rate must be >= this. Set for a small
   * model — if a task can't clear it, the tool surface is too hard, not the
   * model too weak.
   */
  successThreshold: num(env.BENCH_THRESHOLD, 0.8),

  /** Per-agent-run wall-clock budget (ms) before we kill and score it failed. */
  runTimeoutMs: num(env.BENCH_RUN_TIMEOUT_MS, 240000),

  /**
   * Only the MCP under test is exposed to the agent — no filesystem, no web.
   * The agent must accomplish each task THROUGH the tools or not at all.
   */
  mcpServerName: 'gravitymcp',
  allowedToolsPrefix: 'mcp__gravitymcp',

  /** Where reports land. */
  outDir: resolve(HERE, 'reports'),
};

/**
 * Optional disposable-site provider. `npm run bench -- --mint` mints a fresh WP
 * (6.9, abilities API) with the GF + GravityView source under test symlinked,
 * and an admin application password — the only setup that satisfies gv_*.
 * Plugin paths derive from siteminter's location (it lives at
 * <plugins>/Tooling/siteminter) and are overridable.
 */
const SM_DIR = env.SITEMINTER_DIR || '';
const PLUGINS_DIR = SM_DIR ? resolve(SM_DIR, '..', '..') : '';
export const SITEMINTER = {
  dir: SM_DIR,
  siteName: env.BENCH_SITE || 'gvbench',
  plugins: [
    env.BENCH_GF_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityforms')),
    env.BENCH_GV_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'GravityView')),
  ].filter(Boolean),
  /**
   * Real Gravity Forms add-ons whose field types the storage suite validates
   * (chainedselect, signature, survey_rank). NOT minted for the release gate —
   * only the field-storage suite asks for them — so the gate's surface stays
   * minimal. These are the ACTUAL add-on plugins (symlinked + activated), never
   * stubs: the round-trip must go through real add-on code.
   */
  addons: [
    env.BENCH_CHAINEDSELECTS_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityformschainedselects')),
    env.BENCH_SIGNATURE_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityformssignature')),
    env.BENCH_SURVEY_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityformssurvey')),
    env.BENCH_POLLS_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityformspolls')),
    env.BENCH_QUIZ_PATH || (PLUGINS_DIR && resolve(PLUGINS_DIR, 'gravityformsquiz')),
  ].filter(Boolean),
};

/**
 * Resolve the target site + credentials the gate runs against — reusing the
 * SAME env vars the MCP and the `test:live` harness already use. Precedence:
 * the GF test site (GRAVITY_FORMS_TEST_*) → the default GF site (GRAVITY_FORMS_*).
 * The site must run the GravityView/Foundation code under test (the MCP server
 * itself is the local code).
 *
 * @returns {{baseUrl:string, key:string, secret:string, wpUrl:string, wpUser:string, wpPass:string}}
 */
export function resolveTarget() {
  const baseUrl = env.GRAVITY_FORMS_TEST_BASE_URL || env.GRAVITY_FORMS_BASE_URL || '';
  const key = env.GRAVITY_FORMS_TEST_CONSUMER_KEY || env.GRAVITY_FORMS_CONSUMER_KEY || '';
  const secret = env.GRAVITY_FORMS_TEST_CONSUMER_SECRET || env.GRAVITY_FORMS_CONSUMER_SECRET || '';

  if (!baseUrl || !key || !secret) {
    throw new Error(
      'Bench target not configured. Set GRAVITY_FORMS_TEST_* (preferred) or GRAVITY_FORMS_* ' +
        '— the same credentials the MCP and test:live use — pointing at a site running the GravityView code under test.',
    );
  }

  // gv_* abilities ride a WP application password; default to the GF credentials
  // (the common single-user setup) unless GravityKit-specific creds are given.
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    key,
    secret,
    wpUrl: (env.GRAVITYKIT_WP_URL || baseUrl).replace(/\/$/, ''),
    wpUser: env.GRAVITYKIT_WP_USERNAME || key,
    wpPass: env.GRAVITYKIT_WP_APP_PASSWORD || secret,
    allowSelfSigned: String(env.GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS || env.MCP_ALLOW_SELF_SIGNED_CERTS || '') === 'true',
  };
}
