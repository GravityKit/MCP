/**
 * Shared helpers for task definitions: telemetry predicates + a unique-id
 * factory for fixtures. Keeping these here keeps each task declarative.
 */

let counter = 0;
/** A collision-resistant fixture label (no Date.now — varies by call + pid). */
export function uniqueLabel(prefix = 'BENCH') {
  counter += 1;
  return `${prefix}_${process.pid}_${counter}_${Math.floor(performance.now())}`;
}

/** True if no MCP tool call errored. Sandbox denials (the agent probing a
 *  built-in it doesn't have) are not MCP failures and don't count. */
export const noToolErrors = (t) => (t.toolCalls || []).every((c) => !c.isError || c.denied);

/** True if a tool whose name contains `needle` was called and did NOT error. */
export const calledOk = (t, needle) =>
  (t.toolCalls || []).some((c) => c.name.includes(needle) && !c.isError);

/** Any error tool call whose code matches (for targeted regression detail). */
export const sawErrorCode = (t, re) =>
  (t.toolCalls || []).some((c) => c.isError && re.test(c.errorCode || c.text || ''));

/** Flatten a GravityView directory-fields tree into the field ids it references. */
export function fieldIdsInTree(tree) {
  const ids = [];
  for (const area of Object.values(tree || {})) {
    const slots = Array.isArray(area) ? area : Object.values(area || {});
    for (const slot of slots) {
      if (slot && (slot.id || slot.field_id)) ids.push(String(slot.id ?? slot.field_id));
    }
  }
  return ids;
}

/** All slot objects in a fields/widgets tree, in tree order (optionally one area). */
export function slotsInTree(tree, areaKey) {
  const out = [];
  for (const [area, slots] of Object.entries(tree || {})) {
    if (areaKey && area !== areaKey) continue;
    const arr = Array.isArray(slots) ? slots : Object.values(slots || {});
    for (const s of arr) if (s && typeof s === 'object') out.push(s);
  }
  return out;
}

/** First slot in a tree whose id/field_id matches. */
export function findSlotById(tree, id) {
  return slotsInTree(tree).find((s) => String(s.id ?? s.field_id) === String(id)) || null;
}

/** Number of area keys in a tree (a proxy for "a grid row/area was added"). */
export const areaKeyCount = (tree) => Object.keys(tree || {}).length;

/** Widget ids present anywhere in a widgets tree. */
export function widgetIds(widgets) {
  return slotsInTree(widgets).map((w) => String(w.id || '')).filter(Boolean);
}

/** Strip a canonical `{form_id}::` prefix GravityView stamps onto GF search field ids. */
function bareFieldId(value) {
  const s = String(value ?? '');
  const i = s.lastIndexOf('::');
  return i === -1 ? s : s.slice(i + 2);
}

/** Match a stored search field by id, tolerant of the `{form_id}::id` prefix. */
function searchFieldIdMatches(field, fieldId) {
  const stored = field?.field ?? field?.id ?? field?.field_id;
  if (stored == null || stored === '') return false;
  return String(stored) === String(fieldId) || bareFieldId(stored) === String(fieldId);
}

/** The canonical input control of a stored search field (storage uses `input_type`). */
export function searchFieldInput(field) {
  return String(field?.input_type ?? field?.input ?? '');
}

/** The search-field slot for a given form field id inside any search_bar widget. */
export function searchFieldFor(widgets, fieldId) {
  for (const widget of slotsInTree(widgets)) {
    if (widget.id !== 'search_bar') continue;
    const section = widget.search_fields_section || {};
    const positions = Array.isArray(section) ? section : Object.values(section);
    for (const pos of positions) {
      for (const field of Object.values(pos || {})) {
        if (searchFieldIdMatches(field, fieldId)) return field;
      }
    }
  }
  return null;
}

/** Does any widget area hold a search_bar referencing the given field id? */
export function searchBarHasField(widgets, fieldId) {
  for (const area of Object.values(widgets || {})) {
    const slots = Array.isArray(area) ? area : Object.values(area || {});
    for (const widget of slots) {
      if (!widget || widget.id !== 'search_bar') continue;
      const section = widget.search_fields_section || {};
      const positions = Array.isArray(section) ? section : Object.values(section);
      for (const pos of positions) {
        for (const field of Object.values(pos || {})) {
          if (searchFieldIdMatches(field, fieldId)) return true;
        }
      }
    }
  }
  return false;
}
