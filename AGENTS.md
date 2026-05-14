# AGENTS.md — GravityKit MCP

> MCP server providing 26 tools for full Gravity Forms REST API v2 coverage, enabling AI agents to manage forms, entries, feeds, notifications, and fields programmatically.

## Quick Start

**What this is:** A Node.js MCP (Model Context Protocol) server that wraps the Gravity Forms REST API v2. It authenticates via Basic Auth (preferred) or OAuth 1.0a and exposes 26 tools for CRUD operations on forms, entries, feeds, notifications, field filters, results, and intelligent field management.

**Main entry point:** `src/index.js`
**Architecture style:** MCP SDK server with stdio transport, single API client, composable validation
**Key dependency:** `@modelcontextprotocol/sdk` ^1.0.0

## Repository Map

```
MCP/
├── package.json              # @gravitykit/mcp, ESM, npm scripts
├── mcp.json                  # MCP manifest (tool catalog, auth config)
├── .env.example              # All env vars documented
├── CLAUDE.md                 # Project docs for AI context
├── src/
│   ├── index.js              # Server bootstrap, tool registration, handler routing
│   ├── gravity-forms-client.js  # GravityFormsClient: HTTP client, all API methods
│   ├── field-operations/     # Intelligent field management layer
│   │   ├── index.js          # Factory, tool definitions, handler functions
│   │   ├── field-manager.js  # FieldManager: CRUD orchestrator
│   │   ├── field-dependencies.js  # DependencyTracker: conditional logic/merge tag scanning
│   │   └── field-positioner.js    # PositionEngine: page-aware field positioning
│   ├── field-definitions/
│   │   ├── field-registry.js # 44 field types with metadata, validation, storage patterns
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
│   ├── utils/
│   │   ├── compact.js        # stripEmpty() — recursive null/empty/false stripping for token optimization
│   │   ├── logger.js         # MCP-safe logger (stderr in MCP mode, console in test)
│   │   └── sanitize.js       # Credential masking for safe logging
│   └── tests/
│       ├── run.js            # Test runner
│       ├── helpers.js        # Mock data generators, test utilities
│       ├── integration.test.js          # Live API integration tests
│       ├── server-tools.test.js         # Tool registration validation
│       ├── forms.test.js                # Forms endpoint tests
│       ├── entries.test.js              # Entries endpoint tests
│       ├── feeds.test.js                # Feeds endpoint tests
│       ├── submissions.test.js          # Submission pipeline tests
│       ├── authentication.test.js       # Auth method tests
│       ├── validation.test.js           # Input validation tests
│       ├── field-validation.test.js     # Field-specific validation
│       ├── field-manager.test.js        # FieldManager unit tests
│       ├── field-dependencies.test.js   # DependencyTracker tests
│       ├── field-positioner.test.js     # PositionEngine tests
│       ├── field-registry.test.js       # Field registry tests
│       ├── field-operations-e2e.test.js # Field operations E2E
│       ├── field-operations-integration.test.js # Field ops integration
│       ├── compact.test.js             # stripEmpty compact utility tests
│       └── sanitize.test.js            # Sanitization tests
├── scripts/
│   ├── check-env.js          # Environment validation script
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

### Initialization Flow

1. `src/index.js` loads env vars via dotenv (CWD first, then project dir) — `:30-32`
2. Creates MCP `Server` instance with `tools` capability — `:35-45`
3. `initializeClient()` constructs `GravityFormsClient` with `process.env` — `:57`
4. Client creates `AuthManager` which selects Basic or OAuth handler — `config/auth.js:223-268`
5. Client creates axios instance with auth interceptor — `gravity-forms-client.js:22-85`
6. `validateRestApiAccess()` tests Forms/Entries/Feeds endpoints — `config/auth.js:301-368`
7. Field operations initialized: `FieldManager`, `DependencyTracker`, `PositionEngine` — `:64-70`
8. Server connects to `StdioServerTransport` — `:641-644`

### Core Concepts

**GravityFormsClient** (`gravity-forms-client.js`): Single class wrapping all API endpoints. Each method uses `validateAndCall(toolName, input, apiCall)` pattern — validates input via `ValidationFactory`, then executes the HTTP call. Update operations (forms, entries, feeds) fetch-then-merge to preserve existing data. Responses return minimal payloads — just the essential data without redundant metadata.

**AuthManager** (`config/auth.js`): Selects between `BasicAuthHandler` (primary, requires HTTPS) and `OAuth1Handler` (fallback). Auto-falls-back to OAuth if HTTPS isn't available. Auth headers injected via axios request interceptor.

**ValidationFactory** (`config/validation.js`): Central validation dispatcher. `validateToolInput(toolName, input)` routes to domain-specific validators. Composable rule chains (`validation-chain.js`) for reusable validation logic.

**FieldManager** (`field-operations/field-manager.js`): Handles field CRUD within REST API v2 constraints (fields are properties of form objects, not separate endpoints). Generates integer IDs via max+1 pattern, creates compound sub-inputs for address/name/creditcard fields.

**Field Registry** (`field-definitions/field-registry.js`): Metadata for all 44 Gravity Forms field types including categories, storage patterns (simple/compound/special), validation rules, variants, and capability flags.

### Data Flow

```
MCP Client → stdio → Server.CallToolRequestSchema handler
  → switch(name) routes to handler
  → wrapHandler() wraps execution:
    → GravityFormsClient.method(params)
      → validateAndCall(toolName, input, apiCall)
        → ValidationFactory.validateToolInput() → validated input
        → apiCall(validatedInput) → axios HTTP request
          → auth interceptor adds headers
          → response interceptor handles errors
      → minimal result object (no redundant fields)
    → JSON.stringify(result) → compact MCP content block (no pretty-print)
  ← { content: [{ type: "text", text: "..." }] }
