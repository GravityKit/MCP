/**
 * Auto-generate MCP tool definitions from the live WordPress
 * Abilities API surface.
 *
 * Source preference chain (each step falls back to the next):
 *
 *   1. Foundation catalog — `/wp-json/gravitykit/v1/abilities`.
 *      The canonical contract: server-side GravityKit filtering
 *      (`gk_registered_by === 'gravitykit'`), server-owned tool naming
 *      (`mcp_tool_name`, from each product's required `mcp_prefix` declared
 *      on Foundation's `gk/foundation/abilities/products` filter, falling
 *      back to the full product slug), and disabled abilities already
 *      omitted.
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
 * `mcp_tool_name` (Manager::get_mcp_tool_name() — declared `mcp_prefix`
 * or the full-product-slug fallback), stamped into ability meta so the
 * WP core catalog carries it too.
 * The client never invents names — abilities arriving without
 * `mcp_tool_name` are skipped with a warning, so a naming gap is
 * visible instead of silently diverging between connections.
 *
 * Handlers execute abilities through `/wp-abilities/v1/abilities/{name}/run`
 * with the HTTP method derived from the ability's annotations
 * (`readonly` → GET, `destructive`+`idempotent` → DELETE, otherwise POST).
 */

import logger from '../utils/logger.js';

/** Foundation's GravityKit-only catalog route (Foundation >= 1.21). */
export const FOUNDATION_CATALOG_ROUTE = '/wp-json/gravitykit/v1/abilities';

/** WP core's all-plugins abilities route (WP 6.9+ / abilities-api). */
export const CORE_ABILITIES_ROUTE = '/wp-json/wp-abilities/v1/abilities';

/**
 * WP error codes that mean the catalog this agent holds no longer matches the
 * site — a product upgraded, or an ability was renamed or removed mid-session.
 * A permissions refusal or a genuine bad argument is NOT in here: refetching the
 * catalog on every failure would refetch it on the agent's own mistakes.
 */
const STALE_CATALOG_CODES = new Set(['rest_ability_not_found', 'ability_invalid_input']);

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
  if (annotations?.readonly) return 'GET';
  // Foundation's run controller only accepts DELETE for abilities that
  // are BOTH destructive AND idempotent — matching WP-REST conventions
  // for HTTP DELETE. Destructive-but-not-idempotent operations (e.g.
  // view-delete with `force` defaulting to soft trash) must go through
  // POST so their non-idempotent semantics are explicit on the wire.
  if (annotations?.destructive && annotations?.idempotent) return 'DELETE';
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
 * @param {boolean} [options.allowDelete]  Mirrors the static gf_delete_*
 *   gate (GRAVITY_FORMS_ALLOW_DELETE): when false, handlers for abilities
 *   annotated `destructive` throw instead of executing.
 * @returns {Promise<{ definitions: object[], handlers: Record<string, Function>, count: number, source: 'foundation-catalog'|'wp-core' }>}
 */
