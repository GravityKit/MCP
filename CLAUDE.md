You MUST fully ingest @AGENTS.md first.

# Gravity MCP Server

## Project Identity

- **Package:** `@gravitykit/gravitymcp` v1.4.0
- **Type:** Node.js MCP server (ESM)
- **Purpose:** Full Gravity Forms REST API v2 coverage via 28 MCP tools
- **Repo:** https://github.com/GravityKit/GravityMCP

## Key Commands

```bash
npm run dev          # Dev with auto-reload
npm run inspect      # MCP Inspector debugging
npm run check-env    # Validate environment
npm run test:all     # Run all test suites
npm test             # Integration tests (live API)
```

## Environment

Required env vars (see `.env.example` for full list):
- `GRAVITY_FORMS_CONSUMER_KEY` — from WP Admin > Forms > Settings > REST API
- `GRAVITY_FORMS_CONSUMER_SECRET`
- `GRAVITY_FORMS_BASE_URL` — WordPress site URL, no trailing slash

## Critical Rules

1. **Never use `console.log` in MCP mode** — stdout is JSON-RPC. Use `logger.info/error/warn` from `utils/logger.js`
2. **Always use `.js` extension** in imports (ESM requirement)
3. **Delete operations require `GRAVITY_FORMS_ALLOW_DELETE=true`** env var
4. **Fields are form properties** — no direct field endpoints; modify via form PUT
5. **Update operations fetch-then-merge** — always GET existing data first to avoid data loss
6. **Minimize response tokens** — no pretty-print (`JSON.stringify(result)` not `null, 2`), no redundant `message` strings, no echo-back of input IDs, no `created`/`updated` booleans. Return only essential data.
7. **Keep tool descriptions terse** — every token in tool schemas is sent on every `tools/list` call
8. **Compact mode strips null, empty strings, and entry meta** — `stripEmpty()` in `utils/compact.js` runs on all responses. Entry tools also strip plugin-added meta keys via `stripEntryMeta()`, keeping only core properties and field values. `false` is preserved. Pass `compact=false` for full raw data.
9. **Test mode uses dev site** — when `GRAVITYMCP_TEST_MODE=true`, the client auto-resolves `GRAVITY_FORMS_TEST_*` env vars to connect to the test site instead of production. Resolution logic lives in `testConfig.resolveEnv()` in `config/test-config.js`.

## Release Checklist

When tagging a new version, you MUST complete ALL of these steps:

1. Update `CHANGELOG.md` with all changes since the last release (follow Keep a Changelog format)
2. Bump `version` in `package.json`
3. Update the version in this file (`CLAUDE.md` → Project Identity → Package)
4. Commit with message `chore(release): bump version to X.Y.Z`
5. Tag: `git tag vX.Y.Z`
6. Push: `git push origin main --tags`
