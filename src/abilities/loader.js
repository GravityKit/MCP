/**
 * Auto-generate MCP tool definitions from the live WordPress
 * Abilities API surface.
 *
 * Source preference chain (each step falls back to the next):
 *
 *   1. Foundation catalog — `/wp-json/gravitykit/v1/abilities`.
 *      The canonical contract: server-side GravityKit filtering
 *      (`gk_registered_by === 'gravitykit'`), server-owned tool naming
 *      (`mcp_tool_name`, derived from Foundation's per-product
 *      MCP_TOOL_PREFIXES map), and disabled abilities already omitted.
 *      Any GravityKit product that registers abilities through Foundation
 *      appears here automatically — no client-side allow-list.
 *   2. WP core catalog — `/wp-json/wp-abilities/v1/abilities`.
 *      For connections whose user can't pass the Foundation catalog's
 *      permission gate (default manage_options vs core's `read`).
 *      Filtered client-side on Foundation's stamped metadata:
 *      `meta.gk_registered_by === 'gravitykit'`.
 *   3. When both catalogs are unreachable (older WP without the
 *      Abilities API, plugin disabled, network blip) this module throws;
 *      the caller leaves gv_* tools unregistered and retries on the next
 *      gv_* call (self-healing).
 *
 * Tool naming is owned by the SERVER on both paths: Foundation's
 * `mcp_tool_name` (Manager::get_mcp_tool_name() + MCP_TOOL_PREFIXES).
 * The client never invents names — abilities arriving without
 * `mcp_tool_name` are skipped with a warning, so a naming gap is
 * visible instead of silently diverging between connections.
 *
 * Handlers execute abilities through `/wp-abilities/v1/abilities/{name}/run`
 * with the HTTP method derived from the ability's annotations
 * (`readonly` → GET, `destructive` → DELETE, otherwise POST).
 */

import logger from '../utils/logger.js';

/** Foundation's GravityKit-only catalog route (Foundation >= 1.21). */
export const FOUNDATION_CATALOG_ROUTE = '/wp-json/gravitykit/v1/abilities';

/** WP core's all-plugins abilities route (WP 6.9+ / abilities-api). */
export const CORE_ABILITIES_ROUTE = '/wp-json/wp-abilities/v1/abilities';

/** Foundation's ability-name contract: gk-{product}/{action}. */
const GK_NAME_PATTERN = /^gk-[a-z0-9-]+\//;

/**
 * Determine the HTTP method to use when executing an ability.
 * Matches the Abilities API REST controller's contract:
 *   - readonly → GET
 *   - destructive + idempotent → DELETE
 *   - else POST
 *
 * @param {object} annotations Ability meta.annotations.
 * @returns {'GET'|'POST'|'DELETE'}
 */
export function methodForAbility(annotations = {}) {
  if (annotations.readonly) return 'GET';
  // Foundation's run controller only accepts DELETE for abilities that
  // are BOTH destructive AND idempotent — matching WP-REST conventions
  // for HTTP DELETE. Destructive-but-not-idempotent operations (e.g.
  // view-delete with `force` defaulting to soft trash) must go through
  // POST so their non-idempotent semantics are explicit on the wire.
  if (annotations.destructive && annotations.idempotent) return 'DELETE';
  return 'POST';
}

/**
 * Coerce an ability's `input_schema` payload into a JSON Schema object the
 * MCP runtime can validate (`{ type: "object", properties: {...} }`).
 *
 * Two shapes from the WordPress Abilities API need normalising before they
 * hit MCP's Zod validator:
 *
 *   1. `input_schema` is itself an array — happens when the PHP side returns
 *      a list of parameter descriptors instead of a schema object. We wrap
 *      it as `{ type: 'object', properties: {<derived>}, required: [<derived>] }`,
 *      pulling each entry's `name` / `slug` / `key` as the property key when
 *      present. Anonymous entries fall back to `arg<N>`.
 *   2. `input_schema.properties` is an array (almost always `[]` from
 *      PHP serialising an empty associative array as a JSON list). MCP
 *      expects `properties` to be a `Record<string, JSONSchema>` — we
 *      coerce empty arrays to `{}` and non-empty arrays via the same
 *      per-entry key derivation as case 1.
 *
 * Returns a fresh object — never mutates the input.
 *
 * @param {unknown} raw  The `input_schema` value as received from the API.
 * @returns {{ type: 'object', properties: object, required?: string[], additionalProperties?: boolean }}
 */
