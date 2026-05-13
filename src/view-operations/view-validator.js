/**
 * Client-side validator for the inspector REST surface.
 *
 * The server is the source of truth (every write runs through
 * `apply_collection` and per-setting sanitisers in InspectorRoute),
 * but failing fast on the obvious structural mistakes saves a round
 * trip and gives the agent a more useful error message — "field_id
 * is required on every entry in fields[<area>]" beats a 400 with
 * `gv_rest_invalid_field`.
 *
 * Validation tiers:
 *   - structural (free): required keys, types, enums, mode
 *   - schema-aware (one fetch): per-field-type setting validation
 *     against the live `/field-types/{type}/schema` response
 *
 * Schema-aware checks are opt-in (`{ deep: true }`) because they
 * cost a network round trip per unique field type referenced.
 */

const VALID_MODES = ['replace', 'merge'];

export class ViewValidator {
  constructor(client) {
    this.client = client;
    // Cache field-type schemas across calls so a payload touching
    // ten `text` fields only fetches the schema once.
    this.schemaCache = new Map();
  }

  /**
   * Structural validation of an apply payload. Throws on the first
   * issue with a message the AI agent can use to correct the call.
   */
  validateApplyPayload(payload = {}) {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('apply payload must be an object.');
    }

    if (payload.mode !== undefined && !VALID_MODES.includes(payload.mode)) {
      throw new Error(`mode must be one of: ${VALID_MODES.join(', ')}`);
    }

    if (payload.fields !== undefined) {
      this.validateAreaTree('fields', payload.fields);
    }
    if (payload.widgets !== undefined) {
      this.validateAreaTree('widgets', payload.widgets);
    }

    if (payload.template_id !== undefined && typeof payload.template_id !== 'string') {
      throw new Error('template_id must be a string.');
    }

    if (payload.template_settings !== undefined && (typeof payload.template_settings !== 'object' || payload.template_settings === null)) {
      throw new Error('template_settings must be an object.');
    }

