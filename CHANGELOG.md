# Changelog

All notable changes to GravityKit MCP (formerly GravityMCP) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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