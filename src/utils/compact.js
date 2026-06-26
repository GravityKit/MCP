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
  if (Array.isArray(obj)) {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    return obj.map((v) => stripEmpty(v, seen));
  }
  if (obj !== null && typeof obj === 'object') {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === '') continue;
      result[key] = stripEmpty(value, seen);
    }
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
