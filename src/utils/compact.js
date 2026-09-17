/**
 * Compact utility — strips null and empty string values from objects/arrays recursively.
 * Used by wrapHandler() to reduce token usage in MCP responses.
 *
 * Strips: null, ''
 * Preserves: false (semantic meaning, e.g. is_active: false), 0, "0"
 * Pass compact=false to get raw unstripped data when you need to see blank fields.
 */

/**
 * Recursively strip null and '' values from an object or array.
 * @param {*} obj - Value to compact
 * @returns {*} Compacted value
 */
export function stripEmpty(obj, seen = new WeakSet()) {
  // `seen` tracks the CURRENT recursion path only (delete on the way out):
  // a genuine cycle bails, but a shared non-cyclic reference — the same
  // choices array on two fields — is compacted at every occurrence. A
  // permanent set returned the second occurrence raw, nulls intact.
  if (Array.isArray(obj)) {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    const result = obj.map((v) => stripEmpty(v, seen));
    seen.delete(obj);
    return result;
  }
  if (obj !== null && typeof obj === 'object') {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === '') continue;
      result[key] = stripEmpty(value, seen);
    }
    seen.delete(obj);
    return result;
  }
  return obj;
}

/**
 * Core entry properties returned by the GF REST API.
 * Everything else is plugin-added entry meta (stripped by default).
 */
const CORE_ENTRY_KEYS = new Set([
  'id', 'form_id', 'post_id', 'date_created', 'date_updated',
  'is_starred', 'is_read', 'ip', 'source_url', 'user_agent',
  'currency', 'payment_status', 'payment_date', 'payment_amount',
  'payment_method', 'transaction_id', 'is_fulfilled', 'created_by',
  'transaction_type', 'status', 'source_id'
]);

/**
 * Test if a key is a field value (numeric or dot-notation like "5.1").
 */
function isFieldKey(key) {
  return /^\d+(\.\d+)?$/.test(key);
}

/**
 * Strip plugin-added entry meta from an entry object.
 * Keeps core properties and numbered field values.
 * @param {object} entry - Single entry object
 * @returns {object} Entry with only core + field keys
 */
export function stripEntryMeta(entry) {
  if (!entry || typeof entry !== 'object') {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(entry)) {
    if (CORE_ENTRY_KEYS.has(key) || isFieldKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Strip entry meta from a response containing entries.
 * Handles both { entries: [...] } and { entry: {...} } shapes.
 * @param {object} response - Tool response object
 * @returns {object} Response with entry meta stripped
 */
export function stripEntryMetaFromResponse(response) {
  if (response.entries && Array.isArray(response.entries)) {
    return { ...response, entries: response.entries.map(stripEntryMeta) };
  }
  if (response.entry && typeof response.entry === 'object') {
    return { ...response, entry: stripEntryMeta(response.entry) };
  }
  return response;
}

export default { stripEmpty, stripEntryMeta, stripEntryMetaFromResponse };

/**
 * What an ability's result looks like on the wire.
 *
 * NOT compacted by default, unlike the Gravity Forms plane this helper was
 * written for. WordPress validates every ability's output against its declared
 * `output_schema` before returning it, so the payload conforms when it leaves
 * the site; stripping keys here is the only thing that makes it stop conforming,
 * and it is the precondition for publishing `outputSchema` at all — the spec
 * requires `structuredContent` to match the schema it advertises.
 *
 * A GF form object carries dozens of empty properties and an entry carries one
 * per unfilled field, which is what compaction was built for. An ability payload
 * is authored, and an explicitly empty title is a different fact from an absent
 * one.
 *
 * @param {*} result The ability's payload.
 * @param {{compact?: boolean}} [options] Pass `compact: true` to opt in.
 * @returns {*}
 */
export function shapeAbilityResult(result, { compact = false } = {}) {
  return compact === true ? stripEmpty(result) : result;
}