```

### Token Optimization

Responses are optimized for minimal token usage:

- **Compact JSON**: `JSON.stringify(result)` — no pretty-printing (no `null, 2`) — `src/index.js:114`
- **Minimal payloads**: No redundant `message`, `created`/`updated` booleans, or echo-back of input IDs. GET methods return `{ resource: data }`, mutations return only what can't be inferred (e.g., delete returns `{ deleted: true, id, permanently }`)
- **Summary/detail modes**: `gf_list_field_types` defaults to summary mode (`type`, `label`, `category` only). Pass `detail=true` for full metadata (supports, storage, validation, icon). Pass `include_variants=true` with `detail=true` for variant data.
- **Compact mode (default on)**: `stripEmpty()` (`utils/compact.js`) recursively removes `null` and `""` values from all responses via `wrapHandler()`. `false` is preserved (semantic meaning). Entry tools also strip plugin-added meta keys (e.g., `gv_revision_*`, `helpscout_conversation_id`) via `stripEntryMeta()`, keeping only core properties and numbered field values. Pass `compact=false` for full raw data.
- **Concise tool descriptions**: All 28 tool descriptions and property descriptions are terse to reduce tool-list overhead

### Tool Categories

| Category | Tools | Client Methods |
|----------|-------|----------------|
| Forms | `gf_list_forms`, `gf_get_form`, `gf_create_form`, `gf_update_form`, `gf_delete_form`, `gf_validate_form` | `listForms`, `getForm`, `createForm`, `updateForm`, `deleteForm`, `validateForm` |
| Entries | `gf_list_entries`, `gf_get_entry`, `gf_create_entry`, `gf_update_entry`, `gf_delete_entry` | `listEntries`, `getEntry`, `createEntry`, `updateEntry`, `deleteEntry` |
| Submissions | `gf_submit_form_data`, `gf_validate_submission` | `submitFormData`, `validateSubmission` |
| Notifications | `gf_send_notifications` | `sendNotifications` |
| Feeds | `gf_list_feeds`, `gf_get_feed`, `gf_create_feed`, `gf_update_feed`, `gf_patch_feed`, `gf_delete_feed` | `listFeeds`, `getFeed`, `createFeed`, `updateFeed`, `patchFeed`, `deleteFeed` |
| Utilities | `gf_get_field_filters`, `gf_get_results` | `getFieldFilters`, `getResults` |
| Field Ops | `gf_add_field`, `gf_update_field`, `gf_delete_field`, `gf_list_field_types` | Handled via `fieldOperationHandlers` → `FieldManager` |

### Response Shapes

GET/list methods return just the data:
```javascript
{ form: responseData }              // gf_get_form
{ forms: responseData, total_count, total_pages }  // gf_list_forms
{ entries: responseData, total_count }              // gf_list_entries
{ entry: responseData }             // gf_get_entry
{ feed: responseData }              // gf_get_feed, gf_create_feed, gf_update_feed, gf_patch_feed
{ feeds: responseData }             // gf_list_feeds, gf_list_form_feeds
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
- Classes: `PascalCase` (e.g., `GravityFormsClient`, `FieldManager`, `AuthManager`)
- Exports: Named exports for classes, default export for primary class per file
- Test files: `{module-name}.test.js` alongside or in `tests/` directory

### Module System

- ESM throughout (`"type": "module"` in package.json)
- All imports use `.js` extension (required for ESM)
- `__dirname` shimmed via `fileURLToPath(import.meta.url)` in `src/index.js:25-26`

