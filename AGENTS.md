# AGENTS.md — GravityKit MCP

> MCP server for Gravity Forms (primary) and GravityKit products (secondary). It exposes 26 always-on Gravity Forms tools plus a dynamic set of GravityKit product tools generated from the connected site's Foundation Abilities catalog — GravityView is the only GravityKit product implemented so far.

This is the single canonical doc for the project (agents and humans). `CLAUDE.md` simply re-exports it via `@AGENTS.md`.

## Project Identity

- **Package:** `@gravitykit/mcp` v2.4.0
- **Type:** Node.js MCP server (ESM)
- **Purpose:** Full Gravity Forms REST API v2 coverage (26 Gravity Forms tools), plus dynamic GravityKit product tools (GravityView so far) via the WordPress Abilities API
- **Repo:** https://github.com/GravityKit/MCP

## Quick Start

**What this is:** A Node.js MCP (Model Context Protocol) server with two independent capability planes:

- **Plane A — Gravity Forms (`gf_*`), primary.** 26 static tools wrapping the Gravity Forms REST API v2 (forms, entries, feeds, notifications, submissions, field filters, results, and intelligent field management). Always available when Gravity Forms REST credentials work — on any Gravity Forms site.
- **Plane B — GravityKit, secondary.** Tools generated at runtime from the connected site's GravityKit Foundation Abilities catalog; each product registers tools under its own server-owned prefix. They appear only when Foundation is active. GravityView is the only product wired up so far, using the `gv_*` prefix (View authoring, fields, widgets, search, layouts). The plane is product-agnostic: any GravityKit product that registers Foundation abilities shows up automatically under its own prefix.

The two planes are independent: a GF-only site gets the full `gf_*` surface with no abilities; a GravityKit site without GF REST keys still gets its GravityKit tools.

**Main entry point:** `src/index.js`
**Architecture style:** MCP SDK server with stdio transport, one HTTP client per plane, composable validation
**Key dependency:** `@modelcontextprotocol/sdk` ^1.0.0

## Repository Map

```
MCP/
├── package.json              # @gravitykit/mcp, ESM, npm scripts
├── mcp.json                  # MCP manifest (tool catalog, auth config)
├── .env.example              # All env vars documented
├── AGENTS.md                 # Canonical agent + developer docs (this file)
├── CLAUDE.md                 # Claude Code entry point — re-exports AGENTS.md (@AGENTS.md)
├── src/
│   ├── index.js              # Server bootstrap, two-plane init, tool registration, handler routing
│   ├── gravity-forms-client.js  # GravityFormsClient: GF REST HTTP client, all gf_* API methods
│   ├── wp-client.js          # WordPressClient: product-agnostic authenticated WP transport (Plane B)
│   ├── version.js            # VERSION + USER_AGENT, single-sourced from package.json
│   ├── server-runtime.js     # Pure helpers: runPlaneInit, buildToolList, classifyAbilityCall
│   ├── abilities/
│   │   └── loader.js         # loadAbilitiesAsTools() — turns the live Abilities catalog into product tools (GravityView → gv_*)
│   ├── gravityview/          # GravityView test/demo harness (NOT runtime — gv_* come from abilities/)
│   │   ├── inspector-client.js  # Client for /wp-json/gravityview/v1 (only when DOING_GRAVITYVIEW_TESTS)
│   │   └── view-validator.js    # Client-side structural + schema-aware validation for the inspector
│   ├── field-operations/     # Intelligent field management layer (gf_* field tools)
│   │   ├── index.js          # Factory, tool definitions, handler functions
│   │   ├── field-manager.js  # FieldManager: CRUD orchestrator
│   │   ├── field-dependencies.js  # DependencyTracker: conditional logic/merge tag scanning
│   │   └── field-positioner.js    # PositionEngine: page-aware field positioning
│   ├── field-definitions/
│   │   ├── field-registry.js # 46 field types with metadata, validation, storage patterns
│   │   └── loader.js         # Registry loader
│   ├── config/
│   │   ├── auth.js           # BasicAuthHandler, OAuth1Handler, AuthManager
│   │   ├── validation.js     # ValidationFactory, BaseValidator, domain validators
│   │   ├── validation-chain.js  # Composable rule chain system
│   │   ├── validation-rules.js  # Individual validation rules
│   │   ├── validation-config.js # Validation constants and enums
│   │   ├── validators.js     # Domain-specific validators (forms, entries, feeds, etc.)
│   │   ├── field-validation.js  # FieldAwareValidator for field-specific rules
│   │   └── test-config.js    # Dual test/live environment config, TestFormManager
│   └── utils/
│       ├── compact.js        # stripEmpty() — recursive null/empty/false stripping for token optimization
│       ├── logger.js         # MCP-safe logger (stderr in MCP mode, console in test)
│       └── sanitize.js       # Credential masking for safe logging
├── test/                     # Test suites — top-level, NOT published (see Packaging)
│   ├── run.js                # Custom test runner (npm run test:unit)
│   ├── helpers.js            # Mock data generators, test utilities
│   ├── integration.test.js   # Live API integration tests (npm test)
│   ├── views.test.js, views-stress.test.js   # GravityView inspector + abilities coverage
│   ├── abilities-loader.test.js              # Abilities catalog → gv_* tool generation
│   └── *.test.js             # forms, entries, feeds, fields, validation, submissions, compact, sanitize, …
├── scripts/
│   ├── check-env.js          # Environment validation script
│   ├── check-docs.mjs        # Doc-freshness guard for AGENTS.md (offline; npm run lint:docs)
│   ├── verify-tool-names.mjs # Cross-check doc/instruction tool names vs registered tools (needs live site)
│   ├── lib/
│   │   └── ability-catalog.mjs  # collectAbilityNames() — paginated Abilities catalog reader
│   ├── stress-abilities.mjs  # Synthetic abilities-loader stress/contract test
│   ├── setup-test-data.js    # Test data seeding
│   ├── test-field-ops.js     # Field operations smoke test
│   ├── test-server-output.js # Server output verification
│   └── verify-field-tools.js # Field tool registration check
└── .github/workflows/
    ├── publish.yml           # npm publish workflow
    ├── security.yml          # Security scanning
    └── test.yml              # CI test runner
```

