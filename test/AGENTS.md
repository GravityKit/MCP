# AGENTS.md — Tests

Test conventions for `@gravitykit/mcp`. Project-wide docs live in `../AGENTS.md`; this file is the detail for working in `test/` and `bench/`.

## TDD is required

Every fix, feature, and refactor is test-first: write one failing test that pins the intended behavior (RED), run it to watch it fail for the right reason, then write the minimal code to pass (GREEN), then refactor. A test that passes the first time it runs proves nothing. Bug fixes start with a test that reproduces the bug. If logic is hard to test, extract it into a testable unit (e.g. `cleanupMintedSite`, `runOnce`'s `bin` parameter) rather than burying it in a `main()`.

## Two unit harnesses

| Harness | Run with | How a suite is registered | Example suites |
|---------|----------|---------------------------|----------------|
| Custom `TestRunner` | `npm run test:unit` (`test/run.js`) | Export a runner as the default export, then `import` it and add it to the `testSuites` array in `test/run.js` | `authentication`, `forms`, `entries`, `abilities-loader`, … |
| `node:test` | `npm run test:node` | `import test from 'node:test'`; add the file path to the `test:node` script in `package.json` | `field-registry`, `server-lifecycle`, `logger-stdout`, `bench-*` |

**Registration is required — adding a `*.test.js` file is not enough.** A node:test file that is not in the `test:node` script (or a custom suite not in the `testSuites` array) silently never runs.

Which to use:
- New pure-function / unit tests → **node:test** (standard, parallel, less boilerplate). Register in `package.json` → `test:node`.
- New cases for an existing custom-runner suite → keep them in that suite.

## What runs where

- `npm run test:node` — fast `node:test` units, no network. Includes the bench grader/runner unit tests.
- `npm run test:unit` — custom-runner units, no network.
- `npm test` — integration; needs a live GF site via `GRAVITY_FORMS_TEST_*`.
- `npm run test:live` — self-seeding end-to-end against a real GF site (`test/live/`).
- `npm run test:all` — every suite in sequence.
- `prepublishOnly` runs `test:unit` + `test:node` + `lint:package` + `lint:docs` — all **offline**; it deliberately omits the live integration test so a publish never hits a real site.

## `bench/` — the AI release gate (dev-only, not shipped)

`bench/` drives a small model (`claude-haiku-4-5`) through the whole MCP surface and grades real Gravity Forms / GravityView state. It is **not** part of the unit suites and is excluded from the npm `files` allowlist.

- Run the gate: `npm run bench` (against the configured target) or `npm run bench -- --task <id> --mint` to provision a throwaway Siteminter site (auto-destroyed unless `--keep`). Needs the `claude` CLI on PATH (pin it with `CLAUDE_BIN`) and a target site. Slow + token-costly — a release gate, not per-commit CI.
- The gate's own logic is **unit-tested** in `test/bench-*.test.js` (node:test, no site or model needed):
  - `bench-grading.test.js` — grader rigor: a grader must require the real tool call (not a prompt echo), scope View-field checks to the table-columns area, and require a placed field to land in a newly-added grid area.
  - `bench-agent.test.js` — `runOnce` resolves a `hardError` (`spawn_failed:…`) when the `claude` binary can't spawn, instead of crashing the gate or hanging.
  - `bench-cleanup.test.js` — `cleanupMintedSite` destroys a minted site by default, keeps it on `--keep`, no-ops without a mint, and swallows destroy errors so a `finally` never masks the original throw.
- Graders read ground truth via an independent REST client (`makeClient`), never `telemetry.finalText` alone. Pin the model and re-baseline on a model bump (a model change is a confounder, not a regression).

## Test-mode env

`GRAVITYKIT_MCP_TEST_MODE=true` (or legacy `GRAVITYMCP_TEST_MODE`, or `NODE_ENV=test`) remaps `GRAVITY_FORMS_TEST_*` → `GRAVITY_FORMS_*` and lets the logger use stdout for readable assertions. In server mode the logger always writes to stderr — stdout is reserved for JSON-RPC.