### Error Handling Pattern

All tool handlers use `wrapHandler()` (`src/index.js:99-125`):
- Checks client initialization
- Wraps result in MCP content blocks `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
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

All delete operations (`deleteForm`, `deleteEntry`, `deleteFeed`) check `this.allowDelete` first, controlled by `GRAVITY_FORMS_ALLOW_DELETE=true` env var. Without it, deletes throw immediately.

### Logging

`utils/logger.js` routes all logs to stderr in MCP mode (keeps stdout clean for JSON-RPC). In test mode, uses console.log. Sensitive data masked via `utils/sanitize.js`.

## Extension Patterns

### Adding a New Tool

1. **Define the tool schema** in `src/index.js` inside the `ListToolsRequestSchema` handler (`:131-519`). Add to the tools array with concise descriptions:
   ```javascript
   {
     name: 'gf_new_tool',
     description: 'Short description',  // Keep terse for token efficiency
     inputSchema: { type: 'object', properties: {...}, required: [...] }
   }
   ```

2. **Add the client method** in `gravity-forms-client.js` using `validateAndCall`. Return minimal data:
   ```javascript
   async newToolMethod(params) {
     return this.validateAndCall('gf_new_tool', params, async (validated) => {
       const response = await this.httpClient.get('/endpoint');
       return { data: response.data };  // No message, no echo-back IDs
     });
   }
   ```

3. **Add validation** in `config/validation.js` inside `ValidationFactory.validateToolInput()` (`:463-628`):
   ```javascript
   case 'gf_new_tool':
     BaseValidator.validateRequired(input, ['required_field']);
     return { required_field: BaseValidator.validateId(input.required_field) };
   ```

4. **Add the handler route** in `src/index.js` inside the `CallToolRequestSchema` handler switch (`:537-628`):
   ```javascript
   case 'gf_new_tool':
     return wrapHandler(() => gravityFormsClient.newToolMethod(params))();
   ```

5. **Add tests** — create test in `src/tests/` following existing patterns (see `forms.test.js` for reference).

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

For compound fields (multi-input like address/name), set `storage.type: 'compound'` and add sub-input generation logic in `field-manager.js:generateSubInputs()` (`:206-267`).

### Adding a New Validation Rule

1. Create the rule class in `config/validation-rules.js`
2. Add the chainable method in `config/validation-chain.js`
3. Use it in validators via `validate('fieldName').newRule()`

## Development

### Setup

```bash
npm install
cp .env.example .env   # Edit with your Gravity Forms API credentials
npm run check-env      # Verify environment
npm run dev            # Dev with auto-reload
npm run inspect        # Debug with MCP Inspector
```

### Required Environment

```
GRAVITY_FORMS_CONSUMER_KEY=ck_...    # From WP Admin > Forms > Settings > REST API
GRAVITY_FORMS_CONSUMER_SECRET=cs_... # Same location
GRAVITY_FORMS_BASE_URL=https://...   # WordPress site URL (no trailing slash)
```

Shorthand aliases `GF_CONSUMER_KEY`, `GF_CONSUMER_SECRET`, `GF_URL` are also supported (resolved in `test-config.js`).

### Optional Environment

```
GRAVITY_FORMS_AUTH_METHOD=basic       # 'basic' (default) or 'oauth'/'oauth1'
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

Shorthand aliases: `TEST_GF_URL`, `TEST_GF_CONSUMER_KEY`, `TEST_GF_CONSUMER_SECRET`, `TEST_WP_USER`, `TEST_WP_PASSWORD`.

Legacy: `GRAVITYMCP_TEST_MODE` and `GRAVITY_FORMS_TEST_URL` are also supported. Test mode also activates when `NODE_ENV=test`.

### Testing

```bash
npm run test:unit      # Unit tests via custom runner
npm run test:auth      # Authentication tests
npm run test:forms     # Forms endpoint tests
npm run test:entries   # Entries endpoint tests
npm run test:feeds     # Feeds endpoint tests
npm run test:tools     # Tool registration validation
npm run test:all       # Run everything sequentially
npm test               # Integration tests (requires live API)
```

Tests use a custom runner (`src/tests/run.js`), not Jest/Mocha. Test helpers in `src/tests/helpers.js` provide mock data generators (`generateMockForm`, `generateMockEntry`, `generateMockFeed`).

For integration tests, set `GRAVITY_FORMS_TEST_*` env vars pointing to a test WordPress site. Test forms are prefixed with `TEST_` and auto-cleaned via `TestFormManager`.

### Building

No build step — pure ESM JavaScript, runs directly with `node src/index.js`. Requires Node.js >= 18.

## Gotchas