export async function loadAbilitiesAsTools(wpClient, { reservedNames, allowDelete = false, allowDestructive, onStaleCatalog } = {}) {
  // Why an ability did not become a tool is the question a product author asks,
  // and it was answerable only by reading the server's stderr.
  const skipped = [];

  try {
    const items = await fetchFoundationCatalogItems(wpClient);
    const entries = catalogItemsToEntries(items, skipped);

    if (entries.length > 0) {
      return buildTools(wpClient, entries, 'foundation-catalog', { reservedNames, allowDelete, allowDestructive, skipped, onStaleCatalog });
    }

    logger.warn(`Foundation catalog at ${FOUNDATION_CATALOG_ROUTE} returned no usable abilities — falling back to WP core catalog`);
  } catch (err) {
    logger.warn(`Foundation catalog unavailable (${err.message}) — falling back to WP core catalog at ${CORE_ABILITIES_ROUTE}`);
  }

  const entries = await fetchCoreEntries(wpClient);
  return buildTools(wpClient, entries, 'wp-core', { reservedNames, allowDelete });
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
function catalogItemsToEntries(items, skipped = []) {
  const entries = [];

  for (const item of items) {
    if (typeof item?.name !== 'string' || !GK_NAME_PATTERN.test(item.name)) continue;
    if (item.enabled === false) {
      skipped.push({ ability: item.name, reason: 'Disabled in the GravityKit settings for this site.' });
      continue;
    }
    if (typeof item.mcp_tool_name !== 'string' || item.mcp_tool_name === '') {
      const reason = 'No mcp_tool_name in the catalog — the product declares no MCP prefix, so the server cannot name a tool for it.';
      logger.warn(`Ability ${item.name} has no mcp_tool_name — skipped (the server owns tool naming)`);
      skipped.push({ ability: item.name, reason });
      continue;
    }

    entries.push({
      abilityName:    item.name,
      toolName:       item.mcp_tool_name,
      description:    item.description || item.label || item.name,
      rawInputSchema:  item.input_schema,
      rawOutputSchema: item.output_schema,
      label:           typeof item.label === 'string' ? item.label : undefined,
      annotations:     item.annotations && typeof item.annotations === 'object' ? item.annotations : {},
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
async function fetchCoreEntries(wpClient, skipped = []) {
  // Core's list endpoint defaults to 50 items per page and caps per_page at
  // 100, and it paginates across EVERY plugin's abilities rather than ours —
  // so a single unpaginated request returns the first 50 of the whole site and
  // silently drops the rest. Same loop and same runaway guard as the Foundation
  // path above.
  const PER_PAGE = 100;
  const MAX_PAGES = 20;
  const abilities = [];

  let page = 1;
  let totalPages = 1;

  do {
    const response = await wpClient.httpClient.request({
      method:  'GET',
      baseURL: wpClient.baseUrl,
      url:     CORE_ABILITIES_ROUTE,
      params:  { per_page: PER_PAGE, page },
    });

    if (!Array.isArray(response.data)) {
      throw new Error('Unexpected Abilities API catalog shape — expected array.');
    }

    abilities.push(...response.data);

    const headerTotal = Number(response.headers?.['x-wp-totalpages']);
    totalPages = Number.isFinite(headerTotal) && headerTotal > 0 ? Math.min(headerTotal, MAX_PAGES) : 1;
    page += 1;
  } while (page <= totalPages);

  const entries = [];

  for (const ability of abilities) {
    if (typeof ability?.name !== 'string') continue;

    const meta = ability.meta && typeof ability.meta === 'object' ? ability.meta : {};
    if (meta.gk_registered_by !== 'gravitykit') continue;

    if (typeof meta.mcp_tool_name !== 'string' || meta.mcp_tool_name === '') {
      const reason = 'No meta.mcp_tool_name — the product declares no MCP prefix, so the server cannot name a tool for it.';
      logger.warn(`Ability ${ability.name} has no meta.mcp_tool_name — skipped (the server owns tool naming)`);
      skipped.push({ ability: ability.name, reason });
      continue;
    }

    entries.push({
      abilityName:    ability.name,
      toolName:       meta.mcp_tool_name,
      description:    ability.description || ability.label || ability.name,
      rawInputSchema:  ability.input_schema,
      rawOutputSchema: ability.output_schema,
      label:           typeof ability.label === 'string' ? ability.label : undefined,
      annotations:     meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {},
    });
  }

  if (entries.length === 0) {
    throw new Error('No usable GravityKit abilities in the WP core catalog (missing gk_registered_by stamp or mcp_tool_name).');
  }

  return entries;
}

/**
 * An ability's `output_schema`, or undefined when it has none worth publishing.
 *
 * WordPress defaults an undeclared output schema to `[]`, and MCP requires a
 * tool schema to be `type: 'object'`, so an empty array must not be published —
 * a client validating against it would reject every call. PHP's array-vs-object
 * serialisation also turns an empty `properties` map into `[]`, the same shape
 * `normalizeInputSchema()` coerces.
 *
 * @param {unknown} raw The catalog's `output_schema`.
 * @returns {object|undefined}
 */
function normalizeOutputSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (raw.type !== 'object') return undefined;

  const properties = raw.properties && !Array.isArray(raw.properties) ? raw.properties : {};

  return { ...raw, properties };
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
 * @param {object} [options]
 * @param {Set<string>} [options.reservedNames] Names owned by the built-in tool set.
 * @param {boolean} [options.allowDelete] Execute destructive abilities (GRAVITY_FORMS_ALLOW_DELETE).
 * @returns {{ definitions: object[], handlers: Record<string, Function>, count: number, source: string }}
 */
/**
 * Whether a destructive tool is permitted on this server.
 *
 * The allow-list holds `all`, a product prefix (`gv`, `gmig`, `gf`), or an exact
 * tool name. A prefix matches the segment before the first underscore, so `gmig`
 * permits a bundle import without also permitting a View delete — which the old
 * single boolean could not express.
 *
 * @param {string}   toolName        The MCP tool name.
 * @param {string[]} allowDestructive Entries as above.
 * @returns {boolean}
 */
function destructiveIsPermitted(toolName, allowDestructive) {
  if (!Array.isArray(allowDestructive) || allowDestructive.length === 0) return false;
  if (allowDestructive.includes('all')) return true;
  if (allowDestructive.includes(toolName)) return true;

  const prefix = toolName.slice(0, toolName.indexOf('_'));
  return prefix !== '' && allowDestructive.includes(prefix);
}

function buildTools(wpClient, entries, source, { reservedNames, allowDelete = false, allowDestructive, skipped = [], onStaleCatalog } = {}) {
  // GRAVITY_FORMS_ALLOW_DELETE is the old spelling and means "all", so a server
  // configured before the list existed keeps working.
  const permitted = Array.isArray(allowDestructive) && allowDestructive.length > 0
    ? allowDestructive
    : (allowDelete ? ['all'] : []);

  const definitions = [];
  const handlers = {};
  const claimedBy = new Map();

  if (reservedNames) {
    for (const name of reservedNames) {
      claimedBy.set(name, 'a built-in tool');
    }
  }

  // Ability FQN → tool name, built from the entries that SURVIVE the collision
  // guard below. Built from every entry, a step naming a skipped ability resolves
  // to the tool name that ability wanted — which now belongs to a different
  // ability, or to a built-in, so the agent is sent somewhere else entirely.
  const surviving = [];
  const toolNameByAbility = new Map();

  for (const entry of entries) {
    const takenBy = claimedBy.get(entry.toolName);
    if (takenBy) {
      const reason = `Tool-name collision: "${entry.toolName}" is already claimed by ${takenBy}.`;
      logger.warn(`${reason} Skipping ${entry.abilityName}`);
      skipped.push({ ability: entry.abilityName, reason });
      continue;
    }
    claimedBy.set(entry.toolName, entry.abilityName);
    surviving.push(entry);

    if (!toolNameByAbility.has(entry.abilityName)) {
      toolNameByAbility.set(entry.abilityName, entry.toolName);
    }
  }

  for (const entry of surviving) {
    const annotations  = entry.annotations || {};
    const isDestructive = !!annotations.destructive;
    const isPermitted   = !isDestructive || destructiveIsPermitted(entry.toolName, permitted);

    let description = entry.description;
    if (isDestructive && !isPermitted) {
      description += ` (destructive; disabled on this server — add "${entry.toolName}" to GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE to enable)`;
    }
    const nextStepsHint = formatNextSteps(annotations.next_steps, toolNameByAbility);
    if (nextStepsHint) {
      description += ` Next: ${nextStepsHint}`;
    }

    // `normalizeInputSchema()` guarantees the shape MCP's Zod validator
    // expects — PHP-serialised array schemas otherwise fail `tools/list`.
    // The MCP annotations mirror the ability's: without them clients get
    // no destructive signal (no confirmation before gv_view_delete).
    const outputSchema = normalizeOutputSchema(entry.rawOutputSchema);

    definitions.push({
      name: entry.toolName,
      ...(entry.label ? { title: entry.label } : {}),
      description,
      inputSchema: normalizeInputSchema(entry.rawInputSchema),
      // Only when the ability declares a usable one: the spec obliges a tool
      // that publishes an outputSchema to return matching structuredContent.
      ...(outputSchema ? { outputSchema } : {}),
      annotations: {
        readOnlyHint:   !!annotations.readonly,
        destructiveHint: isDestructive,
        idempotentHint: !!annotations.idempotent,
        openWorldHint:  true,
      },
    });

    // Closure captures the ability name + method so the dispatcher
    // doesn't need to re-resolve them at call time. Server-side the
    // ability's permission_callback and Foundation's enable/disable
    // toggles still apply; the allowDelete gate below mirrors the
    // static gf_delete_* client-side protection on top of that.
    const abilityName = entry.abilityName;
    const method      = methodForAbility(annotations);
    handlers[entry.toolName] = async (params) => {
      if (!isPermitted) {
        throw new Error(`${entry.toolName} is a destructive operation and is disabled on this server. Add "${entry.toolName}" (or its product prefix, or "all") to GRAVITYKIT_MCP_ALLOW_DESTRUCTIVE to enable it.`);
      }
      try {
        return await executeAbility(wpClient, abilityName, method, params || {});
      } catch (error) {
        // A product upgraded mid-session leaves the agent holding a schema the
        // site no longer accepts, and the site answers "invalid input" — which
        // reads as the agent's mistake rather than a stale catalog. Refetch for
        // the next call and say so, rather than letting it retry the same shape.
        if (STALE_CATALOG_CODES.has(error?.response?.data?.code)) {
          if (typeof onStaleCatalog === 'function') onStaleCatalog();
          error.message = `${error.message} — the tool catalog may be out of date for this site; it has been refreshed, so re-read this tool's schema before retrying.`;
        }
        throw error;
      }
    };
  }

  return { definitions, handlers, count: definitions.length, source, skipped };
}

/**
 * Render an ability's `next_steps` guidance ([{ability, when}, …], authored
 * server-side) as a terse description suffix, translating ability FQNs to
 * the MCP tool names the agent can call. Steps pointing at abilities that
 * are not exposed as tools are dropped. Returns '' when nothing usable.
 *
 * @param {unknown} nextSteps
 * @param {Map<string, string>} toolNameByAbility
 * @returns {string}
 */
function formatNextSteps(nextSteps, toolNameByAbility) {
  if (!Array.isArray(nextSteps)) return '';

  const parts = [];
  for (const step of nextSteps) {
    if (!step || typeof step !== 'object' || typeof step.ability !== 'string') continue;
    const toolName = toolNameByAbility.get(step.ability);
    if (!toolName) continue;
    const when = typeof step.when === 'string' && step.when !== '' ? ` (${step.when})` : '';
    parts.push(`${toolName}${when}`);
  }
  return parts.join('; ');
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

/**
 * Invariant: EVERY ability declares an object `input_schema` (Foundation
 * guarantees this), so the loader ALWAYS sends an object input — an empty
 * call goes out as an empty object in the method-appropriate empty
 * representation. The WP abilities-api validates the `input` arg against
 * `type:object`, so a missing/`null` arg would fail ("input is not of type
 * object" → 400); an empty object never does. Readonly abilities MUST use
 * GET — WP core's run controller enforces method-per-annotation (readonly =
 * GET, destructive+idempotent = DELETE, else POST), so uniform POST isn't an
 * option. On GET/DELETE, WP rehydrates `input=''` as `{}`
 * (rest_is_object('') === true), the wire form of an empty object on a query
 * string.
 *
 * @param {object}  wpClient        WordPressClient instance.
 * @param {string}  abilityName     Fully-qualified ability name.
 * @param {'GET'|'POST'|'DELETE'} method  Method derived from annotations.
 * @param {object}  input           Caller-supplied input (may be empty).
 */
async function executeAbility(wpClient, abilityName, method, input) {
  // Explicit baseURL so the URL resolves at the WP root regardless
  // of how the client instance is namespaced.
  const baseURL = wpClient.baseUrl;
  const url     = `/wp-json/wp-abilities/v1/abilities/${abilityName}/run`;

  const hasInputKeys = !!input && Object.keys(input).length > 0;

  if (method === 'GET' || method === 'DELETE') {
    // WordPress REST takes bracketed query params for object-typed
    // args, NOT a JSON-stringified `?input=` value (the controller
    // hands the raw string straight to the schema validator, which
    // then complains "input is not of type object"). Recursively
    // expand the input into `input[key][nested]=value` so WP
    // rehydrates the nested object structure.
    const config = { method, baseURL, url };
    const params = {};
    if (input) walkInputToBracketedParams(input, 'input', params);
    if (Object.keys(params).length > 0) {
      config.params = params;
    } else {
      // No serializable params — either truly empty input, or keys that
      // flatten away ({ nested: {} }, { a: null }). Send `input=` (empty
      // string): WP's rest_is_object('') === true, so it validates as an
      // empty object — whereas empty/omitted params send `null`, which fails
      // the type:object check with a 400.
      config.params = { input: '' };
    }
    const { data } = await wpClient.httpClient.request(config);
    return data;
  }

  // POST. The Abilities API wraps input under an `input` key in the body.
  // With keys → `{ input: {…} }`. Empty → `{ input: {} }` (a real empty
  // object validates against type:object).
  const data = hasInputKeys ? { input } : { input: {} };

  const response = await wpClient.httpClient.request({
    method,
    baseURL,
    url,
    data,
  });
  return response.data;
}