export function normalizeInputSchema(raw) {
  // Missing / falsy → open object so the tool is still callable.
  if (raw === null || raw === undefined || raw === false) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  // Shape 1: top-level array of parameter descriptors.
  if (Array.isArray(raw)) {
    const { properties, required } = arrayToProperties(raw);
    const out = { type: 'object', properties };
    if (required.length) out.required = required;
    return out;
  }

  // Anything that isn't an object at this point is unusable — fall back
  // to an open object rather than letting Zod blow up downstream.
  if (typeof raw !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  // Shape 2: object whose `properties` is an array (PHP-serialised empty
  // assoc array, or a list of descriptors). Normalise it but keep every
  // other key the upstream provided (e.g. `required`, `additionalProperties`,
  // `description`, custom `$schema` extensions).
  const out = { ...raw };
  if (out.type !== 'object') out.type = 'object';

  if (Array.isArray(out.properties)) {
    const { properties, required } = arrayToProperties(out.properties);
    out.properties = properties;
    if (required.length && !Array.isArray(out.required)) {
      out.required = required;
    }
  } else if (out.properties === null || out.properties === undefined) {
    out.properties = {};
  } else if (typeof out.properties !== 'object') {
    out.properties = {};
  }

  return out;
}

/**
 * Convert a list of parameter descriptors into a `properties` map +
 * `required` list. Each entry contributes one property; the key is
 * derived from `name` / `slug` / `key` / `title` (in that order), or
 * `arg<index>` for anonymous entries. The descriptor is copied as the
 * value, with the chosen identifier key stripped so it doesn't double
 * as both the map key and a redundant schema field. An entry's
 * `required: true` (or string "true") lifts the property into the
 * outer `required` array — JSON Schema requires it there, not per-prop.
 */
function arrayToProperties(arr) {
  const properties = {};
  const required = [];
  arr.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      // Non-object entries can't be expressed as a JSON Schema property;
      // skip rather than fabricate a placeholder of unknown intent.
      return;
    }
    const key = entry.name || entry.slug || entry.key || entry.title || `arg${i}`;
    const { name: _n, slug: _s, key: _k, required: req, ...rest } = entry;
    properties[key] = rest;
    if (req === true || req === 'true') required.push(key);
  });
  return { properties, required };
}

/**
 * Fetch the abilities surface + build MCP tool definitions and handlers.
 *
 * Tries the Foundation catalog first (canonical naming + filtering),
 * falls back to the WP core catalog. Throws only when BOTH are
 * unreachable — the caller leaves gv_* tools unregistered and retries
 * on a later call.
 *
 * @param {object} wpClient  WordPressClient instance — uses its
 *                           authenticated httpClient.
 * @param {object} [options]
 * @param {Set<string>} [options.reservedNames]  Tool names owned by the
 *   built-in (static) tool set — e.g. the released gf_* contract.
 *   Catalog abilities resolving to a reserved name are skipped with a
 *   warning so the dynamic pipeline can never shadow a shipped tool.
 * @returns {Promise<{ definitions: object[], handlers: Record<string, Function>, count: number, source: 'foundation-catalog'|'wp-core' }>}
 */
export async function loadAbilitiesAsTools(wpClient, { reservedNames } = {}) {
  try {
    const items = await fetchFoundationCatalogItems(wpClient);
    const entries = catalogItemsToEntries(items);

    if (entries.length > 0) {
      return buildTools(wpClient, entries, 'foundation-catalog', reservedNames);
    }

    logger.warn(`Foundation catalog at ${FOUNDATION_CATALOG_ROUTE} returned no usable abilities — falling back to WP core catalog`);
  } catch (err) {
    logger.warn(`Foundation catalog unavailable (${err.message}) — falling back to WP core catalog at ${CORE_ABILITIES_ROUTE}`);
  }

  const entries = await fetchCoreEntries(wpClient);
  return buildTools(wpClient, entries, 'wp-core', reservedNames);
}

/**
 * Fetch every page of the Foundation GravityKit catalog.
 *
 * Pagination per the Foundation contract: `page`/`per_page` params,
 * `X-WP-TotalPages` response header. MAX_PAGES is a runaway guard, not
 * a coverage cap — at 100 items/page it allows 2,000 abilities.
 *
 * @param {object} wpClient WordPressClient instance.
 * @returns {Promise<object[]>} Catalog items (Manager::to_rest_item() shape).
 */
