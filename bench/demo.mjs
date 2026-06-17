/**
 * demo.mjs — exercise the MCP through NATURAL LANGUAGE, end to end.
 *
 * Hands a small model (the bench gate model) one open-ended, plain-English goal
 * and the MCP under test (and nothing else — no filesystem, no web), then prints
 * the transcript of which tools it CHOSE to call and the report it wrote back.
 * Nothing here is hard-coded to specific tools: the model decides. This is the
 * "show me what you can do" companion to `bench` (which scores narrow NL tasks).
 *
 * Usage: node bench/demo.mjs [--keep] [--fresh]   (BENCH_MODEL=… to override model)
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CONFIG, SITEMINTER } from './config.mjs';
import { writeMcpConfig } from './lib/target.mjs';
import { provisionSite, destroySite, activePlugins } from './lib/siteminter.mjs';
import { runAgent } from './lib/agent.mjs';

const SITE = process.env.BENCH_DEMO_SITE || 'gvstore';
const args = { keep: process.argv.includes('--keep'), fresh: process.argv.includes('--fresh') };

// One plain-English goal that spans both planes (forms/entries/fields + View +
// search) AND the role-aware search work — but never names a tool. The model
// must discover the surface and sequence the calls itself.
const GOAL = `You are connected to a WordPress site running Gravity Forms and GravityView, exposed through an MCP server. Using ONLY the available tools, build a small job-applications setup end to end:

1. Create a form titled "Job Applications" with these fields: First Name, Last Name, Email, a Department dropdown (Engineering, Design, Product), and a "Years of Experience" number.
2. Add two sample applications: Ada Lovelace — ada@example.com — Engineering — 7 years; and Grace Hopper — grace@example.com — Product — 12 years.
3. Create a GravityView View on that form using a table layout, showing the applicant's name, email and department as columns.
4. Add a search bar to the View so visitors can search by name and filter by Department — and make the "Years of Experience" search visible only to logged-in administrators.

When done, briefly report the form id, the entry ids, the view id, and how someone would view the results. If a tool returns an error, adjust and continue.`;

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (k) => (input[k] !== undefined ? `${k}=${JSON.stringify(input[k])}` : '');
  const keys = ['title', 'form_id', 'field_type', 'entry_id', 'id', 'template_id', 'area', 'field_id', 'zone'];
  let parts = keys.map(pick).filter(Boolean);
  if (name === 'gf_create_form' && Array.isArray(input.fields)) parts.push(`${input.fields.length} fields`);
  if (Array.isArray(input.fields) && name.includes('search')) parts.push(`${input.fields.length} search fields`);
  return parts.join(' ').slice(0, 110);
}

async function main() {
  console.log('\nMinting (or reusing) a GravityView 3.0 site for the natural-language demo…');
  const prov = await provisionSite({
    fresh: args.fresh,
    name: SITE,
    plugins: [...SITEMINTER.plugins, ...SITEMINTER.addons],
    log: (m) => console.log(`[siteminter] ${m}`),
  });
  const { target } = prov;
  const plugins = activePlugins(prov.path);
  console.log(`\nSite: ${target.baseUrl}`);
  for (const slug of ['gravityforms', 'GravityView', 'spellbook', 'gp-nested-forms']) {
    if (plugins[slug]) console.log(`  • ${slug} ${plugins[slug]}`);
  }

  const mcpConfigPath = writeMcpConfig(target);
  const traceDir = join(CONFIG.outDir, 'demo');
  mkdirSync(traceDir, { recursive: true });

  console.log(`\nModel: ${CONFIG.model}  ·  tools exposed: ONLY the MCP under test`);
  console.log('─'.repeat(72));
  console.log('GOAL (natural language, no tool names):\n');
  console.log(GOAL.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('─'.repeat(72));
  console.log('Running the agent… (this drives the real MCP over stdio)\n');

  const t = await runAgent(GOAL, mcpConfigPath, join(traceDir, 'demo.jsonl'));

  console.log('TRANSCRIPT — tools the model chose to call:');
  if (!t.toolCalls.length) console.log('  (no tool calls — check CLAUDE_BIN / ANTHROPIC_API_KEY / warmup)');
  for (const c of t.toolCalls) {
    const mark = c.denied ? '·' : c.isError ? '✗' : '✓';
    const tail = c.isError ? `  ⚠ ${(c.errorCode || c.text || '').slice(0, 80)}` : '';
    console.log(`  ${mark} ${c.name.padEnd(22)} ${summarizeInput(c.name, c.input)}${tail}`);
  }

  const uniq = [...new Set(t.toolCalls.filter((c) => !c.denied).map((c) => c.name))];
  const errs = t.toolCalls.filter((c) => c.isError && !c.denied).length;
  console.log('\n' + '─'.repeat(72));
  console.log(`Turns: ${t.turns}  ·  distinct tools used: ${uniq.length}  ·  tool errors: ${errs}  ·  tokens: ${t.tokens.input}+${t.tokens.output}`);
  if (t.hardError) console.log(`Hard error: ${t.hardError}`);
  console.log('\nAGENT REPORT:\n');
  console.log((t.finalText || '(no final text)').split('\n').map((l) => `  ${l}`).join('\n'));

  if (!args.keep) { try { destroySite(prov.name); } catch { /* best effort */ } console.log(`\nTore down "${prov.name}".`); }
  else console.log(`\n[siteminter] keeping "${prov.name}" at ${target.baseUrl} (admin/admin) so you can inspect what it built.`);
}

main().catch((e) => { console.error(`\ndemo crashed: ${e?.stack || e}\n`); process.exit(1); });