    if (payload.search_criteria !== undefined && (typeof payload.search_criteria !== 'object' || payload.search_criteria === null)) {
      throw new Error('search_criteria must be an object.');
    }
  }

  /**
   * Validate the create-View payload before it leaves the client.
   * The server enforces the same checks but returning early avoids
   * a 400 round trip for typos.
   */
  validateCreatePayload(payload = {}) {
    if (!payload.title || typeof payload.title !== 'string') {
      throw new Error('title (non-empty string) is required.');
    }
    if (!Number.isInteger(payload.form_id) || payload.form_id <= 0) {
      throw new Error('form_id (positive integer) is required.');
    }
    if (payload.template_id !== undefined && typeof payload.template_id !== 'string') {
      throw new Error('template_id must be a string.');
    }
    // Reuse the apply-payload structural checks for the seed bits.
    this.validateApplyPayload({
      template_id: payload.template_id,
      template_settings: payload.template_settings,
      search_criteria: payload.search_criteria,
      fields: payload.fields,
      widgets: payload.widgets,
      mode: payload.mode,
    });
  }

  validateAreaTree(label, tree) {
    if (typeof tree !== 'object' || tree === null) {
      throw new Error(`${label} must be an object keyed by area key.`);
    }
    for (const [area, items] of Object.entries(tree)) {
      if (typeof area !== 'string' || area === '') {
        throw new Error(`${label} contains a non-string area key.`);
      }
      if (!Array.isArray(items)) {
        throw new Error(`${label}["${area}"] must be an array of slot objects.`);
      }
      items.forEach((item, idx) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`${label}["${area}"][${idx}] must be an object.`);
        }
        if (!('field_id' in item) || item.field_id === '' || item.field_id === null) {
          throw new Error(`${label}["${area}"][${idx}] is missing required key "field_id".`);
        }
        if (item.slot !== undefined && typeof item.slot !== 'string') {
          throw new Error(`${label}["${area}"][${idx}].slot must be a string when present.`);
        }
      });
    }
  }

  /**
   * Schema-aware validation. Walks every field AND every widget in
   * the payload, fetches the matching field-type schema (cached),
   * and confirms the settings keys are recognised.
   *
   * Widgets dispatch to widget-specific schemas (post the InspectorRoute
   * fix that detects registered widgets). Fields whose `field_id` is a
   * numeric/composite GF id are skipped — those settings live in the
   * View-specific bulk-schema endpoint, not the field-type registry.
   *
   * Pass `{ template_id, context }` so the schema fetch matches the
   * setting set the inspector actually persists for that combination.
   */
  async validateAgainstSchemas({ fields = {}, widgets = {}, template_id, context }) {
    const allEntries = [
      ...Object.values(fields).flatMap((arr) => arr.map((item) => ({ kind: 'field', item }))),
      ...Object.values(widgets).flatMap((arr) => arr.map((item) => ({ kind: 'widget', item }))),
    ];

    for (const { kind, item } of allEntries) {
      // Widgets identify themselves through field_id too — InspectorRoute
      // detects when the type maps to a registered widget and returns
      // the widget's settings schema (e.g. search_bar → search_layout,
      // search_fields, …). Skipping schema validation for widgets would
      // miss the most common authoring mistake (typoed setting key).
      const typeSlug = guessFieldType(item.field_id);
      if (!typeSlug) continue;

      const schema = await this.getSchema(typeSlug, template_id, context);
      if (!schema || !Array.isArray(schema.schema)) continue;

      const validKeys = new Set(schema.schema.map((entry) => entry.slug));
      // `field_id`, `slot`, `label`, `id`, `custom_label`, `custom_class`
      // are always accepted by the server alongside whatever the schema
      // lists — they're meta-keys persisted independently of per-type
      // settings.
      const reservedKeys = new Set([
        'field_id',
        'slot',
        'label',
        'id',
        'custom_label',
        'custom_class',
      ]);

      for (const key of Object.keys(item)) {
        if (reservedKeys.has(key)) continue;
        if (!validKeys.has(key)) {
          const samples = [...validKeys].slice(0, 12).join(', ');
          const more = validKeys.size > 12 ? ', …' : '';
          throw new Error(
            `${kind} "${item.field_id}" has unknown setting "${key}". Schema for ${schema.kind || 'type'} "${typeSlug}" lists: ${samples}${more}`
          );
        }
      }
    }
  }

  /**
   * When the payload places fields into Layout Builder area keys
   * (compound `{prefix}-{areaid}::{type}::{row_uid}` form), confirm
   * the referenced row_uids exist in the View's current grid. Without
   * this check, a typoed row_uid silently lands the field somewhere
   * the inspector can't render.
   *
   * Cheap: one `gv_get_view_areas` call regardless of payload size.
   * No-op when none of the area keys look like Layout Builder keys.
   */
  async validateLayoutBuilderAreas({ id, fields = {}, widgets = {} }) {
    const allAreas = Object.keys({ ...fields, ...widgets });
    const lbAreas = allAreas.filter((key) => key.includes('::'));
    if (!id || lbAreas.length === 0) return;

    let known;
    try {
      const areas = await this.client.getViewAreas({ id });
      const zoneMap = areas?.zones || {};
      known = new Set();
      for (const zone of Object.keys(zoneMap)) {
        for (const row of zoneMap[zone] || []) {
          for (const area of row.areas || []) {
            if (area.areaid) {
              known.add(`${zone}_${area.areaid}`);
            }
          }
        }
      }
    } catch (err) {
      // Areas fetch failed (network, perms, missing template) — degrade
      // to no-op rather than blocking the write.
      return;
    }

    for (const areaKey of lbAreas) {
      if (!known.has(areaKey)) {
        const sample = [...known].slice(0, 4).join(', ');
        throw new Error(
          `Area "${areaKey}" doesn't exist in this View's grid. Use gv_get_view_areas to discover valid areas, or gv_create_grid_row to add a new row first. Known areas include: ${sample}…`
        );
      }
    }
  }

  async getSchema(fieldType, template_id, context) {
    const key = `${fieldType}|${template_id || ''}|${context || ''}`;
    if (this.schemaCache.has(key)) return this.schemaCache.get(key);
    try {
      const data = await this.client.getFieldTypeSchema({ field_type: fieldType, template_id, context });
      this.schemaCache.set(key, data);
      return data;
    } catch (error) {
      // Schema discovery failures shouldn't block writes — degrade
      // to structural-only validation. Cache the failure so we don't
      // re-fetch on every field with the same type.
      this.schemaCache.set(key, null);
      return null;
    }
  }
}

/**
 * Best-effort field-type inference from a `field_id`. The inspector
 * REST API uses the same identifier for both numeric form fields
 * (e.g. "1", "5.2") and meta-fields (e.g. "custom", "entry_link",
 * "edit_link"). Numeric ids are form fields and could be any type;
 * non-numeric ids ARE the type slug. For numeric ids we return null
 * because validating them needs the form schema, not the field-type
 * schema (different API).
 */
function guessFieldType(fieldId) {
  if (fieldId === undefined || fieldId === null) return null;
  const str = String(fieldId).trim();
  if (str === '') return null;
  // Numeric (incl. composite like "5.2") — we can't determine type
  // from the id alone. Skip schema-aware validation for these.
  if (/^\d+(\.\d+)?$/.test(str)) return null;
  return str;
}

export default ViewValidator;
