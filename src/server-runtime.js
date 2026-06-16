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
  ];
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