## Architecture

### Two capability planes

The server registers tools from two independent sources, initialized separately so a failure in one never blocks the other:

- **Plane A — Gravity Forms (`gf_*`).** Static tool definitions in `src/index.js` (`GF_TOOL_DEFINITIONS`) plus the field tools from `src/field-operations/index.js` (`fieldOperationTools`). Backed by `GravityFormsClient` against the GF REST API v2. 26 tools, always present once GF credentials validate.
- **Plane B — GravityKit.** Generated at runtime by `src/abilities/loader.js` from the connected site's Abilities catalog, backed by `WordPressClient`; each product's tools carry its own prefix (GravityView → `gv_*`). The catalog is fetched in the background after startup; tools appear once it loads (the server advertises `tools.listChanged`). A single built-in tool, `gk_reload_abilities`, forces a re-fetch.

### Initialization Flow

1. `src/index.js` loads env vars via dotenv (CWD first, then project dir).
2. Creates the MCP `Server` with `tools.listChanged` capability and the two-plane server instructions.
3. **Plane A:** `initializeClient()` constructs `GravityFormsClient` from `process.env`; its `AuthManager` selects Basic or OAuth; `validateRestApiAccess()` probes Forms/Entries/Feeds; field operations (`FieldManager`, `DependencyTracker`, `PositionEngine`) are wired up.
4. **Plane B:** constructs `WordPressClient` and kicks off a fire-and-forget abilities catalog fetch (`loadAbilitiesAsTools`). Startup never blocks on it; failures self-heal on the next `gv_*` call (after a cooldown) or via `gk_reload_abilities`.
5. Server connects to `StdioServerTransport`.

### Core Concepts

**GravityFormsClient** (`gravity-forms-client.js`): Single class wrapping all GF API endpoints. Each method uses the `validateAndCall(toolName, input, apiCall)` pattern — validates input via `ValidationFactory`, then executes the HTTP call. Update operations (forms, entries, feeds) fetch-then-merge to preserve existing data. Returns minimal payloads.

