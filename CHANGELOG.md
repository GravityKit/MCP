# Changelog

All notable changes to GravityKit MCP (formerly GravityMCP) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] - 2026-06-17

A field-model correctness pass. An adversarial audit of every field type against Gravity Forms 2.10.3 + add-on source — each finding refuted, then re-confirmed by a live entry round-trip — corrected the entry-storage shapes and the `gf_list_field_types` `entry_input` hints so a small model writes the right entry shape. Adds the `password` field type (registry now 46), plus dev-only benchmark suites.

### Added
- **`password` field type** in the registry (now **46** field types, up from 45). GF registers it as its own type (`GF_Field_Password`), not a text variant; it is single-id with no sub-inputs and GF never persists it (the stored entry value is always `""`).
- **Expanded `entry_input` hints in `gf_list_field_types` summary mode** for every field type whose entry format isn't an obvious plain string — choice fields (value-vs-label rule), compound (dot-notation), time, date, fileupload, signature, pricing (`product`/`option`/`quantity`/`shipping`/`total`, `"Label|amount"` encoding), survey/quiz/poll add-on choice tokens, and repeater/nested-form shapes. Plain string fields stay omitted.
- **Nested Form (`form`) field config in the registry + `gf_list_field_types --detail`**: documents the GP Nested Forms `gpnfForm` (child form id) and `gpnfFields` ("Summary Fields" — which child fields show in the nested summary), plus a `requiresAddon` flag.
- **Dev-only benchmark suites** (not shipped): `npm run bench` — the AI release gate that drives the full MCP surface through a small model (`claude-haiku-4-5`) and grades real Gravity Forms/GravityView state; `npm run bench:field-output` — deterministic field-output smoke suite; `npm run bench:field-storage` — field-storage validation against real add-ons; `npm run bench:nested-forms` — front-end render test that a parent View shows a nested form's Summary Fields (directory shows child ids; single entry renders the child table).

### Changed
- **`gf_delete_form` / `gf_delete_entry` descriptions** now state the safe Trash default explicitly and instruct the model to proceed with Trash unless the user asks to permanently delete — the terse `(vs trash)` phrasing made small models pause and ask on every delete.
- **Server `instructions`** now point the search-bar flow at the one-call `gv_search_bar_add` route, reserving the low-level `gv_search_field_*` tools for surgical slot edits. Prose only — no behavior change.
- **One-shot clients can wait for the full tool catalog.** `tools/list` waits a default 2s for the abilities catalog; clients that read it once (e.g. `claude -p`) and never see `tools/list_changed` can raise the first-list wait via `GRAVITYKIT_MCP_LIST_TIMEOUT_MS` to receive `gv_*` in the initial list.

