# AI release gate (`bench/`)

A behavioral benchmark that runs a **small model** against the MCP and checks it
can complete realistic tasks. It is a **release gate**, not a unit test.

## Why a small model

The unit/integration suites prove the *contract* is correct (schemas, dispatch,
output shapes). They cannot tell you whether an agent actually **succeeds at real
tasks**. This gate measures that — deliberately with the smallest current model
(`claude-haiku-4-5`).

The premise: **a well-designed tool surface should not require a frontier model.**
If Haiku can drive the MCP to the correct end state, the descriptions, schemas,
and error messages are doing their job. If it can't, the fix is the *tools* —
clearer descriptions, honest schemas, actionable errors — **not** raising the
model or lowering the bar.

## The gate contract

- Each **task** is a test: a realistic prompt + a **programmatic grader** that
  reads the actual GravityView/Gravity Forms state (never the agent's self-report).
- Every task runs `BENCH_RUNS` times (default 3) — AI is stochastic, so success
  is a **rate**.
- The gate **passes** only if *every* task's success rate ≥ `BENCH_THRESHOLD`
  (default 0.8). A flaky task on a small model is a real failure: the surface is
  ambiguous enough that the model can't follow it reliably.
- `run.mjs` exits `0` (pass) / `1` (fail) / `2` (harness error).

## Running

Requires the `claude` CLI on PATH + Anthropic auth. The MCP server is always the
**local** `src/index.js` (the code under test); the *site* must run the
GravityView/Foundation code under test and expose the **abilities API**.

### Recommended: self-contained, via siteminter (`--mint`)

```bash
npm run bench -- --mint               # mint a fresh site, run the full suite, destroy it
npm run bench -- --mint --keep        # keep the site afterward (reuse / inspect)
npm run bench -- --mint --fresh       # re-mint even if a bench site exists
npm run bench -- --mint --task forms  # mint + only "forms" tasks
```

`--mint` spins up a disposable WP (6.9, abilities API) with the **GF + GravityView
source symlinked** and an **admin application password**. This is the only setup
that satisfies `gv_*`: the abilities API needs a real WordPress user, not a
Gravity Forms API key. (It mints GF + GravityView *only* — no standalone
Foundation — so GravityView's bundled Foundation, i.e. the code under test, is
the one that runs.) Needs Docker + siteminter (`SITEMINTER_DIR`).

### Bring-your-own site

```bash
GRAVITY_FORMS_TEST_BASE_URL=…  GRAVITY_FORMS_TEST_CONSUMER_KEY=…  GRAVITY_FORMS_TEST_CONSUMER_SECRET=…  npm run bench
```

Reuses the same env the MCP / `test:live` use. **Caveat:** `gv_*` tasks need WP
**application-password** credentials (`GRAVITYKIT_WP_USERNAME` /
`GRAVITYKIT_WP_APP_PASSWORD`) — a `ck_…` Gravity Forms API key authenticates
`gf_*` but the abilities API returns `401` for it. Use `--mint` to avoid this.

```bash
npm run bench -- --task search        # only tasks whose id contains "search"
BENCH_RUNS=5 npm run bench -- --mint  # more runs for tighter rates
```

## Coverage (the whole flow)

The suite spans every surface and CRUD verb. Edit verbs are phrased as realistic
multi-step flows (add-then-act) graded on final persisted state.

| Category | Tasks |
|---|---|
| `discovery` | list views, list layouts, scan by status (empty-input + scalar-status contract) |
| `forms` | create complex form, add field, make field required, delete field, add notification, add confirmation |
| `entries` | submit, validate-without-saving (must NOT persist), read, search, update, delete |
| `authoring` | create + seed a View in one shot |
| `views` | update settings (page size), set status (publish), duplicate, delete |
| `view-fields` | add, add-with-label, reorder, remove |
| `view-widgets` | add (footer), add-then-remove |
| `search` | add a search field, add + configure its input type (5-piece identity) |
| `grid` | add a Layout Builder grid row, add row + place a field |

Several tasks double as **regression guards** for the contract work — e.g.
`discovery.*` (empty-input 400s), `authoring.create-view-seeded` (seed-body 400),
`entries.validate-without-saving` (validate must not create an entry),
`search.*` (search-bar ergonomics).

## Adding a task

Add an object to a file in `tasks/` (registered via `tasks/index.mjs`):

```js
{
  id: 'category.short-name',
  category: 'category',
  async setup(client) { /* create fixtures */ return { /* state */ }; },
  prompt: (state) => `natural-language task referencing ${state.…}`,
  async grade({ client, state, telemetry }) {
    // read ground-truth via `client` (GF REST + read-only abilities); never
    // trust telemetry.finalText for success. Return { pass, detail }.
  },
  async teardown({ client, state }) { /* delete fixtures */ },
}
```

Graders should assert **persisted state**. Use `telemetry` only for efficiency
signals (tool errors encountered, turns, tokens) and clean-run checks.

## Cost & caveats

- Each run is a full agent session (tokens + minutes). A 7-task suite at 3 runs
  is ~21 sessions; budget accordingly. This is a **release gate / nightly**, not
  per-commit CI.
- Pin the model; re-baseline when the model version changes (a model bump is a
  confounder, not a regression).
- Reports (JSON) land in `bench/reports/` for cross-release diffing.
- `bench/` is dev tooling — it is not in the package `files` allowlist and does
  not ship to npm.

## Before/after delta (optional)

To prove a change improved agent success: run the suite on the baseline ref and
on the new code, then diff the two `reports/*.json` (`lib/score.mjs` exports a
`delta()` helper). Automating a one-command `--baseline <ref>` run is future work.
