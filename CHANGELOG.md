# Changelog

All notable changes to GravityKit MCP (formerly GravityMCP) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] - 2026-09-30

This release stops `gf_submit_form_data` silently discarding submitted values, keeps the GravityKit product tools on the same site as the Gravity Forms tools, and updates two dependencies past known advisories.

### 🔒 Security

- **The GravityKit product tools now act on the same site as the Gravity Forms tools.** The two planes each resolve their own address and credentials, and the product plane ranked `WORDPRESS_LOCAL_DEV_TEST_URL` and `WORDPRESS_LOCAL_DEV_TEST_ADMIN_*` above the Gravity Forms values. Those variables are ambient in any shell that has a local WordPress configured, so a server given only `GRAVITY_FORMS_*` sent every `gv_*` read and write, and the credentials carrying them, to whichever site those variables named, while the `gf_*` tools worked against the intended one. No response said so, and `gv_view_delete` is on that plane. Both planes now resolve to the Gravity Forms site unless `GRAVITYKIT_WP_URL` says otherwise, and a caller who does point them at different hosts is told which is which, at startup and in `gk_reload_abilities`.
- **Updated `axios` to 1.20.0 and `fast-uri` to 4.2.1.** Both are on paths the server uses on every request and every tool call, and both sat on versions with published advisories. `ip-address` is updated to 10.7.2 for the same reason.

### 🐛 Fixed

- **`gf_delete_field` with `cascade: true` now deletes the field.** It was refused with "Field has dependencies that would break" and a suggestion to use `cascade=true`, the flag already passed. Cascade only worked when `force` was also set. A call that passes `cascade` alone used to refuse and now deletes the field and removes the rules that referenced it from other fields' conditional logic. A field left with no rules loses its conditional logic entirely, which is the state Gravity Forms treats as "no logic" (an empty rules list behind `enabled: false` would hide a "hide if" field permanently on submission). Calculation formulas and merge tags are not rewritten, because removing a token changes what a formula computes.
- **`gf_delete_field` now says what it cleaned and what it left broken.** `actions_taken` read "Dependencies cleaned up" on every cascade delete, including ones that cleaned nothing, such as a field used only in a calculation or a confirmation merge tag. It now lists each field it changed. A new `left_dangling` list, with a `warning`, names every calculation, merge tag (and, without `cascade`, conditional logic rule) that still references the deleted field, so you can fix them.
- **`gf_submit_form_data` no longer discards values it was given.** Three kinds of value were lost with no error, and each now arrives intact:
  - a multiselect or list array was joined into one comma-separated string, which lost any value containing a comma, such as "Atlanta, GA";
  - a `formatted` phone value arrived as the text `"[object Object]"`, and is now sent as the JSON string Gravity Forms reads;
  - `null` arrived as the text `"null"`, and now arrives empty.
