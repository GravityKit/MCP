/**
 * Auto-generate MCP tool definitions from the live WordPress
 * Abilities API catalog (`/wp-json/wp-abilities/v1/abilities`).
 *
 * Replaces the hand-maintained `viewToolDefinitions` array (and the
 * corresponding `buildViewToolHandlers` switch) with a dynamic
 * pipeline:
 *
 *   1. On MCP startup, fetch every ability registered under the
 *      `gk-gravityview/` namespace.
 *   2. Transform each ability into a `{ name, description, inputSchema }`
 *      tuple the MCP runtime can list to clients.
 *   3. Build a handler per ability that executes the ability through
 *      `/wp-abilities/v1/abilities/{name}/run` with the right HTTP
 *      method derived from the ability's annotations
 *      (`readonly` → GET, `destructive` → DELETE, otherwise POST).
 *
 * Naming convention: `gk-gravityview/list-layouts` → `gv_list_layouts`.
 * Strips the namespace prefix and converts dashes to underscores.
 *
 * When the abilities catalog is unreachable (older WP without the
 * Abilities API, plugin disabled, network blip), the caller falls
 * back to the legacy hand-maintained tool definitions.
 */

/**
 * Convert a fully-qualified ability name to the MCP tool name our
 * existing callers + docs already know. Idempotent.
 *
 * Examples:
 *   gk-gravityview/list-layouts          → gv_list_layouts
 *   gk-gravityview/apply-view-config     → gv_apply_view_config
 *   gk-gravityview/get-template-settings-schema → gv_get_template_settings_schema
 */
export function abilityNameToToolName(abilityName) {
  if (typeof abilityName !== 'string' || !abilityName.includes('/')) {
    return abilityName;
  }
  const [, slug] = abilityName.split('/');
  return 'gv_' + slug.replace(/-/g, '_');
}

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
  if (annotations.destructive) return 'DELETE';
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
 * Default ability namespaces surfaced as MCP tools. Both `gk-gravityview/*`
 * (core GravityView abilities) and `gk-multiple-forms/*` (the Multiple
 * Forms add-on's join surface) share the `gv_*` MCP prefix because
 * they're conceptually one product family from the agent's POV. Slugs
 * are unique across both namespaces (verified manually); a collision
 * would silently shadow one with the other and is worth detecting if
 * we add a third namespace.
 *
 * @type {string[]}
 */
export const DEFAULT_ABILITY_NAMESPACES = ['gk-gravityview', 'gk-multiple-forms'];

/**
 * Fetch the abilities catalog + build MCP tool definitions and
 * handlers in a single pass.
 *
 * Throws when the abilities catalog endpoint is unreachable (the
 * caller decides whether to fall back to legacy tool defs).
 *
 * @param {object} gvClient  GravityViewClient instance — uses its
 *                           authenticated httpClient.
 * @param {string|string[]} [namespaces=DEFAULT_ABILITY_NAMESPACES]
 *   Filter abilities by namespace prefix. Accepts a single string for
 *   backward compatibility or an array.
 * @returns {Promise<{ definitions: object[], handlers: Record<string, Function>, count: number }>}
 */
export async function loadAbilitiesAsTools(gvClient, namespaces = DEFAULT_ABILITY_NAMESPACES) {
  // gvClient.httpClient is namespaced to /gravityview/v1. The
  // Abilities API lives at a sibling namespace (/wp-abilities/v1),
  // so we override baseURL per-request to the WP root rather than
  // creating a second axios instance (same auth + TLS config).
  const { data } = await gvClient.httpClient.request({
    method:  'GET',
    baseURL: gvClient.baseUrl,
    url:     '/wp-json/wp-abilities/v1/abilities',
  });
  if (!Array.isArray(data)) {
    throw new Error('Unexpected Abilities API catalog shape — expected array.');
  }

  const nsList = Array.isArray(namespaces) ? namespaces : [namespaces];
  const ours = data.filter(
    (a) => typeof a?.name === 'string' && nsList.some((ns) => a.name.startsWith(ns + '/')),
  );

  const definitions = [];
  const handlers = {};

  for (const ability of ours) {
    const toolName = abilityNameToToolName(ability.name);
    const annotations = ability?.meta?.annotations || {};

    // MCP tool definition. `normalizeInputSchema()` guarantees the
    // shape MCP's Zod validator expects:
    //   `{ type: 'object', properties: <Record<string,JSONSchema>>, … }`.
    // Without it, abilities whose PHP serialisation produced an array
    // (top-level or under `properties`) fail `tools/list` validation —
    // see the helper's docblock for the two shapes we coerce.
    definitions.push({
      name: toolName,
      description: ability.description || ability.label || ability.name,
      inputSchema: normalizeInputSchema(ability.input_schema),
    });

    // Closure captures the ability name + method so the dispatcher
    // doesn't need to re-resolve them at call time. The server-side
    // ability registry no longer exposes any "delete the whole View"
    // ability — the most destructive surface left is removing a
    // single field/widget/row, which is part of normal authoring
    // (and reversible by re-adding). For status-level changes the
    // caller uses gv_set_view_status with status='trash', gated by
    // delete_post on the WP side.
    const abilityName  = ability.name;
    const method       = methodForAbility(annotations);
    handlers[toolName] = async (params) => executeAbility(gvClient, abilityName, method, params || {});
  }

  return { definitions, handlers, count: ours.length };
}

/**
 * Execute one ability via `/wp-abilities/v1/abilities/{name}/run`.
 *
 * Encoding rules per the Abilities API spec:
 *   - GET / DELETE: input rides on a `?input=<URL-encoded JSON>` query arg
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

async function executeAbility(gvClient, abilityName, method, input) {
  // Cross-namespace request — override baseURL away from
  // /gravityview/v1 so the URL resolves to /wp-abilities/v1.
  const baseURL = gvClient.baseUrl;
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
    const { data } = await gvClient.httpClient.request(config);
    return data;
  }

  // POST. The Abilities API wraps input under an `input` key in the body.
  const { data } = await gvClient.httpClient.request({
    method,
    baseURL,
    url,
    data: input && Object.keys(input).length > 0 ? { input } : {},
  });
  return data;
}