### Fixed
- **Corrected entry-storage shapes to match real Gravity Forms** (`gf_list_field_types --detail`): `number`/`quantity` store as a TEXT string, not numeric; `signature` stores the saved image filename, not base64; `creditcard` persists only `.1` (masked number) and `.4` (card type) — expiration, security code, and cardholder name are never stored, and `generateSubInputs` now labels `.4` Card Type / `.5` Cardholder Name (were swapped); `post_content` is the real GF type (was the non-existent `post_body`, which `gf_add_field` could never resolve); `post_image` stores one `url|:|title|:|caption|:|description|:|alt` composite, not a bare URL; `fileupload` stores a JSON array when `storageType` is `json` OR `multipleFiles` (was `multipleFiles` alone); `product` `price` (User Defined) is a single money string, not dot-notation; `form` (Nested Forms) stores a comma-separated string of child entry ids, not a JSON array.
- **`chainedselect` sub-inputs were never generated.** A chained-select field is compound but `generateSubInputs` had no branch for it, so it got an empty `inputs` array. It now emits one sub-input per dropdown level (ids `1,2,…,9,11,12,…`, skipping multiples of 10 which GF reserves), defaulting to two levels when none are configured. Confirmed against the live Chained Selects add-on.
- **Corrected `entry_input` hints** for `address` (was hardcoded to field id 2 and omitted Line 2 / Country; now lists all six sub-inputs `N.1`–`N.6`), `chainedselect` (notes the dynamic per-level sub-input count), `survey_rank` (all choice values in ranked order, comma-separated), `date` (always ISO/zero-padded, independent of display format), and the survey/quiz/poll tokens (`g<kind><fieldId><hex>` form; multi-row likert keyed by sub-input id).
- **Logger could corrupt the JSON-RPC transport.** The non-test detection was inverted (`!NODE_ENV || NODE_ENV === 'production'`), routing the common `NODE_ENV=development` to stdout and breaking the MCP handshake. Mode is now resolved per call: all server-mode logs go to stderr; only an explicit test context (`NODE_ENV=test` or the `GRAVITYKIT_MCP_TEST_MODE` flags) may use stdout.
- **Ability `/run` calls now always send an object `input`.** Foundation abilities declare an object `input_schema` and the WP Abilities API rejects a missing/null `input` with a 400. Empty input now sends `input=''` on GET/DELETE (WP's empty-object wire form) and `{ input: {} }` on POST.
- **`sorting.is_numeric` is interpreted strictly.** A client sending the value as a JSON string (`"false"`/`"0"`) slipped through a naive truthy check and wrongly forced numeric ordering. `is_numeric` is now carried only when it genuinely means true (`true`, `1`, `"true"`, `"1"`) and omitted otherwise so GF falls back to lexical ordering.
- **Stdio server now exits on client disconnect (stdin EOF).** Without it, every crashed or `SIGKILL`'d client left an orphaned `node src/index.js` running forever; orphans accumulated and starved the next server's startup, surfacing as agents booting with 0 MCP tools.

## [2.3.0] - 2026-06-16

A second correctness pass on the `gf_*` plane — three tools that failed on valid input — plus clearer server instructions. Verified against live Gravity Forms.

### Fixed
- **`gf_add_field` and `gf_update_field` crashed on every call** with `getWarnings is not a function`. `FieldManager` called a validator method that did not exist, so both tools threw before reaching the API. `FieldAwareValidator.getWarnings()` now exists (returns warnings for a missing label or a choice field with no choices; never throws) and both tools work.
- **`gf_validate_form` created a real entry instead of validating.** Like the 2.2.0 `gf_validate_submission` fix, it POSTed to `/submissions`; it now uses the dedicated `/forms/{id}/submissions/validation` route and returns `{valid, validation_messages, page_number}` **without persisting an entry**.
- **`field_values` was typed as an object** on `gf_submit_form_data` and `gf_validate_form` — the inverse of Gravity Forms, which declares it as a string/array of dynamic-population data and rejects an object with a 400. It now accepts a query string or array; objects are rejected client-side with a message pointing to the `input_N` keys for submitted values.
- **`sorting.is_numeric: false` forced numeric ordering.** GF never casts the flag, so the string `"false"` read as truthy. `is_numeric` is now sent only when truthy and omitted otherwise.

### Changed
- Server `instructions` rewritten from a second-person playbook into declarative two-plane prose. The imperative phrasing was echoed back by some non-Claude-Code clients as injected commands; the tools are self-describing, so the instructions now just state the `gf_*` / `gv_*` planes and point at the `gv_*_list` discovery tools and `gk_reload_abilities`.

## [2.2.0] - 2026-06-16

A correctness pass on the Gravity Forms (`gf_*`) plane, verified against Gravity Forms 2.10.3 source and a live GF site (self-seeding `npm run test:live` harness).

### Fixed
- **`gf_list_entries` pagination, sorting, and exclude were silently ignored.** `paging`/`sorting` were JSON-encoded, but GF reads them as bracketed array query params, so it fell back to the first 10 entries (page 1) and `id`/`DESC`. They are now serialized to GF's actual wire contract — pagination, sorting, and multi-form (`form_ids`) queries work. (#4)
- **`gf_validate_submission` performed a real submission and threw on invalid input.** It POSTed to `/submissions` with an ignored `validation_only` flag and the HTTP client threw on GF's normal `400 {is_valid:false}` response. It now uses the dedicated `/forms/{id}/submissions/validation` route and returns `{valid, validation_messages, page_number}` **without creating an entry**.
- **`gf_submit_form_data`** returns `{success:false, validation_messages}` on a rejected submission instead of discarding the messages.
- **`gf_send_notifications` never sent.** It posted a `notification_ids` body array, but GF reads `_notifications` (comma-separated) and `_event` as query params and returns a bare array. Request/response shapes corrected; null/empty IDs are rejected rather than silently triggering "send all".
- **`gf_list_forms` `total_count` was always 0** (it read an `X-WP-Total` header GF doesn't send for `/forms`); it now reflects the number of forms returned.
- **`search.mode` (any/all) was ignored** — it was placed at the search-object top level, but GF reads it inside `field_filters`; OR/AND now apply.
- **`field_filters` `IN`/`NOT IN`/`NOTIN` with array values were flattened to a scalar** (broke membership matching; `NOTIN` caused a PHP fatal 500). Array values are preserved.
- **ID validation silently coerced bad input** — hex strings (`"0x10"`→16), booleans (`true`→1), scientific notation, and integers beyond `MAX_SAFE_INTEGER` produced wrong-but-valid IDs. These are now rejected.
- **`gf_list_entries` response normalization** always returns an entries array and a numeric `total_count` (no more `null`/empty-string/fabricated entries on unexpected bodies).
- Field-filter operator validation is case-insensitive (matches GF); `value: null` is rejected instead of matching the literal text `"null"`; `entry_id: 0` reports "must be a positive integer".

### Added
- **`gf_list_entries`** now supports and advertises GF's native `include` (fetch-by-ID, returns entries of **any** status), `paging.offset`, `sorting.is_numeric`, and querying multiple forms at once.
- Self-seeding live end-to-end test harness (`npm run test:live`) that provisions its own throwaway forms/entries against a real Gravity Forms site and tears them down.
- Adversarial `*-hardening` test suites (client, validation, sanitize, schema) covering hostile and edge-case input.

### Changed
- `include` uses GF's native fast-path (any status); `exclude` maps to an `id NOT IN` search filter. `gf_list_forms` no longer accepts the `status`/`active`/`exclude` params that GF's `/forms` endpoint ignores.

### Security
- `sanitize()` now masks common secret field names (`secret`, `client_secret`, `private_key`, `*_secret_key`, `password`); `sanitizeUrl()` masks `oauth_signature` and HTTP Basic `user:pass@` credentials in logged URLs.

## [2.1.0] - 2026-03-31

### Fixed
- Checkbox field values created via MCP now use proper Gravity Forms dot-notation sub-inputs instead of JSON array strings. Values are matched against choices by value then text, with HTML entity decoding for ampersands. Closes #1
- Multiselect arrays normalized to comma-separated strings (REST API v2 format)
- Radio/select arrays take first element; list/chainedselect arrays pass through unchanged
- Hidden inputs (e.g., Select All) skipped during checkbox expansion
- Update entry correctly clears stale checkbox sub-inputs via fetch-then-merge
- Field registry: corrected storage definitions for checkbox (compound/dotNotation, not array/json), multiselect (commaSeparated, not json), consent (3 sub-inputs, not 2), chainedselect (compound, not single)
- Field registry: added variant-specific storage for product, option, post_category, post_custom_field, quiz, poll
- Field registry: added base `survey` type with all 8 inputType variants; moved hasChoices to variant level so text/textarea variants don't require choices
- Field validation: fixed compound/array ordering so checkbox hits array branch (not compound) in getFieldValue, processSubmissionData, extractSubmissionValue
- Validation: removed unused imports, fixed validator name references, added JSON string→array parsing for MCP clients that serialize arrays as strings

### Added
- `_normalizeArrayValues()` in GravityFormsClient: fetches form schema to match array values to correct sub-input IDs for all choice-based field types
- 41 array normalization tests covering checkbox, multiselect, radio, select, option, quiz, poll, survey, post_category, post_custom_field, list, entry_tags, HTML entity decoding, and mixed-form scenarios
- 25 field registry tests verifying storage definitions and variant-specific overrides
- Compound field fallback: logs warning and stores as single value when subInput mapping is missing

## [2.0.0] - 2026-03-31

### Changed
- **Renamed project from GravityMCP to GravityKit MCP**
- npm package: `@gravitykit/gravitymcp` → `@gravitykit/mcp`
- GitHub repo: `GravityKit/GravityMCP` → `GravityKit/MCP`
- MCP server name: `gravitymcp` → `gravitykit-mcp`
- CLI binary: `gravitymcp` → `gkmcp`
- Environment variable: `GRAVITYKIT_MCP_TEST_MODE` (legacy `GRAVITYMCP_TEST_MODE` still supported)
- User-Agent header updated to `GravityKit MCP/2.0.0`

### Backwards Compatibility
- The old `@gravitykit/gravitymcp` npm package is published as a bridge that depends on `@gravitykit/mcp` with a deprecation notice — existing installs continue working
- GitHub auto-redirects old repo URL (`GravityKit/GravityMCP`) to the new one
- `GRAVITYMCP_TEST_MODE` environment variable still works alongside new `GRAVITYKIT_MCP_TEST_MODE`

## [1.4.1] - 2026-03-20

### Fixed
- Race condition in concurrent fetch-then-merge updates: added per-resource mutex to serialize mutations on the same form/entry/feed
- `FieldManager` double-fetch eliminated: new `replaceForm()` does direct PUT without re-fetching (3 HTTP calls → 2 per field op)
- `console.log` calls in 7 files replaced with `logger.info`/`logger.warn` to prevent JSON-RPC stdout corruption
- `mcp.json` phantom `gf_submit_form` tool removed, 4 field operation tools added, version synced
- `_variant`/`_meta` internal metadata stripped from field objects before sending to API
- Field operation errors now propagate to `wrapHandler` with `isError: true` instead of being silently swallowed
- Name field sub-input IDs corrected (`.2`=prefix, `.3`=first, matching Gravity Forms)
- Feature filter `conditional` now maps to correct registry key `supportsConditionalLogic`
- `gf_delete_feed` description now mentions `ALLOW_DELETE` requirement

### Added
- `ResourceMutex` utility (`utils/mutex.js`) with `acquire`/`release` and `withLock()` for safe concurrent operations
- `replaceForm(formId, formData)` client method for direct PUT without re-fetch
- MCP tool annotations on all 26 tools (`readOnlyHint`, `destructiveHint`, `openWorldHint`)
- Server-level `instructions` string documenting compact mode (sent once at session start)
- 31 new tests: 22 bug regression tests + 9 mutex concurrency tests

### Changed
- Tool descriptions stripped of repeated compact boilerplate (~130 tokens saved per `tools/list` call)
- `compact` property description shortened to "Return raw uncompacted data"

### Removed
- Redundant `gf_list_form_feeds` tool (`gf_list_feeds` with `form_id` does the same thing plus addon filtering)
- Deprecated `crypto` and unused `form-data` npm dependencies
- False `batch_operations: true` claim from `mcp.json`

## [1.4.0] - 2026-03-20

### Added
- Test mode environment resolution: when `GRAVITYMCP_TEST_MODE=true`, the client automatically uses `GRAVITY_FORMS_TEST_*` env vars (base URL, consumer key/secret) instead of live credentials
- `testConfig.resolveEnv()` method in `config/test-config.js` as the canonical place for environment resolution
- Init log now shows `(TEST MODE)` indicator when connecting to test site
- Support for `GRAVITY_FORMS_TEST_BASE_URL` env var (in addition to existing `GRAVITY_FORMS_TEST_URL`)

### Fixed
- Removed 4 unused variable warnings (`response` in delete methods, `safeHeaders` in request interceptor)

## [1.3.0] - 2026-03-10

### Added
- Compact mode: `stripEmpty()` recursively removes `null` and `""` values from all responses to reduce token usage
- Entry meta stripping: plugin-added meta keys (e.g., `gv_revision_*`, `helpscout_conversation_id`) are stripped by default via `stripEntryMeta()`
- Pass `compact=false` for full raw data

### Fixed
- Updated axios and MCP SDK to patch security vulnerabilities

## [1.1.0] - 2026-03-10

### Changed
- Reduced token usage across all tool responses: no pretty-print, no redundant `message` strings, no echo-back of input IDs
- Updated AGENTS.md and CLAUDE.md for token optimization documentation

### Fixed
- Granted `contents:write` permission in publish CI workflow

## [1.0.5] - 2026-02-18

### Fixed
- Fixed OAuth signature generation in `validateRestApiAccess` to pass full URL, method, and params to `getAuthHeaders()`
- Fixed confirmations and notifications validation to accept objects keyed by ID instead of arrays, matching Gravity Forms' actual data format
- Added defensive optional chaining for `httpClient.defaults.baseURL`

### Changed
- Updated test helpers: added `defaults.baseURL` to MockHttpClient
- Updated test data and validation tests to use object format for confirmations and notifications

## [1.0.4] - 2025-01-13

### Added
- Comprehensive data sanitization for secure logging
- GitHub Actions workflows for automated testing and publishing
- Self-signed SSL certificate support for local development
- Auto-generate inputs array for compound fields in `gf_create_form`
- Load `.env` from working directory with project fallback

### Fixed
- Updated CodeQL Action to v3

### Changed
- Removed local Claude settings from version control

## [1.0.3] - 2024-12-09

### Changed
- Renamed package from `gravity-mcp` to `GravityMCP` for consistency
- Updated all documentation references to use new naming
- Improved Claude Desktop configuration example

### Removed
- Removed obsolete rename script

### Added
- GitHub Actions workflow for automated npm publishing
- GitHub Actions workflow for continuous testing

## [1.0.2] - 2024-12-09

### Fixed
- Fixed logging for MCP and test modes

## [1.0.1] - 2024-12-09

### Added
- Initial release of GravityMCP
- Full Gravity Forms REST API v2 coverage
- 28 MCP tools for complete forms management
- OAuth 1.0a and Basic authentication support
- Advanced search and filtering capabilities
- File upload support
- Comprehensive test suite
- Dual environment configuration (test/production)

### Features
- Forms management (6 tools)
- Entries management (6 tools)  
- Field operations (4 tools)
- Form submissions (2 tools)
- Add-on feeds (7 tools)
- Notifications (1 tool)
- Field filters (1 tool)
- Results/Analytics (1 tool)

[2.4.0]: https://github.com/GravityKit/MCP/releases/tag/v2.4.0
[2.3.0]: https://github.com/GravityKit/MCP/releases/tag/v2.3.0
[2.2.0]: https://github.com/GravityKit/MCP/releases/tag/v2.2.0
[2.1.0]: https://github.com/GravityKit/MCP/releases/tag/v2.1.0
[2.0.0]: https://github.com/GravityKit/MCP/releases/tag/v2.0.0
[1.4.1]: https://github.com/GravityKit/MCP/releases/tag/v1.4.1
[1.4.0]: https://github.com/GravityKit/MCP/releases/tag/v1.4.0
[1.3.0]: https://github.com/GravityKit/MCP/releases/tag/v1.3.0
[1.1.0]: https://github.com/GravityKit/MCP/releases/tag/v1.1.0
[1.0.5]: https://github.com/GravityKit/MCP/releases/tag/v1.0.5
[1.0.4]: https://github.com/GravityKit/MCP/releases/tag/v1.0.4
[1.0.3]: https://github.com/GravityKit/MCP/releases/tag/v1.0.3
[1.0.2]: https://github.com/GravityKit/MCP/releases/tag/v1.0.2
[1.0.1]: https://github.com/GravityKit/MCP/releases/tag/v1.0.1