**WordPressClient** (`wp-client.js`): Product-agnostic authenticated WordPress transport for Plane B. The abilities loader rides it to reach the Foundation catalog (`/wp-json/gravitykit/v1/...`) and the WP core Abilities API (`/wp-json/wp-abilities/v1/...`). Auth is a WordPress Application Password via HTTP Basic; when `GRAVITYKIT_WP_*` creds aren't set it falls back to `GRAVITY_FORMS_CONSUMER_KEY`/`SECRET` (commonly the same WP user + app password).

**Abilities loader** (`abilities/loader.js`): `loadAbilitiesAsTools(wpClient)` builds the GravityKit product tool definitions + handlers from the live catalog (GravityView's carry the `gv_*` prefix). Source-preference chain: (1) Foundation catalog `/wp-json/gravitykit/v1/abilities` (server-filtered to GravityKit, server-owned tool names), (2) WP core catalog `/wp-json/wp-abilities/v1/abilities` (filtered client-side on Foundation's stamped `meta.gk_registered_by`), (3) throw if neither is reachable (caller leaves `gv_*` unregistered and retries — self-healing). **Tool names are owned by the server** via each ability's `mcp_tool_name` (from the product's `mcp_prefix`, or the full product slug); abilities without one are skipped with a warning rather than client-invented. Handlers execute abilities at `/wp-abilities/v1/abilities/{name}/run` with the HTTP method derived from annotations (`readonly` → GET, `destructive`+`idempotent` → DELETE, else POST).

**GravityView harness** (`gravityview/inspector-client.js`, `view-validator.js`): The Inspector client and validator target `/wp-json/gravityview/v1` routes that exist only when `DOING_GRAVITYVIEW_TESTS` is defined server-side. They are the integration-test and demo harness — **not** a runtime dependency. Runtime `gv_*` tools come from the abilities loader.