async function fetchFoundationCatalogItems(wpClient) {
  const PER_PAGE = 100;
  const MAX_PAGES = 20;
  const items = [];

  let page = 1;
  let totalPages = 1;

  do {
    // Explicit baseURL per request keeps this correct even when a
    // subclass mounts a namespaced httpClient (same auth + TLS).
    const response = await wpClient.httpClient.request({
      method:  'GET',
      baseURL: wpClient.baseUrl,
      url:     FOUNDATION_CATALOG_ROUTE,
      params:  { per_page: PER_PAGE, page },
    });

    if (!Array.isArray(response.data)) {
      throw new Error('Unexpected Foundation catalog shape — expected array.');
    }

    items.push(...response.data);

    const headerTotal = Number(response.headers?.['x-wp-totalpages']);
    totalPages = Number.isFinite(headerTotal) && headerTotal > 0 ? Math.min(headerTotal, MAX_PAGES) : 1;
    page += 1;
  } while (page <= totalPages);

  return items;
}

/**
 * Map Foundation catalog items (Manager::to_rest_item() shape) to the
 * internal tool-entry shape. The catalog is already GravityKit-only and
 * omits disabled abilities by default; the name-pattern and `enabled`
 * checks here are defensive only. Items without `mcp_tool_name` are
 * skipped — the server owns naming, the client never derives.
 *
 * @param {object[]} items Foundation catalog items.
 * @returns {Array<{abilityName: string, toolName: string, description: string, rawInputSchema: unknown, annotations: object}>}
 */
function catalogItemsToEntries(items) {
  const entries = [];

  for (const item of items) {
    if (typeof item?.name !== 'string' || !GK_NAME_PATTERN.test(item.name)) continue;
    if (item.enabled === false) continue;
    if (typeof item.mcp_tool_name !== 'string' || item.mcp_tool_name === '') {
      logger.warn(`Ability ${item.name} has no mcp_tool_name — skipped (the server owns tool naming)`);
      continue;
    }

    entries.push({
      abilityName:    item.name,
      toolName:       item.mcp_tool_name,
      description:    item.description || item.label || item.name,
      rawInputSchema: item.input_schema,
      annotations:    item.annotations && typeof item.annotations === 'object' ? item.annotations : {},
    });
  }

  return entries;
}

/**
 * Fetch the WP core abilities catalog and filter to GravityKit abilities.
 *
 * Filters on Foundation's stamped metadata
 * (`meta.gk_registered_by === 'gravitykit'`) — the documented
 * cross-product contract ("filter on these keys rather than parsing
 * names"). Naming requires `meta.mcp_tool_name`; abilities without it
 * are skipped with a warning (the server owns naming).
 *
 * Throws when no usable abilities are found so the caller's state stays
 * null (not sticky-empty) and the per-call self-heal keeps retrying.
 *
 * @param {object} wpClient WordPressClient instance.
 * @returns {Promise<Array<{abilityName: string, toolName: string, description: string, rawInputSchema: unknown, annotations: object}>>}
 */
async function fetchCoreEntries(wpClient) {
  const { data } = await wpClient.httpClient.request({
    method:  'GET',
    baseURL: wpClient.baseUrl,
    url:     CORE_ABILITIES_ROUTE,
  });

  if (!Array.isArray(data)) {
    throw new Error('Unexpected Abilities API catalog shape — expected array.');
  }

  const entries = [];

  for (const ability of data) {
    if (typeof ability?.name !== 'string') continue;

    const meta = ability.meta && typeof ability.meta === 'object' ? ability.meta : {};
    if (meta.gk_registered_by !== 'gravitykit') continue;

    if (typeof meta.mcp_tool_name !== 'string' || meta.mcp_tool_name === '') {
      logger.warn(`Ability ${ability.name} has no meta.mcp_tool_name — skipped (the server owns tool naming)`);
      continue;
    }

    entries.push({
      abilityName:    ability.name,
      toolName:       meta.mcp_tool_name,
      description:    ability.description || ability.label || ability.name,
      rawInputSchema: ability.input_schema,
      annotations:    meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {},
    });
  }

  if (entries.length === 0) {
    throw new Error('No usable GravityKit abilities in the WP core catalog (missing gk_registered_by stamp or mcp_tool_name).');
  }

  return entries;
}