- **New multiselect fields are now created with JSON storage.** Without it Gravity Forms joins the selected values with commas and reads them back by splitting on every comma, so "Atlanta, GA" returns as two values. `gf_create_form`, `gf_update_form` and `gf_add_field` now match the form editor, including post fields set to multiselect. Pass `storageType` to choose the legacy format.
- **A submission that cannot store anything is now refused rather than reported as successful.** Three cases: `field_values` in any form, which does nothing on this path (see the `field_values` entry below); a call with no `input_N` value at all; and the same sub-input sent under both `input_5.3` and `input_5_3` with different values, where Gravity Forms kept whichever it saw last.
- **`gk_reload_abilities` now tells a reachable empty catalog apart from a site it could not reach.** A catalog that answered with no GravityKit abilities was reported as unreachable with no source, which sends you off to check a certificate, a credential and a WordPress log that are all working. An empty answer now reports as loaded with zero tools, names the catalog that answered, and says to activate a product and reload. Only a catalog that could not be read at all reports no source.
- **`gf_list_feeds` now honors `form_id` and `include`.** Asking for one form's feeds returned every feed on the site, because Gravity Forms' `/feeds` endpoint accepts `form_id` and then ignores it. The tool now narrows the response to the form you asked for. `include` is the feed id filter Gravity Forms reads, but validation dropped it, so a request naming specific feeds also returned every feed; ids passed to `include` now narrow the response. `addon` is filtered by Gravity Forms itself.
- **Every form tool now accepts the form id as either `id` or `form_id`.** `gf_get_form`, `gf_delete_form`, `gf_update_form`, `gf_submit_form_data` and the submission-validation tools each previously named only one of the two.
- **`gf_add_field` now tells you when it could not place a field where you asked.** A field positioned after or before a field that does not exist was put at the end of the form, and the response said `success` with an empty `warnings` list. An `index` past the end of the form, or one that was not a number, was quietly replaced the same way, and so was a `reference` on a different page from the `page` you named. Each of these now adds a warning naming what was asked for; `position.index` still shows where the field landed.
- **`gf_add_field` now refuses a position it cannot read.** An unknown `mode` (for example `sideways`) used to append the field and report success. It now returns an error naming the five valid modes and leaves the form unchanged, as it does for a page number below 1. Callers who passed a mistyped `mode` and got an append will now see that error.
- **`gf_add_field` now reports the page the field landed on.** `position.page` was always `1`, even for a field added to page 3 of a multi-page form.
- **`gf_list_field_types` no longer answers an empty list to a filter it did not understand.** `category: "Standard"` and `category: "basic"` both returned zero field types, as did any `feature` that was not a recognized name, which reads as "this site has no field types". Category and feature now ignore case, and an unknown value is refused with an error that lists the valid ones. The categories come from the field registry, so they include `choice`, `survey`, `poll` and `quiz` as well as the four the tool description used to name. Only `required` and `conditional` are accepted as features: the other names in the old description (`duplicate`, `prepopulate`, `visibility`) matched no field type and always returned an empty list, so they are now refused too.
- **`gf_list_field_types` with `detail=true` now reports `supports.conditional` correctly.** It read the wrong flag and showed `false` for every field type.
- **`gf_add_field` now points at the right type when the case is wrong.** `field_type: "Text"` creates a field whose type is literally `Text`, which Gravity Forms does not recognize, and the warning said only that the type was unknown. It now adds "Did you mean 'text'?" The type is still stored as you sent it, since a site can register its own types.
- **`gf_list_entries` now scopes to the form you name when you pass `form_id`.** Only the plural `form_ids` was read, so a request naming one form queried the whole site: it could return another form's entries alongside or instead of the ones asked for, and it reported the site-wide entry count. Both spellings now work, and a `form_id` that contradicts `form_ids` is refused.
- **`gf_get_entry`, `gf_update_entry` and `gf_delete_entry` now accept the entry id as either `id` or `entry_id`.** `gf_send_notifications` names it `entry_id`, so the spelling learned there failed on every other entry tool. An `entry_id` that contradicts `id` is refused, and on an update it no longer rides into the entry being saved.
- **`gf_get_results` now reports a missing form as an error.** Gravity Forms answers this endpoint with HTTP 200 even when the form does not exist, leaving the failure in the response body, so the tool reported success and an agent read it as a form with no results. A serialized error in the body now fails the call.
- **`gf_list_feeds` now states that it lists active feeds only.** Gravity Forms filters this endpoint to active feeds and reads no parameter to widen it, so a feed created with `is_active: false` is absent from the list and its absence looked like a create that had failed. Read such a feed by id with `gf_get_feed`, which does return it.
- **`gf_create_entry` no longer reports values it did not store.** Gravity Forms answers a create with the request body plus an id and silently ignores any key that is not a field on the form, so `"9999": "ghost"` on a form with no field 9999 came back as a created entry holding that value. A key that names no field, or no input of a compound field, is now refused before anything is sent, with the bad key and the field ids the form does have. What the call returns is the entry read back from Gravity Forms by id, so it shows what was stored. If the read-back fails, the response still carries the new entry's id with a warning, so a retry does not create a second entry. Costs one extra request on create, and the form is fetched once to check the keys.
- **`gf_create_entry` and `gf_update_entry` now refuse a payload nested under `entry`.** `{ form_id: 161, entry: { "1": "Ada" } }` was accepted and produced an entry with every field empty, and the same shape on an update reported success and wrote nothing. Gravity Forms reads field values only from top-level keys, so an object under a key that is not a field is now refused with the top-level shape to use, and a create with no field value at all is refused the way `gf_submit_form_data` refuses an empty submission.
- **`gf_update_entry` now refuses a key that names no field on the entry's form.** It was accepted and dropped. Sub-inputs take the dotted spelling (`6.3`); `6_3` is read as the same input, and two different values for it are refused, as on `gf_submit_form_data`.
- **`gf_update_feed` no longer deletes the rest of a feed's `meta` without saying so.** A `meta` replaces the stored one whole, so changing one setting on a webhook feed removed its URL, method and format while the feed stayed active and the call reported success. A `meta` that omits stored keys is now refused, naming each key it would have dropped, and the feed is left as it was. Send every key to keep, use `gf_patch_feed` to change only some keys, or pass `replace_meta: true` to remove keys on purpose (the response then lists `removed_meta_keys`). An update that sends no `meta`, or one that carries every stored key, is unaffected. `gf_patch_feed` refuses `replace_meta` rather than ignoring it.
- **`gf_list_entries` now refuses a top-level `offset`, `per_page` or `page`.** Gravity Forms reads paging only from inside the `paging` object, so `offset: 100` was ignored and the call returned the first 10 entries, which reads as a successful page of results. A call that used to be accepted and returned page 1 is now refused, with the shape to use: `paging: { page_size, current_page }`, or `paging: { page_size, offset }` to start at an entry offset. `paging` itself is unchanged.
- **`gf_list_forms` now refuses `per_page`, `page`, `status`, `active`, `exclude` and `search`.** Gravity Forms reads only `include` on this endpoint, so a call like `status: "inactive"` returned every active form, which is the opposite of what it asked for. A call that used to be accepted and answered with the unfiltered list is now refused, and the message points at `include`, which also fetches inactive and trashed forms by id.
- **`gf_create_entry` and `gf_update_entry` now accept `date_created` in the format Gravity Forms returns.** `"2026-01-01 00:00:00"` was refused with "must be a valid ISO 8601 date", and that string is exactly what `gf_get_entry` returns, so an entry could not be read and written back. `"YYYY-MM-DD HH:MM:SS"` (UTC) is now sent as given. ISO 8601 with a `Z` or offset is still accepted, and is now converted to the UTC stamp Gravity Forms stores rather than forwarded as typed, so `2026-01-01T02:30:00+02:00` is stored as `2026-01-01 00:30:00`. A date on its own becomes midnight UTC. Three inputs that used to pass are now refused: a timestamp with no zone (`2026-01-01T00:00:00`, where Gravity Forms cannot know whose clock it is), and a calendar date that does not exist (`2026-02-30`). `date_updated`, which was forwarded unchecked, takes the same shapes. The tool schemas now name the accepted formats.
- **`gf_update_entry` now updates `date_updated`.** Every entry changed through the tool kept the `date_updated` it was created with: the update reads the entry, merges your values and sends the whole entry back, and Gravity Forms stamps the current time only when the value it receives is empty. The stored date rode along, so an entry edited today still read as untouched since creation, and anything that sorts or filters on `date_updated` (a support workflow, an export, a sync) missed it. An update that names no `date_updated` now leaves it to Gravity Forms. One you pass is still saved as given.
- **A notification created through `gf_create_form` or `gf_update_form` now fires on submission.** One with a recipient, subject and message and no `event` was saved as sent and never sent anything: Gravity Forms sends only the notifications whose `event` matches the one being triggered, and an absent event matches none. The form editor always writes `form_submission`; the API does not. A new notification with no `event` now gets `form_submission`, and one you set (`form_saved`, say) is kept. On `gf_update_form` this applies only to notifications the call adds: one already on the form is sent back as stored, so an update never changes when an existing notification fires. A stored notification that has no event, created before this fix, stays inert until you send it back with `event: "form_submission"`. Confirmations need no change: Gravity Forms' own default confirmation has no event, and a missing button is filled in when the form is read.
- **`gf_send_notifications` no longer reports `sent: true` when nothing was sent.** `sent` was a constant. Gravity Forms sends only the notifications whose `event` matches the one requested (default `form_submission`) and answers with the ones it sent, so a form with no such notification returned `{ sent: true, notifications_sent: [] }`. `sent` is now true only when Gravity Forms reports at least one notification. When it reports none the response is `sent: false` with a `reason`: the form has no notifications, none has the requested event (naming the events it does have, and calling out a notification with no event), or some have it but a `gform_disable_notification` filter disabled them. Finding the reason costs two reads, made only when nothing was sent; a send that worked is still one request. `notifications_sent` lists what Gravity Forms handed to its sender, and Gravity Forms skips an inactive notification, or one whose conditional logic is not met, without reporting it, so a listed id is not proof an email left the site. The tool description now says so.
- **`gf_send_notifications` now checks `form_id` when you pass one.** It was accepted and discarded: Gravity Forms finds the form from the entry, so naming the wrong form (entry 101707 is in form 166, the call named 165) was answered as a success. `form_id` is now in the schema as an optional check. A form that is not the entry's form is refused, naming both, before anything is sent. Leave it out and nothing changes, since the entry already decides the form.
- **`gf_submit_form_data`, `gf_validate_submission` and `gf_validate_form` now refuse `field_values` in every form, and no longer list it.** A query string such as `"p1=a&p2=b"` was accepted and sent to Gravity Forms, which does nothing with it on the REST API, so a caller who used it to fill fields got a submission with those fields empty and no error. A list does nothing either, and an object is a 400 on `gf_submit_form_data`. A call that used to be accepted and silently ignored is now refused, with a message pointing at top-level `input_N` keys (`input_1: "Ada"`, sub-inputs `input_1_3`), which is how submitted values reach Gravity Forms. The parameter is removed from the tool schemas so a client that checks input against the schema no longer offers it. `gf_validate_form` and `gf_validate_submission` refuse it as well: their endpoint would pass an object through and skip a field's choice check, which would report a submission as valid that `gf_submit_form_data` then rejects.