**AuthManager** (`config/auth.js`): Credential-aware selection between `BasicAuthHandler` and `OAuth1Handler` — app-password creds get Basic (HTTPS or local URLs); `ck_`/`cs_` key pairs get Basic on HTTPS, OAuth on plain HTTP (matching the GF server's `is_ssl()` gate for key Basic auth). Explicit `GRAVITY_FORMS_AUTH_METHOD` overrides.

**ValidationFactory** (`config/validation.js`): Central validation dispatcher. `validateToolInput(toolName, input)` routes to domain-specific validators. Composable rule chains (`validation-chain.js`) for reusable validation logic.

**FieldManager** (`field-operations/field-manager.js`): Handles field CRUD within REST API v2 constraints (fields are properties of form objects, not separate endpoints). Generates integer IDs via max+1, creates compound sub-inputs for address/name/creditcard fields.

**Field Registry** (`field-definitions/field-registry.js`): Metadata for all 46 Gravity Forms field types — categories, storage patterns (simple/compound/special), validation rules, variants, and capability flags.

### Data Flow

```
MCP Client → stdio → Server.CallToolRequestSchema handler
  → switch(name):
      gf_* / field tools → wrapHandler(GravityFormsClient.method)
                           → validateAndCall → ValidationFactory → axios (auth interceptor)
                           → minimal result
      gv_*               → ability handler → WordPressClient → /wp-abilities/v1/.../run
      gk_reload_abilities → force catalog re-fetch
  → JSON.stringify(result) → compact MCP content block (no pretty-print)
  ← { content: [{ type: "text", text: "..." }] }
```

### Token Optimization

Responses are optimized for minimal token usage:

- **Compact JSON**: `JSON.stringify(result)` — no pretty-printing (no `null, 2`).
- **Minimal payloads**: No redundant `message`, `created`/`updated` booleans, or echo-back of input IDs. GET methods return `{ resource: data }`; mutations return only what can't be inferred (e.g., delete returns `{ deleted: true, id, permanently }`).
- **Summary/detail modes**: `gf_list_field_types` defaults to summary mode (`type`, `label`, `category`). Pass `detail=true` for full metadata; add `include_variants=true` for variant data.
- **Compact mode (default on)**: `stripEmpty()` (`utils/compact.js`) recursively removes `null` and `""` from all responses. `false` is preserved (semantic meaning). Entry tools also strip plugin-added meta keys (e.g., `gv_revision_*`, `helpscout_conversation_id`) via `stripEntryMeta()`, keeping only core properties and numbered field values. Pass `compact=false` for full raw data.
- **Terse descriptions**: All tool and property descriptions are kept terse to reduce `tools/list` overhead.

### Tool Categories

**Plane A — Gravity Forms (`gf_*`), 26 static tools:**

| Category | Tools | Client Methods |
|----------|-------|----------------|
| Forms | `gf_list_forms`, `gf_get_form`, `gf_create_form`, `gf_update_form`, `gf_delete_form`, `gf_validate_form` | `listForms`, `getForm`, `createForm`, `updateForm`, `deleteForm`, `validateForm` |
| Entries | `gf_list_entries`, `gf_get_entry`, `gf_create_entry`, `gf_update_entry`, `gf_delete_entry` | `listEntries`, `getEntry`, `createEntry`, `updateEntry`, `deleteEntry` |
| Submissions | `gf_submit_form_data`, `gf_validate_submission` | `submitFormData`, `validateSubmission` |
| Notifications | `gf_send_notifications` | `sendNotifications` |
| Feeds | `gf_list_feeds`, `gf_get_feed`, `gf_create_feed`, `gf_update_feed`, `gf_patch_feed`, `gf_delete_feed` | `listFeeds`, `getFeed`, `createFeed`, `updateFeed`, `patchFeed`, `deleteFeed` |
| Utilities | `gf_get_field_filters`, `gf_get_results` | `getFieldFilters`, `getResults` |
| Field Ops | `gf_add_field`, `gf_update_field`, `gf_delete_field`, `gf_list_field_types` | via `fieldOperationHandlers` → `FieldManager` |

**Plane B — GravityKit, dynamic.** Generated from the catalog, so the exact set depends on the connected site's GravityKit products and versions — each product under its own prefix; discover at runtime, don't hard-code. GravityView (prefix `gv_*`) currently contributes tool families for View lifecycle (`gv_view_create`, `gv_view_config_apply`, `gv_view_delete`, …), fields (`gv_view_field_add`/`patch`/`move`/`remove`), grid rows, widgets, search fields, and discovery/schema (`gv_layouts_list`, `gv_widgets_list`, `gv_field_type_schema_get`, `gv_available_fields_get`, …). Plus the built-in `gk_reload_abilities`. Use the `gv_*_list` discovery tools and `gv_field_type_schema_get` to introspect what's available; the server `instructions` string documents the GravityView authoring flow. To re-verify that prose tool names still match the live catalog, run `npm run verify:tool-names` (see Releasing).

### Response Shapes

GET/list methods return just the data:
```javascript
{ form: responseData }              // gf_get_form
{ forms: responseData, total_count, total_pages }  // gf_list_forms
{ entries: responseData, total_count }              // gf_list_entries
{ entry: responseData }             // gf_get_entry
{ feed: responseData }              // gf_get_feed, gf_create_feed, gf_update_feed, gf_patch_feed
{ feeds: responseData }             // gf_list_feeds (pass form_id to scope to one form)
```

Mutation methods return minimal confirmation:
```javascript
{ deleted: true, form_id, permanently }  // gf_delete_form, gf_delete_entry
{ deleted: true, feed_id }               // gf_delete_feed
{ valid: true/false, validation_messages }  // gf_validate_form, gf_validate_submission
{ success: true/false, entry_id, confirmation_message, validation_messages }  // gf_submit_form_data
{ sent: true, notifications_sent }       // gf_send_notifications
```

## Conventions

### File & Class Naming

- Files: `kebab-case.js` (e.g., `field-manager.js`, `gravity-forms-client.js`)
- Classes: `PascalCase` (e.g., `GravityFormsClient`, `FieldManager`, `WordPressClient`)
- Exports: Named exports for classes, default export for the primary class per file
- Test files: `{module-name}.test.js` in the top-level `test/` directory

### Module System

- ESM throughout (`"type": "module"` in package.json)
- All imports use `.js` extension (required for ESM)
- `__dirname` shimmed via `fileURLToPath(import.meta.url)` where needed

### Error Handling Pattern

All tool handlers use `wrapHandler()` in `src/index.js`:
- Checks client initialization
- Wraps the result in MCP content blocks `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
- Catches errors → `createErrorResponse()` with sanitized details
- Error details pass through `sanitize()` to mask credentials

### API Method Pattern

Every `GravityFormsClient` method follows this pattern:
```javascript
async methodName(params) {
  return this.validateAndCall('tool_name', params, async (validated) => {
    const response = await this.httpClient.get/post/put/delete(path, data);
    return { resource: response.data };  // Minimal return — no redundant fields
  });
}
```

Update methods (forms, entries, feeds) always **fetch-then-merge** to preserve existing data:
```javascript
const existing = await this.httpClient.get(`/resource/${id}`);
const merged = { ...existing.data, ...updates };
await this.httpClient.put(`/resource/${id}`, merged);
```

### Delete Safety

All GF delete operations (`deleteForm`, `deleteEntry`, `deleteFeed`) check `this.allowDelete` first, controlled by `GRAVITY_FORMS_ALLOW_DELETE=true`. Without it, deletes throw immediately.

### Logging

`utils/logger.js` routes all logs to stderr in MCP mode (keeps stdout clean for JSON-RPC). In test mode it uses console.log. Sensitive data is masked via `utils/sanitize.js`. Never use `console.log` in server code.

## Extension Patterns

### Adding a New Gravity Forms Tool

1. **Define the tool schema** in `src/index.js` (in `GF_TOOL_DEFINITIONS`, surfaced by the `ListToolsRequestSchema` handler) with a concise description:
   ```javascript
   {
     name: 'gf_new_tool',
     description: 'Short description',  // Keep terse for token efficiency
     inputSchema: { type: 'object', properties: {...}, required: [...] }
   }
   ```
2. **Add the client method** in `gravity-forms-client.js` using `validateAndCall`, returning minimal data.
3. **Add validation** in `config/validation.js` inside `ValidationFactory.validateToolInput()`.
4. **Add the handler route** in the `CallToolRequestSchema` switch in `src/index.js`.
5. **Write the failing test first** (TDD — see Test-Driven Development above), then implement steps 1–4 to make it pass. Tests live in `test/`, importing the source under test as `../src/…` (see `forms.test.js`).

### Adding GravityKit Product Tools

GravityKit product tools (e.g. GravityView's `gv_*`) are **not** defined in this repo — they come from the connected site's Foundation Abilities catalog. To add or change them, register/modify abilities in the relevant GravityKit product (the server stamps each ability's `mcp_tool_name`); the loader picks them up automatically. After a catalog change, run `gk_reload_abilities` (live) or `npm run verify:tool-names` to confirm names.

### Adding a New Field Type to the Registry

Add an entry in `field-definitions/field-registry.js`:
```javascript
newfield: {
  type: 'newfield',
  label: 'My New Field',
  category: 'standard',  // standard | advanced | pricing | post
  supportsRequired: true,
  supportsConditionalLogic: true,
  storage: { type: 'string', format: 'single' },  // or 'compound'
  validation: { maxLength: 255 },
  variants: { default: { label: 'Default', settings: {} } }
}
```
For compound fields (multi-input like address/name), set `storage.type: 'compound'` and add sub-input generation logic in `field-manager.js` (`generateSubInputs()`).

### Adding a New Validation Rule

1. Create the rule class in `config/validation-rules.js`
2. Add the chainable method in `config/validation-chain.js`
3. Use it in validators via `validate('fieldName').newRule()`

## Test-Driven Development (required)

All development here is **test-first** — features, bug fixes, refactors, behavior changes. The cycle is non-negotiable:

1. **RED** — write one failing test that pins the intended behavior, and run it to watch it fail *for the right reason*. No production code before this.
2. **GREEN** — write the minimal code to make it pass; keep the rest of the suite green.
3. **REFACTOR** — clean up with the tests staying green.

A test that passes the first time you run it proves nothing — if you can't point to the RED run, it isn't TDD. Extract logic into a testable unit instead of burying it inline where it can't be exercised (e.g. `feedUnavailable` and `collectAbilityNames` were extracted so their behavior is covered, RED-then-GREEN). Bug fixes start with a failing test that reproduces the bug.

Pure-function/unit tests use `node:test` and live in `test/` (run via `npm run test:node`); see Testing. Never wire a fix into the codebase ahead of its failing test.

## Development

### Setup

```bash
npm install
cp .env.example .env   # Edit with your Gravity Forms API credentials
npm run check-env      # Verify environment
npm run dev            # Dev with auto-reload
npm run inspect        # Debug with MCP Inspector
```

### Required Environment (Plane A — Gravity Forms)

```
GRAVITY_FORMS_BASE_URL=https://...   # WordPress site URL (no trailing slash)
# Recommended — WordPress application password (Users > Profile):
GRAVITY_FORMS_CONSUMER_KEY=wp_username
GRAVITY_FORMS_CONSUMER_SECRET="xxxx xxxx xxxx xxxx xxxx xxxx"
# Or a Gravity Forms API key (Forms > Settings > REST API), e.g. read-only:
# GRAVITY_FORMS_CONSUMER_KEY=ck_...
# GRAVITY_FORMS_CONSUMER_SECRET=cs_...
# Either way: check "Enable access to the API" on Forms > Settings > REST API once.
```

Shorthand aliases `GF_CONSUMER_KEY`, `GF_CONSUMER_SECRET`, `GF_URL` are also supported (resolved in `test-config.js`).

### GravityKit Environment (Plane B — abilities)

```
# Optional — only needed for gv_* tools. Falls back to GRAVITY_FORMS_* when unset.
GRAVITYKIT_WP_URL=https://...        # WordPress site URL (usually same as GF)
GRAVITYKIT_WP_USERNAME=wp_username
GRAVITYKIT_WP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
```

`WordPressClient` resolves the base URL from `GRAVITYKIT_WP_URL` or `GRAVITY_FORMS_BASE_URL`, and credentials from `GRAVITYKIT_WP_*` or the `GRAVITY_FORMS_CONSUMER_KEY`/`SECRET` fallback. On most single-site setups the GF credentials already double as the WP app password, so no extra config is needed.

### Optional Environment

```
# GRAVITY_FORMS_AUTH_METHOD=basic     # Override auto-selection only (see Gotcha #3)
# GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=false  # Basic to a REMOTE plain-HTTP host
GRAVITY_FORMS_ALLOW_DELETE=false      # Must be 'true' to enable delete operations
GRAVITY_FORMS_TIMEOUT=30000           # Request timeout in ms
GRAVITY_FORMS_MAX_RETRIES=3           # Max retry attempts
GRAVITY_FORMS_DEBUG=false             # Enable debug logging (stderr)
GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=false     # Allow self-signed certs (local dev only)
```

**Note:** `GRAVITY_FORMS_RETRY_DELAY`, `GRAVITY_FORMS_RATE_LIMIT`, and `GRAVITY_FORMS_RATE_WINDOW` appear in older docs but are NOT implemented in source code.

### Test Environment

```
GRAVITY_FORMS_TEST_BASE_URL=          # Test site URL
GRAVITY_FORMS_TEST_CONSUMER_KEY=      # Test site API key
GRAVITY_FORMS_TEST_CONSUMER_SECRET=   # Test site API secret
GRAVITY_FORMS_TEST_AUTH_METHOD=       # Override auth method for test site
GRAVITY_FORMS_TEST_TIMEOUT=           # Override timeout for test site
GRAVITYKIT_MCP_TEST_MODE=true         # Enable test mode (remaps TEST_* vars)
```

Shorthand aliases: `TEST_GF_URL`, `TEST_GF_CONSUMER_KEY`, `TEST_GF_CONSUMER_SECRET`, `TEST_WP_USER`, `TEST_WP_PASSWORD`. Legacy: `GRAVITYMCP_TEST_MODE` and `GRAVITY_FORMS_TEST_URL` are also supported. Test mode also activates when `NODE_ENV=test`.

### Testing

```bash
npm run test:unit      # Unit tests via custom runner
npm run test:node      # node:test unit suites (field ops, helpers, ability-catalog, bench grader/runner)
npm run test:auth      # Authentication tests
npm run test:forms     # Forms endpoint tests
npm run test:entries   # Entries endpoint tests
npm run test:feeds     # Feeds endpoint tests
npm run test:tools     # Tool registration validation
npm run test:views     # GravityView inspector/validator tests
npm run test:all       # Run everything sequentially
npm test               # Integration tests (requires live API)
```

Two unit harnesses run side by side: the **custom `TestRunner`** (suites export a runner and are registered in `test/run.js`, run via `npm run test:unit`) and **`node:test`** (suites are listed in the `test:node` script in `package.json`, run via `npm run test:node`) — the latter includes the dev-only bench grader/runner tests (`test/bench-*.test.js`). A new suite only runs once it is registered in the matching place. `test/helpers.js` provides mock data generators (`generateMockForm`, `generateMockEntry`, `generateMockFeed`). For integration tests, set `GRAVITY_FORMS_TEST_*` env vars pointing to a test WordPress site; test forms are prefixed with `TEST_` and auto-cleaned via `TestFormManager`. **See `test/AGENTS.md` for which harness to use, how to register a new test, and how the `bench/` AI gate relates to the unit suites.**

### Building

No build step — pure ESM JavaScript, runs directly with `node src/index.js`. Requires Node.js >= 18.

## Gotchas

1. **Fields are form properties, not separate endpoints.** The Gravity Forms REST API has no direct field CRUD endpoints. All field operations fetch the entire form, modify the fields array, then PUT the whole form back. This is why `FieldManager` exists as a layer on top of `GravityFormsClient`.

2. **Stdout is reserved for JSON-RPC.** In MCP mode, ALL logging must go to stderr. `console.log` corrupts the transport. Use `logger.info/error/warn`.

3. **Auth method is credential-aware.** `AuthManager` picks the transport from the credential shape: app-password creds use Basic over HTTPS or local URLs; `ck_`/`cs_` key pairs use Basic over HTTPS and OAuth 1.0a over plain HTTP (Gravity Forms only checks key-pair Basic auth when `is_ssl()`). An explicit `GRAVITY_FORMS_AUTH_METHOD` is always honored — including `basic` over remote HTTP, so don't set it in `.env` "just in case". Remote-HTTP Basic without an explicit method needs `GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=true`.

4. **Update operations fetch-then-merge.** `updateForm`, `updateEntry`, and `updateFeed` GET the existing resource, merge, then PUT — two HTTP calls per update. If the resource changes between GET and PUT, the intermediate change is overwritten.

5. **Field ID generation uses max+1.** If field ID 10 is deleted, the next field gets ID 11, not 10. IDs are never reused within a form.

6. **Compound field sub-input IDs use dot notation.** Address field 5 has sub-inputs `5.1` (street), `5.2` (line 2), etc. These IDs are strings, not numbers. Entry data uses these dot-notation keys.

7. **Delete operations are disabled by default.** `GRAVITY_FORMS_ALLOW_DELETE=true` must be set explicitly, or `deleteForm`/`deleteEntry`/`deleteFeed` throw. Intentional safety.

8. **`mcp.json` may be stale.** The runtime source of truth is `GF_TOOL_DEFINITIONS` + the `ListToolsRequestSchema` handler in `src/index.js`, `fieldOperationTools` in `field-operations/index.js` (26 `gf_*` tools), the built-in `gk_reload_abilities`, and the dynamic `gv_*` tools from the abilities loader.

9. **Self-signed certs for local dev.** Set `GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=true` to bypass certificate validation for local WordPress (Laravel Valet, Local WP, etc.). Never in production.

10. **Validation has legacy and new patterns.** A `BaseValidator` legacy layer wraps the newer `ValidationChain` and domain validators. Both paths are active. New code should use the chain system in `validation-chain.js`.

11. **`gf_list_field_types` defaults to summary mode.** Returns only `type`, `label`, `category`. Pass `detail=true` for full metadata; add `include_variants=true` for variants. Prevents dumping thousands of tokens for all 46 field types.

12. **Test mode resolves env vars at client construction.** When `GRAVITYKIT_MCP_TEST_MODE=true` (or legacy `GRAVITYMCP_TEST_MODE=true`), `testConfig.resolveEnv()` remaps `GRAVITY_FORMS_TEST_*` → `GRAVITY_FORMS_*`. The rest of the client and AuthManager work unchanged.

13. **`gv_*` tools load asynchronously and self-heal.** The abilities catalog is fetched in the background after startup, so `gv_*` tools may be absent for a moment (the server emits a `tools/listChanged` once they arrive). If a catalog fetch fails, it retries after a cooldown or immediately on `gk_reload_abilities`. The `src/gravityview/` Inspector client is a test/demo harness only — runtime `gv_*` come from the abilities loader.

## Packaging

What ships to npm is governed solely by the **`files` allowlist** in `package.json` — there is intentionally **no `.npmignore`** (with a `files` field present npm ignores it, so keeping one is misleading). Allowlist, not denylist: a new file ships only if it matches `files`.

- **Ships:** `src/` (runtime), `mcp.json`, `.env.example`, `README.md`, `LICENSE`, `CLAUDE.md`, `AGENTS.md`.
- **Excluded by omission:** `test/` (tests are top-level, not under `src/`), `scripts/` (dev tooling), `.github/`, `package-lock.json`.
- **`npm run lint:package`** runs [publint](https://publint.dev) to validate package correctness; **`npm run lint:docs`** runs the offline doc-freshness guard (`scripts/check-docs.mjs`). **`prepublishOnly`** runs the offline test suites + both linters, so a broken, mis-packaged, or stale-documented build can't be published. It deliberately omits the live integration test (`npm test`) to avoid hitting a real site during publish.
- **Verify before publishing:** `npm pack --dry-run` lists exactly what will ship.

## Releasing

**Every version tag MUST include a CHANGELOG.md update.** Follow this checklist:

1. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` section with all changes since the last release. Follow [Keep a Changelog](https://keepachangelog.com/) format (Added, Changed, Fixed, Removed).
2. **Bump `version` in `package.json`**
3. **Update version in `AGENTS.md`** (Project Identity → Package line)
4. **Add link** at bottom of `CHANGELOG.md`: `[X.Y.Z]: https://github.com/GravityKit/MCP/releases/tag/vX.Y.Z`
5. **Commit**: `git commit -m "chore(release): bump version to X.Y.Z"`
6. **Tag**: `git tag vX.Y.Z`
7. **Push**: `git push origin main --tags`

Skipping any step (especially CHANGELOG) leaves the release history incomplete.

**Before tagging:**
- Run **`npm run lint:docs`** — the offline doc-freshness guard (repo-map coverage, tool/field counts, no line citations). `prepublishOnly` runs it too.
- Run **`npm run verify:tool-names` against a live site** — the `gv_*` tools are generated from the installed GravityView/Foundation Abilities catalog, so a catalog rename can silently leave the server `instructions` string, README, or the demo referencing tools that no longer exist. The script cross-checks every `gf_`/`gv_` name in prose against what the server registers and exits non-zero on a mismatch. Needs WordPress credentials (see GravityKit Environment). Dev-only — not shipped in the npm package.
- Run **`npm run bench` — the AI release gate** (`bench/`). It drives the whole flow (forms/entries/views/fields/widgets/search/grid CRUD) through a **small model** (`claude-haiku-4-5`) over the MCP and exits non-zero if any task falls below the success threshold. A small model failing means the tool surface is too hard for an agent to use — fix descriptions/schemas/errors, not the gate. Needs the `claude` CLI + a `GRAVITY_FORMS_TEST_*`/`GRAVITY_FORMS_*` site running the code under test; slow + token-costly, so it's a release gate, not per-commit CI. Dev-only — not shipped.

## Related Resources

- **CLAUDE.md** — Claude Code entry point; re-exports this file via `@AGENTS.md`
- **README.md** — User-facing setup and usage guide
- **.env.example** — Complete environment variable reference
- **mcp.json** — MCP manifest (tool catalog, auth requirements)
- [Gravity Forms REST API v2 docs](https://docs.gravityforms.com/rest-api-v2/)
- [MCP SDK docs](https://modelcontextprotocol.io)
