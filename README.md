# GravityKit MCP

A Model Context Protocol (MCP) server for Gravity Forms. Interact with your WordPress forms, feeds, and entries through any MCP-compatible client.

[![npm version](https://img.shields.io/npm/v/@gravitykit/mcp.svg)](https://www.npmjs.com/package/@gravitykit/mcp)

Built by [GravityKit](https://www.gravitykit.com) for the Gravity Forms community.

## Features

- **Full Gravity Forms Coverage**: 26 tools across forms, entries, feeds, notifications, submissions, and field management
- **Smart Field Management**: Intelligent field operations with dependency tracking
- **Advanced Search**: Complex filtering and searching capabilities for entries
- **Form Submissions**: Full submission workflow with validation
- **Add-on Integration**: Manage feeds for MailChimp, Stripe, PayPal, and more
- **GravityKit Products**: dynamic tools auto-generated from the site's Foundation abilities catalog — each add-on under its own prefix (GravityView's View authoring is first, using `gv_*`)
- **Type-Safe**: Comprehensive validation for all operations
- **Battle-Tested**: Extensive offline + adversarial hardening suites, plus a self-seeding live harness that runs end-to-end against a real Gravity Forms site

## Quick Start

### Prerequisites
- Node.js 18+
- WordPress with Gravity Forms 2.5+
- WordPress site over HTTPS (recommended) — local `http://` dev sites (localhost, `*.test`, `*.local`) work too

### Installation

No clone or `npm install` needed — `npx` runs the published package on demand. (To run from a local checkout for development, see [Contributing](#contributing).)

1. **Enable the Gravity Forms REST API** (one-time, required for any credential type):
   - Go to **Forms → Settings → REST API** and check **Enable access to the API** — Gravity Forms doesn't register its REST routes without it.

2. **Create credentials** in WordPress (pick one):

   **Application password (recommended):**
   - Go to **Users → Profile → Application Passwords**
   - Name it (e.g. `GravityKit MCP`) and click **Add New Application Password**
   - Copy the generated password. Your username + this password are your credentials, and access follows your WordPress capabilities. On sites running GravityKit Foundation, the same credential also powers the GravityKit product tools.

   **Gravity Forms API key (for scoped access, e.g. a read-only key):**
   - On the same **Forms → Settings → REST API** screen, click **Add Key**
   - Choose the user and permission level, then save the Consumer Key (`ck_…`) and Secret (`cs_…`)

3. **Add to your MCP client.** For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "gravitykit-mcp": {
         "command": "npx",
         "args": ["-y", "@gravitykit/mcp"],
         "env": {
           "GRAVITY_FORMS_BASE_URL": "https://yoursite.com",
           "GRAVITY_FORMS_CONSUMER_KEY": "your_wp_username",
           "GRAVITY_FORMS_CONSUMER_SECRET": "xxxx xxxx xxxx xxxx xxxx xxxx"
         }
       }
     }
   }
   ```
   Then restart Claude Desktop — `npx` fetches and runs `@gravitykit/mcp` on demand. Notes:
   - Prefer a Gravity Forms key pair? Use `"GRAVITY_FORMS_CONSUMER_KEY": "ck_…"` and `"GRAVITY_FORMS_CONSUMER_SECRET": "cs_…"`.
   - Local dev with self-signed certs: add `"GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS": "true"` to the `env` block.
   - Pin a version with `@gravitykit/mcp@x.y.z` if you don't want `npx` tracking latest.

## Available Tools

Two planes: **Gravity Forms** (`gf_*`) — 26 static tools, listed whenever Gravity Forms credentials are valid — and **GravityKit** — dynamic tools generated from the Foundation catalog when it's active, where each add-on registers tools under its own prefix (GravityView uses `gv_*`). The `gk_reload_abilities` tool reloads the GravityKit catalog. The two planes are independent: a Gravity-Forms-only site lists just `gf_*`; a GravityKit site without Gravity Forms REST keys still lists its product tools.

### Forms (6 tools)
- `gf_list_forms`    - List forms (optionally filter to specific IDs via `include`)
- `gf_get_form`      - Get complete form configuration
- `gf_create_form`   - Create new forms with fields
- `gf_update_form`   - Update existing forms
- `gf_delete_form`   - Delete forms (requires ALLOW_DELETE=true)
- `gf_validate_form` - Validate form data

### Entries (5 tools)
- `gf_list_entries` - List/search entries: pagination (`page_size`/`current_page`/`offset`), sorting (`key`/`direction`/`is_numeric`), field-filter search (`mode` any/all, operators incl. `IN`/`NOT IN`), `include` (fetch by ID, any status), `exclude`, `status`, and multiple forms at once
- `gf_get_entry`    - Get specific entry details
- `gf_create_entry` - Create new entries
- `gf_update_entry` - Update existing entries
- `gf_delete_entry` - Delete entries (requires ALLOW_DELETE=true)

### Field Operations (4 tools)
- `gf_add_field`        - Add fields with intelligent positioning
- `gf_update_field`     - Update fields with dependency checking
- `gf_delete_field`     - Delete fields with cascade options
- `gf_list_field_types` - List available field types

### Submissions (2 tools)
- `gf_submit_form_data`    - Submit forms with full processing
- `gf_validate_submission` - Validate a submission without creating an entry (returns `validation_messages`)

### Add-ons (6 tools)
- `gf_list_feeds`       - List all add-on feeds
- `gf_get_feed`         - Get specific feed configuration
- `gf_create_feed`      - Create new add-on feeds
- `gf_update_feed`      - Update existing feeds
- `gf_patch_feed`       - Partially update feed properties
- `gf_delete_feed`      - Delete add-on feeds

### Notifications (1 tool)
- `gf_send_notifications` - Send an entry's notifications — specific IDs, or all for an event

### Utilities (2 tools)
- `gf_get_field_filters` - List the available field filters for a form
- `gf_get_results`       - Get aggregated results for Quiz/Poll/Survey forms

### GravityKit Products (dynamic)

When [GravityKit Foundation](https://www.gravitykit.com) is active on the connected site, additional tools are generated at runtime from its Abilities catalog — each GravityKit add-on under its own server-assigned prefix, so the exact set depends on the installed products and versions. **GravityView** is supported today, using the `gv_*` prefix: View lifecycle (`gv_view_create`, `gv_view_config_apply`, `gv_view_delete`), field/widget/search/grid editing, and discovery (`gv_layouts_list`, `gv_field_type_schema_get`, …). Use the `gv_*_list` discovery tools to see what's available on your site, and `gk_reload_abilities` to reload the catalog after activating or updating GravityKit products.

## Usage Examples

### Search & paginate entries
```javascript
// Search + sort + paginate, across one or more forms at once
await mcp.call('gf_list_entries', {
  form_ids: [1, 2],
  search: {
    field_filters: [
      { key: "1.3", value: "John", operator: "contains" },
      { key: "id", value: [101, 102, 103], operator: "IN" }   // multi-value membership
    ],
    mode: "any"                                                // any = OR, all = AND
  },
  sorting: { key: "date_created", direction: "desc", is_numeric: false },
  paging: { page_size: 25, current_page: 2 }                   // or { offset: 25, page_size: 25 }
});

// Fetch specific entries by ID (returns any status, including trashed)
await mcp.call('gf_list_entries', { include: [101, 102] });
```

### Add Fields
```javascript
await mcp.call('gf_add_field', {
  form_id: 1,
  field_type: 'email',
  properties: {
    label: 'Email Address',
    isRequired: true
  }
});
```

### Submit Forms
```javascript
await mcp.call('gf_submit_form_data', {
  form_id: 1,
  input_1: "John Doe",
  input_2: "john@example.com",
  input_3: "Message content"
});
```

## Configuration

Set these as environment variables — in your MCP client's `env` block (the `npx` setup above) or in a `.env` file when running from a local clone.

### Required Environment Variables
- `GRAVITY_FORMS_CONSUMER_KEY`    - WordPress username (app-password setup) or GF consumer key (`ck_…`)
- `GRAVITY_FORMS_CONSUMER_SECRET` - Application password or GF consumer secret (`cs_…`)
- `GRAVITY_FORMS_BASE_URL`        - WordPress site URL

### Optional Settings
- `GRAVITY_FORMS_AUTH_METHOD`          - Override auto-selection: `basic` or `oauth`/`oauth1` (normally leave unset)
- `GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=false` - Allow Basic auth to a REMOTE plain-HTTP host (credentials visible to the network)
- `GRAVITY_FORMS_ALLOW_DELETE=false`   - Enable delete operations
- `GRAVITY_FORMS_TIMEOUT=30000`        - Request timeout (ms)
- `GRAVITY_FORMS_MAX_RETRIES=3`        - Max retry attempts for failed requests
- `GRAVITY_FORMS_DEBUG=false`          - Enable debug logging
- `GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=false`  - Allow self-signed SSL certificates (local dev only)

### GravityKit Product Tools

The GravityKit product tools reach the same site over the WordPress REST Abilities API, so on a single install **no extra configuration is needed** — they reuse your `GRAVITY_FORMS_*` credentials (a WordPress username + application password). Override only if the WordPress root differs from the Gravity Forms URL, or to use a separate credential:

- `GRAVITYKIT_WP_URL`          - WordPress site URL (defaults to `GRAVITY_FORMS_BASE_URL`)
- `GRAVITYKIT_WP_USERNAME`     - WordPress username (defaults to `GRAVITY_FORMS_CONSUMER_KEY`)
- `GRAVITYKIT_WP_APP_PASSWORD` - Application password (defaults to `GRAVITY_FORMS_CONSUMER_SECRET`)

These tools appear only when GravityKit Foundation is active on the connected site. They authenticate with a WordPress application password over Basic auth, so — like the Gravity Forms plane — they refuse a remote plain-HTTP URL unless `GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=true` (HTTPS and local URLs are always fine).

### Authentication Flow

The client picks the right transport from the shape of your credentials — you normally don't configure anything:

- **Application password** (username + app password) → **Basic Authentication** over HTTPS or any local URL (localhost, `*.test`, `*.local`). WordPress core authenticates the user; Gravity Forms enforces their capabilities.
- **Gravity Forms key pair** (`ck_…`/`cs_…`) over HTTPS → **Basic Authentication**.
- **Gravity Forms key pair** over plain HTTP → **OAuth 1.0a**, automatically — Gravity Forms only accepts key-pair Basic auth over HTTPS, so OAuth is the only transport that works there.
- **Remote plain-HTTP host** → OAuth for key pairs; Basic requires the explicit `GRAVITY_FORMS_ALLOW_HTTP_BASIC_AUTH=true` opt-in and logs a warning.

Set `GRAVITY_FORMS_AUTH_METHOD` only to override the auto-selection. Whatever the transport, access is limited to the WordPress user's capabilities (or the API key's permission level).

## Test Environment Configuration

The server supports **dual environment configuration** to safely test without affecting production data.

### Setting Up Test Environment

Add test site credentials to your `.env` file alongside production credentials:

```env
# Production/Live Site
GRAVITY_FORMS_CONSUMER_KEY=ck_live_key
GRAVITY_FORMS_CONSUMER_SECRET=cs_live_secret
GRAVITY_FORMS_BASE_URL=https://www.yoursite.com

# Test/Staging Site (recommended for safe testing)
GRAVITY_FORMS_TEST_CONSUMER_KEY=ck_test_key
GRAVITY_FORMS_TEST_CONSUMER_SECRET=cs_test_secret
GRAVITY_FORMS_TEST_BASE_URL=https://staging.yoursite.com

# Enable test mode (optional)
GRAVITYKIT_MCP_TEST_MODE=true
```

### Test Environment Features

When using test configuration:
- **Automatic test form prefixing** - All test forms created with "TEST_" prefix
- **Auto-cleanup** - Test forms automatically removed after testing
- **Environment isolation** - Complete separation from production data
- **Safe experimentation** - Test destructive operations without risk

### Using Test Mode

```bash
# Verify test environment configuration
GRAVITYKIT_MCP_TEST_MODE=true npm run check-env

# Create test data on test site (requires test credentials)
npm run setup-test-data

# Run all tests against test site (auto-detects test credentials)
npm test

# Interactive testing with MCP Inspector (test mode)
GRAVITYKIT_MCP_TEST_MODE=true npm run inspect

# Run specific test suites against test site
NODE_ENV=test npm run test:forms
NODE_ENV=test npm run test:entries
NODE_ENV=test npm run test:submissions
```

### Test Mode Detection

The server automatically uses test configuration when:
1. `GRAVITYKIT_MCP_TEST_MODE=true` is set (or legacy `GRAVITYMCP_TEST_MODE=true`)
2. OR `NODE_ENV=test` is set
3. OR test credentials are configured and test commands are run

### Test Safety Features

The server includes multiple safety mechanisms to prevent accidental production data contamination:

1. **Test Credential Requirements** - The `setup-test-data` script will **fail by default** if test credentials aren't configured
2. **No Silent Fallbacks** - Scripts that create or modify data won't silently fall back to production
3. **Explicit Production Override** - Production usage requires scary `--force-production` flag with warnings
4. **Clear Error Messages** - Helpful guidance on configuring test credentials when missing
5. **Test Data Prefixing** - All test forms automatically prefixed with "TEST_" for easy identification

### Best Practices

1. **Always configure a test environment** - Use a staging/test WordPress site
2. **Never test on production first** - Validate on test site before production
3. **Keep test credentials separate** - Different API keys for test vs live
4. **Use prefixes for test data** - Makes cleanup easy and identification clear
5. **Enable debug mode for testing** - `GRAVITY_FORMS_DEBUG=true` for detailed logs
6. **Review safety warnings** - Take warnings seriously when they appear

## Testing

```bash
# Run everything (offline suites + live integration)
npm run test:all

# Offline suites
npm run test:unit         # custom-runner unit tests
npm run test:node         # node:test units (field ops, helpers, query/wire builders, *-hardening adversarial suites, …)
npm run test:views        # GravityView inspector / validator
npm run test:forms        # per-endpoint suites: also test:entries, test:feeds, test:submissions, …

# Live, end-to-end against a real Gravity Forms site (self-seeds its own throwaway
# forms/entries, then cleans up). Set credentials and run:
LIVE_GF_URL=https://example.com LIVE_GF_USER=admin LIVE_GF_PW='xxxx xxxx ...' npm run test:live

# Legacy live integration suite
npm test
```

## Security

- **HTTPS Required**: All API communication encrypted
- **Delete Protection**: Destructive operations disabled by default
- **Input Validation**: All inputs validated before API calls
- **Rate Limiting**: Automatic retry with exponential backoff

## Troubleshooting

### Connection Issues
- Verify credentials with `npm run check-env`
- Ensure WordPress site is HTTPS-enabled
- Check REST API is enabled in Gravity Forms settings

### Local Development with Self-Signed Certificates

If you're using a local development environment (Laravel Valet, MAMP, Local WP, etc.) with self-signed SSL certificates, you may encounter authentication errors. To fix this, set:

```
GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=true
```

in your MCP client's `env` block (`"GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS": "true"`), or in `.env` when running from a local clone.

**⚠️ Security Warning**: Only disable SSL certificate verification for local development environments. Never use this setting in production!

### Authentication Errors
- Confirm API keys are correct
- Verify user has appropriate Gravity Forms capabilities
- Check Forms → Settings → REST API for key status
- For local development, ensure `GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS=true` is set if using self-signed certificates

### Debug Mode
Enable detailed logging:
```env
GRAVITY_FORMS_DEBUG=true
```

## Support

- [GitHub Issues](https://github.com/GravityKit/MCP/issues)
- [Gravity Forms Documentation](https://docs.gravityforms.com/rest-api-v2/)
- [MCP Documentation](https://modelcontextprotocol.io/)

## License

GPL-2.0 License - see [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions from the Gravity Forms community! Whether you're building add-ons, managing forms, or integrating with other services, your insights and code contributions can help everyone.

### How to Contribute

1. **Fork the repository** - Start by creating your own copy
2. **Create a feature branch** - Keep your changes organized
3. **Add tests** - Ensure reliability with test coverage
4. **Run the test suite** - Verify everything works with `npm run test:all`
5. **Submit a pull request** - Share your improvements with the community

### Automated Publishing

This repository uses GitHub Actions to automatically publish to npm when a new version is tagged:

1. Update the version in `package.json`
2. Commit your changes
3. Create and push a tag: `git tag v1.0.5 && git push origin v1.0.5`
4. GitHub Actions will automatically publish to npm

**Note for maintainers**: Ensure the `NPM_TOKEN` secret is configured in the repository settings for automated publishing to work.

### Contribution Ideas

**For Add-on Developers:**
- Add support for your add-on's feed types
- Enhance field type definitions for custom fields
- Share integration patterns that work well

**For Form Builders:**
- Improve field validation logic
- Add helper utilities for common tasks
- Enhance error messages and debugging

**For Everyone:**
- Report bugs or suggest features via [GitHub Issues](https://github.com/GravityKit/MCP/issues)
- Improve documentation and examples
- Share your use cases and workflows

Your contributions help make Gravity Forms automation better for everyone. Let's build something great together!