Checkbox fields are the one exception: Gravity Forms reads each choice from its own sub-input, so pass `input_5_1` and `input_5_2` rather than an array under `input_5`.

## [2.5.0] - 2026-09-17

This release improves how GravityKit product tools register themselves: they now publish output schemas and return more structured results. Destructive requests can be permitted per-product instead of all or nothing, and a site with more than 50 abilities now exposes all of them. GravityKit MCP also installs into Claude Desktop [as a one-click extension](https://github.com/GravityKit/MCP/releases/latest/download/gravitykit-mcp.mcpb). Gravity Forms tools gain more accurate errors and improved feed and field handling.

### 🚀 Added
- **A Claude Desktop extension.** GravityKit MCP now builds as a [one-click `.mcpb` bundle](https://github.com/GravityKit/MCP/releases/latest/download/gravitykit-mcp.mcpb), so connecting Claude Desktop to a site is installing a file and filling in four fields — site address, WordPress username, application password, and what the assistant is allowed to delete — rather than hand-editing a JSON config..
- **Product tools now publish an output schema, a title, and structured results.** Generated tools described only their input. Each now declares its result shape and a human-readable title, and returns `structuredContent` alongside the text, which clients that support it can read directly.
- **An ability that does not become a tool now says why.** Tools missing from the list were indistinguishable from a product that was not installed. The server now reports each one it skipped and the reason, in the response rather than only in a log.
- **Transient failures are retried.** A site answering 429, 502, 503 or 504 is busy, not refusing, and the documentation had long promised a retry that was never implemented. Those four statuses are now retried with a backoff; 401 and 403 are answers and are never retried.
- **The tool catalog refreshes itself when it goes out of date.** Upgrading a product mid-session left an assistant holding tools the site no longer had, and every call failed until it reconnected. The server now notices a call that names a missing ability, refetches the catalog, and tells the client the tool list changed.

### ✨ Improved
- **Sites with more than 50 abilities now expose all of them.** The fallback catalog read took only the first page, so a large site silently lost every tool past the first fifty. It now reads every page.
- **Ability results are no longer stripped of empty values.** Compacting a response removed keys whose value was null, empty or `false` which, on a status report, made "not running" indistinguishable from a field that does not exist. Product tools now return what the site sent.

### 🔒 Security
- **Forced `fast-uri` to 4.1.3.** It arrives through the schema validator the server uses on every tool call. Contributed by @anupamme (#15).
- **Updated the Model Context Protocol SDK to 1.30.0 and `form-data` to 4.0.6.** The `form-data` bump closes a published advisory reachable through the HTTP client. The SDK move carries no protocol change — the server still speaks 2025-11-25.
- **Updated axios, the library the server uses to talk to your site, to 1.18.0.** Contributed by @anupamme (#14).

### 🐛 Fixed
- **`gf_delete_field` now respects the delete switch.** Deleting a form, entry, or feed required `GRAVITY_FORMS_ALLOW_DELETE=true`, but deleting a field did not, so a server set to refuse deletions still let an assistant remove a field, and a removed field does not go to the Trash. Field deletion is now refused the same way, and the tool's description says so. Contributed by @mechkw (#13).
- **A product tool that states no safety annotations is no longer reported as safe.** The MCP specification treats an unstated `destructiveHint` as destructive, but an ability that declared neither `destructive` nor `readonly` was published to clients as harmless. Unstated now means destructive, so a product that forgets to annotate an ability errs toward warning the assistant rather than reassuring it. Spotted by @mechkw (#13).
- **`gf_list_forms` no longer advertises search and pagination it does not have.** The description promised both; the schema offered neither, and Gravity Forms' `/forms` endpoint implements neither — it declares `search`, `page` and `per_page` and then ignores all three, returning every active form at once. An agent told the tool could search would read an unfiltered list as a filtered one. The description now says what the tool does: active forms by title, `include` to fetch specific ids whatever their state, and no search or paging. The `compact` option's description was also inverted — it said the default returned raw data when the default strips empty values.
- **`gf_update_field` no longer blocks harmless updates, and now guards the changes that matter.** Any update to a field referenced by conditional logic demanded `force`, even a label change that cannot affect a rule, which taught agents to pass `force` on every call. Meanwhile a change to a field a calculation formula depends on went through with no warning at all. The gate now fires only when the update changes properties dependents consume (`type`, `choices`, `inputs`) on a field with dependent conditional logic, calculations, or merge tags (the same dependency set `gf_delete_field` checks). Cosmetic updates always proceed, with dependency information still reported in warnings.
- **Compact responses now strip empty values everywhere, including repeated objects.** When the same object appeared twice in a response (for example, `gf_update_field` returns the updated field both as `field` and as `changes.after`), the second occurrence came back raw with all its empty values, inflating token usage and making the two copies look different. The cycle guard now tracks only the current recursion path, so shared objects are compacted at every occurrence while real cycles still terminate safely.
- **`gf_get_results` now supports search criteria.** The client forwarded search parameters, but validation stripped them, so every call returned unfiltered results with no warning. The tool now accepts the same `search` object as `gf_list_entries` (field filters, mode, date range) and passes it to Gravity Forms, which honors it when aggregating quiz, poll, and survey results.
- **Requests now send the correct User-Agent.** The auth layer hardcoded a stale `Gravity MCP v1.0.0` User-Agent that silently overrode the versioned one on every Gravity Forms request, defeating server-side diagnostics. Auth headers now carry only `Authorization`, and a test captures the header an actual HTTP server receives so the regression cannot hide behind client defaults again.
- **The MCP handshake now reports the real server version.** It was hardcoded to 2.1.0, so clients logged the wrong version for every release since. The handshake now reads the single-sourced version from package.json, and a test fails if it ever drifts again.
- **The `compact` response option no longer leaks into data saved to WordPress.** `compact` and `test_mode` are server-side options, but they rode along in the request body for entry, form, feed, and submission writes. On `gf_update_form` that polluted the saved form configuration with a stray `compact` key (verified against a live site; entries were unaffected because Gravity Forms discards unknown entry keys on write). Control options are now removed before any request reaches the site.
- **`gf_create_feed` now honors `is_active: false`.** The tool advertised `is_active`, but validation dropped it and Gravity Forms ignores it on create, so every feed was created active. The client now creates the feed and immediately deactivates it when `is_active: false` is requested, returning the feed in its final state.
- **Gravity Forms tool errors now include the details WordPress returned.** When the API rejected a request, every `gf_*` tool reported only a one-line message and dropped the HTTP status, error code, and per-parameter details, leaving the agent without the information it needed to correct the call. Those details now pass through to the error response, matching what the GravityKit product tools already did.
- **GravityKit product tools (`gv_*`) now carry safety annotations, and destructive ones are gated per product.** Generated tools shipped without MCP annotations, so a client had no signal that `gv_view_delete` destroys data and no way to tell a read from a write. Each tool now advertises whether it is read-only, destructive or idempotent, and destructive tools stay disabled until they are named in `GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE` — by exact tool name, by product prefix (`gmig`, `gv`), or `all`. A disabled tool now says so in its own description, and names what to switch on, instead of failing only when called.
- **`gf_add_field` now places fields at the top of a form when asked.** Requesting `prepend`, `index: 0`, or `before` the first field silently added the field to the end of the form while reporting a different position. Index 0 is now honored everywhere a position is calculated.
- **`gf_add_field` can no longer create duplicate field ids.** Passing `properties.id` overrode the safely generated id with no collision check, so a duplicate id could corrupt the form and every entry saved after it. Supplied ids now follow the same rules as `gf_create_form`: a fresh valid id is kept; a duplicate, non-numeric, or out-of-range id is replaced with a generated one and the response says so. `properties.type` can no longer override the declared field type either.
- **`gf_update_feed` no longer wipes a feed's settings on a partial update.** Updating one property (for example toggling `is_active`) sent the feed back to WordPress without its `meta`, erasing the feed's entire configuration. Validation now leaves out fields the caller did not send, so the existing settings are preserved. The same fix keeps `gf_patch_feed` from sending phantom empty fields.
- **Guidance for side-by-side (horizontal) search bars.** Asked to arrange a View's search fields in one horizontal row, agents set the search bar's `search_layout` setting, which persists but changes nothing, leaving the fields stacked. The server instructions now document the mechanism GravityView actually renders: add an `area_settings` entry with `layout: "row"` into the search bar's `search_fields_section` position bucket (read it with `gv_view_config_get`, write it back with `gv_view_widget_patch`). A new `search.horizontal-layout` release-gate task guards this end to end on a small model.

## [2.4.1] - 2026-06-25

This release lets the field tools work with custom and third-party field types (not just the ones built into Gravity Forms), and tightens input handling and security across the server.

### 🐛 Fixed
- **`gf_add_field` now accepts custom and third-party field types.** Field types added by other plugins were previously rejected because they aren't in the built-in registry. They are now created normally, with a note when type-specific defaults or sub-inputs aren't available; pass `inputs`/`choices` explicitly for custom compound or choice fields.
- **Compound field sub-inputs stay consistent with the field's id.** When a field's id is auto-assigned or differs from the one supplied, its sub-input ids (e.g. `5.1`, `5.2`) are rebased to match, so `name`, `address`, and custom compound fields save to the right inputs.
- **`gf_update_field` no longer saves a change it then reports as blocked.** When a field had dependent conditional logic and `force` wasn't set, the update was written before the "use force to proceed" response, so the check protected nothing. The dependency check now runs before the write (matching `gf_delete_field`).
- **Hardened tool-input handling.** Malformed or hostile input to the field, validation, and dependency helpers (empty/`null`/non-string field types, `null` properties or position, a `null` entry in a form's `fields`, non-scalar filter values, self-referential objects) now returns a clean error or is handled safely instead of failing opaquely.
- **Security and validation hardening.** Loopback detection no longer treats a remote `127.x` domain as local (which could have allowed Basic auth over plain HTTP); `Cookie` headers and values are masked in logs; confirmation-redirect URL validation accepts dotless hosts (localhost/intranet); and duplicate or out-of-range explicit field ids are corrected so generated forms stay valid (an out-of-range id can no longer stall form creation).

## [2.4.0] - 2026-06-19

This update adds additional guards to make sure Gravity Forms entries save correctly for every field type, so an AI assistant gets the entry format right the first time. Adds explicit support for the `password` field type and Gravity Wiz Nested Forms, plus a benchmark suite that ensures the MCP works well with small models.

### 🚀 Added
- **`password` field type** in the registry.
- **Expanded `entry_input` hints in `gf_list_field_types` summary mode** for every field type whose entry format isn't an obvious plain string.
- **Nested Form (`form`) field config in the registry + `gf_list_field_types --detail`**: documents the GP Nested Forms `gpnfForm` (child form id) and `gpnfFields` ("Summary Fields", which child fields show in the nested summary).

### ✨ Improved
- **`gf_create_form` auto-assigns field ids when omitted**, preventing an AI round-trip with smaller models.
- **`gf_delete_form` / `gf_delete_entry` descriptions** now state the safe Trash default explicitly and instruct the model to proceed with Trash unless the user asks to permanently delete
- **Server `instructions`** now point to GravityView's search-bar flow.
- **Fixes GravityKit tool fetching with one-shot clients.** Clients that read the ability catalog once (e.g. `claude -p`) now wait to receive the GravityKit ability list.

### 🐛 Fixed
- **No-input GravityView tools (e.g. `gv_forms_list`) failed with "input is not of type object".** Readonly abilities called with no arguments sent the `/run` request with no `input` parameter, which the WordPress Abilities API rejected as a non-object (400). The loader now always sends an object-shaped input (`input=` on GET/DELETE, which WordPress reads as an empty object; `{input:{}}` on POST), so tools that take no arguments work.
- **Improved support for complex field types**, including `address`, `chainedselect`, `survey_rank`, `date`, and the survey/quiz/poll fields.
- **Corrected storage structures** for many field types, helping improve first-time success rates.
- **`sorting.is_numeric` is interpreted strictly.** Sorting is now valid only when it genuinely means true (`true`, `1`, `"true"`, `"1"`) and omitted otherwise so GF falls back to lexical ordering.
- **Improved cleanup** Any crashed or improperly-killed client left an orphaned process running.

### 💻 Developer Notes
- Adds dev-only benchmark suites (not shipped in the npm package):
  - `npm run bench`: the AI release gate that drives the full MCP surface through a small model (`claude-haiku-4-5`) and grades real Gravity Forms/GravityView state.
  - `npm run bench:field-output`: a deterministic field-output smoke suite.
  - `npm run bench:field-storage`: field-storage validation against real add-ons.
  - `npm run bench:nested-forms`: a front-end render test confirming a parent View shows a nested form's Summary Fields (directory shows child ids; single entry renders the child table).

## [2.3.0] - 2026-06-16

A second correctness pass on the `gf_*` plane — three tools that failed on valid input — plus clearer server instructions. Verified against live Gravity Forms.

### 🐛 Fixed
- **`gf_add_field` and `gf_update_field` crashed on every call** with `getWarnings is not a function`. `FieldManager` called a validator method that did not exist, so both tools threw before reaching the API. `FieldAwareValidator.getWarnings()` now exists (returns warnings for a missing label or a choice field with no choices; never throws) and both tools work.
- **`gf_validate_form` created a real entry instead of validating.** Like the 2.2.0 `gf_validate_submission` fix, it POSTed to `/submissions`; it now uses the dedicated `/forms/{id}/submissions/validation` route and returns `{valid, validation_messages, page_number}` **without persisting an entry**.
- **`field_values` was typed as an object** on `gf_submit_form_data` and `gf_validate_form` — the inverse of Gravity Forms, which declares it as a string/array of dynamic-population data and rejects an object with a 400. It now accepts a query string or array; objects are rejected client-side with a message pointing to the `input_N` keys for submitted values.
- **`sorting.is_numeric: false` forced numeric ordering.** GF never casts the flag, so the string `"false"` read as truthy. `is_numeric` is now sent only when truthy and omitted otherwise.

### ✨ Improved
- Server `instructions` rewritten from a second-person playbook into declarative two-plane prose. The imperative phrasing was echoed back by some non-Claude-Code clients as injected commands; the tools are self-describing, so the instructions now just state the `gf_*` / `gv_*` planes and point at the `gv_*_list` discovery tools and `gk_reload_abilities`.

## [2.2.0] - 2026-06-16

A correctness pass on the Gravity Forms (`gf_*`) plane, verified against Gravity Forms 2.10.3 source and a live GF site (self-seeding `npm run test:live` harness).

### 🐛 Fixed
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

### 🚀 Added
- **`gf_list_entries`** now supports and advertises GF's native `include` (fetch-by-ID, returns entries of **any** status), `paging.offset`, `sorting.is_numeric`, and querying multiple forms at once.
- Self-seeding live end-to-end test harness (`npm run test:live`) that provisions its own throwaway forms/entries against a real Gravity Forms site and tears them down.
- Adversarial `*-hardening` test suites (client, validation, sanitize, schema) covering hostile and edge-case input.

### ✨ Improved
- `include` uses GF's native fast-path (any status); `exclude` maps to an `id NOT IN` search filter. `gf_list_forms` no longer accepts the `status`/`active`/`exclude` params that GF's `/forms` endpoint ignores.

### 🔒 Security
- `sanitize()` now masks common secret field names (`secret`, `client_secret`, `private_key`, `*_secret_key`, `password`); `sanitizeUrl()` masks `oauth_signature` and HTTP Basic `user:pass@` credentials in logged URLs.

## [2.1.0] - 2026-03-31

### 🐛 Fixed
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

### 🚀 Added
- `_normalizeArrayValues()` in GravityFormsClient: fetches form schema to match array values to correct sub-input IDs for all choice-based field types
- 41 array normalization tests covering checkbox, multiselect, radio, select, option, quiz, poll, survey, post_category, post_custom_field, list, entry_tags, HTML entity decoding, and mixed-form scenarios
- 25 field registry tests verifying storage definitions and variant-specific overrides
- Compound field fallback: logs warning and stores as single value when subInput mapping is missing

## [2.0.0] - 2026-03-31

### ✨ Improved
- **Renamed project from GravityMCP to GravityKit MCP**
- npm package: `@gravitykit/gravitymcp` → `@gravitykit/mcp`
- GitHub repo: `GravityKit/GravityMCP` → `GravityKit/MCP`
- MCP server name: `gravitymcp` → `gravitykit-mcp`
- CLI binary: `gravitymcp` → `gkmcp`
- Environment variable: `GRAVITYKIT_MCP_TEST_MODE` (legacy `GRAVITYMCP_TEST_MODE` still supported)
- User-Agent header updated to `GravityKit MCP/2.0.0`

### 🔄 Backwards Compatibility
- The old `@gravitykit/gravitymcp` npm package is published as a bridge that depends on `@gravitykit/mcp` with a deprecation notice — existing installs continue working
- GitHub auto-redirects old repo URL (`GravityKit/GravityMCP`) to the new one
- `GRAVITYMCP_TEST_MODE` environment variable still works alongside new `GRAVITYKIT_MCP_TEST_MODE`

## [1.4.1] - 2026-03-20

### 🐛 Fixed
- Race condition in concurrent fetch-then-merge updates: added per-resource mutex to serialize mutations on the same form/entry/feed
- `FieldManager` double-fetch eliminated: new `replaceForm()` does direct PUT without re-fetching (3 HTTP calls → 2 per field op)
- `console.log` calls in 7 files replaced with `logger.info`/`logger.warn` to prevent JSON-RPC stdout corruption
- `mcp.json` phantom `gf_submit_form` tool removed, 4 field operation tools added, version synced
- `_variant`/`_meta` internal metadata stripped from field objects before sending to API
- Field operation errors now propagate to `wrapHandler` with `isError: true` instead of being silently swallowed
- Name field sub-input IDs corrected (`.2`=prefix, `.3`=first, matching Gravity Forms)
- Feature filter `conditional` now maps to correct registry key `supportsConditionalLogic`
- `gf_delete_feed` description now mentions `ALLOW_DELETE` requirement

### 🚀 Added
- `ResourceMutex` utility (`utils/mutex.js`) with `acquire`/`release` and `withLock()` for safe concurrent operations
- `replaceForm(formId, formData)` client method for direct PUT without re-fetch
- MCP tool annotations on all 26 tools (`readOnlyHint`, `destructiveHint`, `openWorldHint`)
- Server-level `instructions` string documenting compact mode (sent once at session start)
- 31 new tests: 22 bug regression tests + 9 mutex concurrency tests

### ✨ Improved
- Tool descriptions stripped of repeated compact boilerplate (~130 tokens saved per `tools/list` call)
- `compact` property description shortened to "Return raw uncompacted data"

### 🗑️ Removed
- Redundant `gf_list_form_feeds` tool (`gf_list_feeds` with `form_id` does the same thing plus addon filtering)
- Deprecated `crypto` and unused `form-data` npm dependencies
- False `batch_operations: true` claim from `mcp.json`

## [1.4.0] - 2026-03-20

### 🚀 Added
- Test mode environment resolution: when `GRAVITYMCP_TEST_MODE=true`, the client automatically uses `GRAVITY_FORMS_TEST_*` env vars (base URL, consumer key/secret) instead of live credentials
- `testConfig.resolveEnv()` method in `config/test-config.js` as the canonical place for environment resolution
- Init log now shows `(TEST MODE)` indicator when connecting to test site
- Support for `GRAVITY_FORMS_TEST_BASE_URL` env var (in addition to existing `GRAVITY_FORMS_TEST_URL`)

### 🐛 Fixed
- Removed 4 unused variable warnings (`response` in delete methods, `safeHeaders` in request interceptor)

## [1.3.0] - 2026-03-10

### 🚀 Added
- Compact mode: `stripEmpty()` recursively removes `null` and `""` values from all responses to reduce token usage
- Entry meta stripping: plugin-added meta keys (e.g., `gv_revision_*`, `helpscout_conversation_id`) are stripped by default via `stripEntryMeta()`
- Pass `compact=false` for full raw data

### 🐛 Fixed
- Updated axios and MCP SDK to patch security vulnerabilities

## [1.1.0] - 2026-03-10

### ✨ Improved
- Reduced token usage across all tool responses: no pretty-print, no redundant `message` strings, no echo-back of input IDs
- Updated AGENTS.md and CLAUDE.md for token optimization documentation

### 🐛 Fixed
- Granted `contents:write` permission in publish CI workflow

## [1.0.5] - 2026-02-18

### 🐛 Fixed
- Fixed OAuth signature generation in `validateRestApiAccess` to pass full URL, method, and params to `getAuthHeaders()`
- Fixed confirmations and notifications validation to accept objects keyed by ID instead of arrays, matching Gravity Forms' actual data format
- Added defensive optional chaining for `httpClient.defaults.baseURL`

### ✨ Improved
- Updated test helpers: added `defaults.baseURL` to MockHttpClient
- Updated test data and validation tests to use object format for confirmations and notifications

## [1.0.4] - 2025-01-13

### 🚀 Added
- Comprehensive data sanitization for secure logging
- GitHub Actions workflows for automated testing and publishing
- Self-signed SSL certificate support for local development
- Auto-generate inputs array for compound fields in `gf_create_form`
- Load `.env` from working directory with project fallback

### 🐛 Fixed
- Updated CodeQL Action to v3

### ✨ Improved
- Removed local Claude settings from version control

## [1.0.3] - 2024-12-09

### ✨ Improved
- Renamed package from `gravity-mcp` to `GravityMCP` for consistency
- Updated all documentation references to use new naming
- Improved Claude Desktop configuration example

### 🗑️ Removed
- Removed obsolete rename script

### 🚀 Added
- GitHub Actions workflow for automated npm publishing
- GitHub Actions workflow for continuous testing

## [1.0.2] - 2024-12-09

### 🐛 Fixed
- Fixed logging for MCP and test modes

## [1.0.1] - 2024-12-09

### 🚀 Added
- Initial release of GravityMCP
- Full Gravity Forms REST API v2 coverage
- 28 MCP tools for complete forms management
- OAuth 1.0a and Basic authentication support
- Advanced search and filtering capabilities
- File upload support
- Comprehensive test suite
- Dual environment configuration (test/production)

### 🚀 Features
- Forms management (6 tools)
- Entries management (6 tools)
- Field operations (4 tools)
- Form submissions (2 tools)
- Add-on feeds (7 tools)
- Notifications (1 tool)
- Field filters (1 tool)
- Results/Analytics (1 tool)

[2.5.0]: https://github.com/GravityKit/MCP/releases/tag/v2.5.0
[2.4.1]: https://github.com/GravityKit/MCP/releases/tag/v2.4.1
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