1. **Fields are form properties, not separate endpoints.** The Gravity Forms REST API has no direct field CRUD endpoints. All field operations require fetching the entire form, modifying the fields array, then PUT-ing the whole form back. This is why `FieldManager` exists as a layer on top of `GravityFormsClient`. — `field-manager.js:31-56`

2. **Stdout is reserved for JSON-RPC.** In MCP mode, ALL logging must go to stderr. Using `console.log` will corrupt the JSON-RPC transport. The `logger.js` utility handles this, but any new code must use `logger.info/error/warn` instead of `console.log`. — `utils/logger.js:14-32`

3. **Auth fallback is silent.** If Basic Auth fails because the site uses HTTP (not HTTPS), `AuthManager` silently falls back to OAuth 1.0a. Only warns in non-test mode. This can cause confusing auth failures if OAuth credentials aren't properly configured. — `config/auth.js:250-267`

4. **Update operations fetch-then-merge.** `updateForm`, `updateEntry`, and `updateFeed` all GET the existing resource first, merge updates, then PUT. This prevents data loss but means two HTTP calls per update. If the resource is modified between GET and PUT, the intermediate change is overwritten. — `gravity-forms-client.js:262-278`

5. **Field ID generation uses max+1.** If a field with ID 10 is deleted, the next field gets ID 11, not 10. IDs are never reused within a form. — `field-manager.js:173-182`

6. **Compound field sub-input IDs use dot notation.** Address field 5 has sub-inputs `5.1` (street), `5.2` (line 2), etc. These IDs are strings, not numbers. Entry data uses these dot-notation keys. — `field-manager.js:206-267`

7. **Delete operations are disabled by default.** `GRAVITY_FORMS_ALLOW_DELETE=true` must be explicitly set. Without it, `deleteForm`, `deleteEntry`, and `deleteFeed` throw immediately. This is intentional safety. — `gravity-forms-client.js:88, 292-294`

8. **The `mcp.json` manifest may be stale.** The `ListToolsRequestSchema` handler in `index.js` plus `fieldOperationTools` in `field-operations/index.js` are the source of truth (22 + 4 = 26 tools total). — `src/index.js` + `src/field-operations/index.js`

9. **Self-signed certs for local dev.** Set `GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=true` to bypass certificate validation for local WordPress environments (Laravel Valet, Local WP, etc.). Never enable in production. — `gravity-forms-client.js:31-33`

10. **Validation has legacy and new patterns.** The validation system has a `BaseValidator` legacy layer wrapping newer `ValidationChain` and domain-specific validators. Both paths are active. New code should use the chain system in `validation-chain.js`. — `config/validation.js:21-260`

11. **`gf_list_field_types` defaults to summary mode.** Returns only `type`, `label`, `category` per field type. Pass `detail=true` for full metadata (supports, storage, validation). Pass `include_variants=true` with `detail=true` for variant data. This prevents accidentally dumping thousands of tokens for all 44 field types. — `field-operations/index.js:142-211`

12. **Test mode resolves env vars at client construction.** When `GRAVITYKIT_MCP_TEST_MODE=true` (or legacy `GRAVITYMCP_TEST_MODE=true`), `testConfig.resolveEnv()` remaps `GRAVITY_FORMS_TEST_BASE_URL` → `GRAVITY_FORMS_BASE_URL` (and consumer key/secret). The rest of the client and AuthManager work unchanged. — `config/test-config.js:60-95`, `gravity-forms-client.js:16`

## Releasing

**Every version tag MUST include a CHANGELOG.md update.** Follow this checklist:

1. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` section with all changes since the last release. Follow [Keep a Changelog](https://keepachangelog.com/) format (Added, Changed, Fixed, Removed).
2. **Bump `version` in `package.json`**
3. **Update version in `CLAUDE.md`** (Project Identity → Package line)
4. **Add link** at bottom of `CHANGELOG.md`: `[X.Y.Z]: https://github.com/GravityKit/MCP/releases/tag/vX.Y.Z`
5. **Commit**: `git commit -m "chore(release): bump version to X.Y.Z"`
6. **Tag**: `git tag vX.Y.Z`
7. **Push**: `git push origin main --tags`

Skipping any step (especially CHANGELOG) will leave the release history incomplete for future developers and AI agents.

## Related Resources

- **CLAUDE.md** — Concise project identity and critical rules
- **README.md** — User-facing setup and usage guide
- **.env.example** — Complete environment variable reference
- **mcp.json** — MCP manifest (tool catalog, auth requirements)
- [Gravity Forms REST API v2 docs](https://docs.gravityforms.com/rest-api-v2/)
- [MCP SDK docs](https://modelcontextprotocol.io)