/**
 * Build MCP tool definitions + handlers from normalized entries.
 *
 * Collision guard: with naming delegated to the server and filtering no
 * longer namespace-bound, two abilities could map to one tool name. The
 * first wins; later collisions are logged and skipped — never silently
 * shadowed.
 *
 * @param {object} wpClient WordPressClient instance.
 * @param {Array}  entries  Normalized tool entries.
 * @param {string} source   Which catalog produced the entries.
 * @param {Set<string>} [reservedNames] Names owned by the built-in tool set.
 * @returns {{ definitions: object[], handlers: Record<string, Function>, count: number, source: string }}
 */
function buildTools(wpClient, entries, source, reservedNames) {
  const definitions = [];
  const handlers = {};
  const claimedBy = new Map();

  if (reservedNames) {
    for (const name of reservedNames) {
      claimedBy.set(name, 'a built-in tool');
    }
  }

  for (const entry of entries) {
    const existing = claimedBy.get(entry.toolName);
    if (existing) {
      logger.warn(`Tool-name collision: "${entry.toolName}" from ${entry.abilityName} clashes with ${existing} — skipping ${entry.abilityName}`);
      continue;
    }
    claimedBy.set(entry.toolName, entry.abilityName);

    // MCP tool definition. `normalizeInputSchema()` guarantees the
    // shape MCP's Zod validator expects:
    //   `{ type: 'object', properties: <Record<string,JSONSchema>>, … }`.
    // Without it, abilities whose PHP serialisation produced an array
    // (top-level or under `properties`) fail `tools/list` validation —
    // see the helper's docblock for the two shapes we coerce.
    definitions.push({
      name: entry.toolName,
      description: entry.description,
      inputSchema: normalizeInputSchema(entry.rawInputSchema),
    });

    // Closure captures the ability name + method so the dispatcher
    // doesn't need to re-resolve them at call time. Destructive
    // gating lives server-side: each ability's permission_callback
    // (e.g. delete_post for view-delete) plus Foundation's
    // per-ability enable/disable toggles.
    const abilityName = entry.abilityName;
    const method      = methodForAbility(entry.annotations);
    handlers[entry.toolName] = async (params) => executeAbility(wpClient, abilityName, method, params || {});
  }

  return { definitions, handlers, count: definitions.length, source };
}

/**
 * Execute one ability via `/wp-abilities/v1/abilities/{name}/run`.
 *
 * Encoding rules per the Abilities API spec:
 *   - GET / DELETE: input rides on bracketed query params
 *   - POST:         input rides in the JSON body as `{input: ...}`
 *
 * Errors propagate verbatim from the server so the MCP runtime can
 * surface them (the abilities-api's `WP_Error` codes — `ability_invalid_input`,
 * `ability_invalid_permissions`, `rest_ability_invalid_method`, etc. —
 * already carry enough detail for an agent to self-correct).
 */
/**
 * Recursively expand a nested input object into bracket-notation
 * query params: `input[key]=val`, `input[key][nested]=val`, etc.
 * Mirrors how WordPress REST rebuilds an object from query strings,
 * which is the wire shape readonly abilities expect.
 */
function walkInputToBracketedParams(value, key, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkInputToBracketedParams(item, `${key}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkInputToBracketedParams(v, `${key}[${k}]`, out);
    }
    return;
  }
  out[key] = value;
}

async function executeAbility(wpClient, abilityName, method, input) {
  // Explicit baseURL so the URL resolves at the WP root regardless
  // of how the client instance is namespaced.
  const baseURL = wpClient.baseUrl;
  const url     = `/wp-json/wp-abilities/v1/abilities/${abilityName}/run`;

  if (method === 'GET' || method === 'DELETE') {
    // WordPress REST takes bracketed query params for object-typed
    // args, NOT a JSON-stringified `?input=` value (the controller
    // hands the raw string straight to the schema validator, which
    // then complains "input is not of type object"). Recursively
    // expand the input into `input[key][nested]=value` so WP
    // rehydrates the nested object structure.
    const config = { method, baseURL, url };
    if (input && Object.keys(input).length > 0) {
      const params = {};
      walkInputToBracketedParams(input, 'input', params);
      config.params = params;
    }
    const { data } = await wpClient.httpClient.request(config);
    return data;
  }

  // POST. The Abilities API wraps input under an `input` key in the body.
  const { data } = await wpClient.httpClient.request({
    method,
    baseURL,
    url,
    data: input && Object.keys(input).length > 0 ? { input } : {},
  });
  return data;
}
