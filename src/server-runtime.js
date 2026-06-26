/**
 * Pure helpers for the MCP server runtime, extracted from index.js so the
 * two-plane behavior is unit-testable. See test/server-runtime.test.js.
 */

/**
 * Initialize the two capability planes. The WordPress plane must not be gated
 * on the (potentially slow) Gravity Forms REST probe.
 * @returns {Promise<{gfOk: boolean, wpOk: boolean}>}
 */
export async function runPlaneInit({ initGravityFormsPlane, initWordPressPlane }) {
  // WP plane first (synchronous, instant — it fire-and-forgets the abilities
  // load) so a slow GF REST probe never gates it. Then await the GF probe.
  const wpOk = initWordPressPlane();
  const gfOk = await initGravityFormsPlane();
  if (!gfOk && !wpOk) {
    throw new Error('Neither Gravity Forms nor WordPress credentials are usable. Set GRAVITY_FORMS_* and/or GRAVITYKIT_WP_* in .env.');
  }
  return { gfOk, wpOk };
}

/**
 * Assemble the advertised tool list. Gravity Forms tools are only listed when
 * that plane is live (otherwise they'd error on call). gk_reload_abilities is
 * always present; ability tools appear once the catalog loads.
 */
export function buildToolList({ gfReady, gfToolDefs = [], fieldOpTools = [], abilityDefs = [], gkReloadDef }) {
  return [
    ...(gfReady ? [...gfToolDefs, ...fieldOpTools] : []),
    ...(abilityDefs ?? []),
    gkReloadDef,
  ].filter(Boolean);
}

/**
 * Decide how to route a call that wasn't a static Gravity Forms tool or
 * gk_reload_abilities: dispatch to the dynamic ability handler map, or one of
 * the error states.
 * @returns {'dispatch'|'no-wp-client'|'catalog-unreachable'|'unknown'}
 */
export function classifyAbilityCall({ name, hasWpClient, handlers }) {
  // Route by handler-map membership — product-agnostic, so any GravityKit
  // prefix (gv_, gc_, …) dispatches as long as the catalog registered it.
  if (handlers && Object.prototype.hasOwnProperty.call(handlers, name)) return 'dispatch';
  if (!hasWpClient) return 'no-wp-client';
  if (!handlers) return 'catalog-unreachable';
  return 'unknown';
}

/**
 * How long tools/list waits for the abilities catalog before shipping the list.
 *
 * Defaults to 2000ms — fast handshake; if the catalog isn't loaded yet the
 * product tools (gv_*) stream in afterward via tools/list_changed. That's fine
 * for clients that honor list_changed, but a ONE-SHOT client (e.g. `claude -p`)
 * reads tools/list once, so it would miss gv_* if the catalog is slower than the
 * wait. Such a client can raise GRAVITYKIT_MCP_LIST_TIMEOUT_MS to make the first
 * tools/list block long enough to return the complete catalog. Non-positive or
 * non-numeric values fall back to the default.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {number} milliseconds
 */
export function resolveAbilitiesListTimeoutMs(env = process.env) {
  const raw = Number(env.GRAVITYKIT_MCP_LIST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}
