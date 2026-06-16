/**
 * GravityView Inspector REST API Client.
 *
 * Wraps the `/wp-json/gravityview/v1/...` endpoints exposed by the
 * GravityView plugin's Inspector route family (see
 * `src/REST/InspectorRoute.php` in the GravityView codebase). Those
 * routes are registered ONLY when `DOING_GRAVITYVIEW_TESTS` is defined
 * server-side — this client is the integration-test and demo harness,
 * not a runtime dependency. Runtime gv_* tools come from the abilities
 * loader (`src/abilities/loader.js`) riding the base WordPressClient.
 *
 * Authentication, base-URL resolution, TLS, and timeouts come from
 * WordPressClient (`src/wp-client.js`); this subclass mounts the
 * gravityview/v1 namespace on top.
 *
 * Concurrency: every config write supports `If-Match: "<version>"`
 * for optimistic-concurrency. Reads return the version in the body
 * AND in an ETag response header. The client keeps a per-view-id
 * version cache so callers can do `client.applyConfig(id, payload,
 * { ifMatch: 'auto' })` without juggling ETags by hand.
 */

import logger from '../utils/logger.js';
import { WordPressClient } from '../wp-client.js';

export class GravityViewInspectorClient extends WordPressClient {
  constructor(config) {
    super(config);

    this.restNamespace = '/wp-json/gravityview/v1';
    this.httpClient = this.createHttpClient(`${this.baseUrl}${this.restNamespace}`);

    // version cache keyed by view id — populated by every read so
    // callers can opt into automatic If-Match without a manual GET.
    this.versionCache = new Map();
  }

  /**
   * Ping the layouts endpoint to verify credentials + connectivity.
   * Cheap (no view id required, server returns the registered layout
   * engines which is a short list).
   */
  async testConnection() {
    try {
      const response = await this.httpClient.get('/layouts');
      return {
        success: true,
        layoutCount: Array.isArray(response.data?.layouts) ? response.data.layouts.length : 0,
        baseUrl: `${this.baseUrl}${this.restNamespace}`,
      };
    } catch (error) {
      return {
        success: false,
        status: error.response?.status,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  // ===================================================================
  // Discovery (no view id needed)
  // ===================================================================

  async listLayouts() {
    const { data } = await this.httpClient.get('/layouts');
    return data;
  }

  /**
   * GET /templates/{template_id}/settings-schema — discover every
   * setting available for a given template. Returns the same flat
   * `[{slug, type, label, value, options, group}, ...]` shape used
   * by field-type schemas, so a single client renderer covers both.
   *
   * Settings from add-ons that bridge their silo meta keys (e.g.
   * DataTables under prefix `datatables.*`) appear with dotted
   * slugs. Writing a dotted-slug key back through PATCH /apply or
   * /template-settings routes the value to the right meta key
   * automatically.
   */
  async getTemplateSettingsSchema({ template_id } = {}) {
    if (!template_id || typeof template_id !== 'string') {
      throw new Error('template_id (string) is required.');
    }
    const { data } = await this.httpClient.get(`/templates/${encodeURIComponent(template_id)}/settings-schema`);
    return data;
  }

  async listWidgets() {
    const { data } = await this.httpClient.get('/widgets');
    return data;
  }

  async listGridRowTypes() {
    const { data } = await this.httpClient.get('/grid/row-types');
    return data;
  }

  async listWidgetZones() {
    const { data } = await this.httpClient.get('/widget-zones');
    return data;
  }

  async listSearchZones() {
    const { data } = await this.httpClient.get('/search-zones');
    return data;
  }

  /**
   * Canonical search-field input slugs. Used by the MCP validator
   * (and assertSearchInputType pre-flight) to reject typos.
   *
   * Now delegates to the gk-gravityview/search-input-types-list
   * ability — the legacy `/gravityview/v1/search-fields/input-types`
   * route is gone post-Phase-5.
   */
  async listSearchFieldInputTypes() {
    const { data } = await this.httpClient.request({
      method:  'GET',
      baseURL: this.baseUrl,
      url:     '/wp-json/wp-abilities/v1/abilities/gk-gravityview/search-input-types-list/run',
    });
    return data;
  }

  async listForms() {
    const { data } = await this.httpClient.get('/forms');
    return data;
  }

  async getFieldTypeSchema({ field_type, template_id, context, input_type, form_id } = {}) {
    if (!field_type) throw new Error('field_type is required.');
    // Delegate to the gk-gravityview/field-type-schema-get ability.
    // Bracketed query params are how WP REST rebuilds an object from
    // a query string — `?input[field_type]=text&input[template_id]=...`.
    const params = {};
    for (const [k, v] of Object.entries({ field_type, template_id, context, input_type, form_id })) {
      if (v !== undefined) params[`input[${k}]`] = v;
    }
    const { data } = await this.httpClient.request({
      method:  'GET',
      baseURL: this.baseUrl,
      url:     '/wp-json/wp-abilities/v1/abilities/gk-gravityview/field-type-schema-get/run',
      params,
    });
    return data;
  }

  // ===================================================================
  // Reads (per view)
  // ===================================================================

  async getViewConfig({ id } = {}) {
    requireViewId(id);
    const response = await this.httpClient.get(`/views/${id}/config`);
    this.cacheVersion(id, response);
    return response.data;
  }

  async getViewAreas({ id } = {}) {
    requireViewId(id);
    const { data } = await this.httpClient.get(`/views/${id}/areas`);
    return data;
  }

  async listAvailableFields({ id } = {}) {
    requireViewId(id);
    const { data } = await this.httpClient.request({
      method:  'GET',
      baseURL: this.baseUrl,
      url:     '/wp-json/wp-abilities/v1/abilities/gk-gravityview/available-fields-get/run',
      params:  { 'input[id]': id },
    });
    return data;
  }

  async getViewFieldSchemas({ id } = {}) {
    requireViewId(id);
    const { data } = await this.httpClient.get(`/views/${id}/field-settings-schema`);
    return data;
  }

  async getFieldSettingsSchema({ id, area, slot } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    const { data } = await this.httpClient.get(
      `/views/${id}/fields/${encodeArea(area)}/${encodeURIComponent(slot)}/settings-schema`
    );
    return data;
  }

  async renderViewField({ id, area, slot, settings, staged_slot } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    // Server accepts both GET and POST.
    //
    // POST when the caller needs to ride staged state along WITHOUT
    // persisting:
    //   - `settings`     → overrides on an EXISTING saved slot.
    //   - `staged_slot`  → synthesizes a brand-new (unsaved) slot
    //                      from `{ field_id, label?, ...settings }`.
    //                      Required when the URL `slot` doesn't yet
    //                      exist in storage — without it the server
    //                      404s on read_slot().
    if (
      (settings && typeof settings === 'object') ||
      (staged_slot && typeof staged_slot === 'object')
    ) {
      const body = {};
      if (settings && typeof settings === 'object') body.settings = settings;
      if (staged_slot && typeof staged_slot === 'object') body.staged_slot = staged_slot;
      const { data } = await this.httpClient.post(
        `/views/${id}/fields/${encodeArea(area)}/${encodeURIComponent(slot)}/render`,
        body
      );
      return data;
    }
    const { data } = await this.httpClient.get(
      `/views/${id}/fields/${encodeArea(area)}/${encodeURIComponent(slot)}/render`
    );
    return data;
  }

  // ===================================================================
  // Create
  // ===================================================================

  async createView({
    title, form_id, template_id, template_ids, status,
    template_settings, search_criteria, fields, widgets, mode,
  } = {}) {
    if (!title || typeof title !== 'string') throw new Error('title is required.');
    if (!Number.isInteger(form_id) || form_id <= 0) throw new Error('form_id (positive integer) is required.');
    const payload = stripUndefined({
      title,
      form_id,
      template_id,
      template_ids,
      status,
      template_settings,
      search_criteria,
      fields,
      widgets,
      mode,
    });
    const response = await this.httpClient.post('/views', payload);
    this.cacheVersion(response.data?.view_id ?? response.data?.id, response);
    return response.data;
  }

  // ===================================================================
  // Bulk apply
  // ===================================================================

  async applyViewConfig({ id, template_id, template_ids, template_settings, search_criteria, fields, widgets, mode, ifMatch } = {}) {
    requireViewId(id);
    const payload = stripUndefined({ template_id, template_ids, template_settings, search_criteria, fields, widgets, mode });
    const response = await this.httpClient.post(`/views/${id}/config/_apply`, payload, this.ifMatchHeaders(id, ifMatch));
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Surgical writes — settings + template
  // ===================================================================

  async setViewTemplate({ id, template_id, zone, policy, ifMatch } = {}) {
    requireViewId(id);
    if (!template_id) throw new Error('template_id is required.');
    const payload = stripUndefined({ template_id, zone, policy });
    const response = await this.httpClient.patch(`/views/${id}/template`, payload, this.ifMatchHeaders(id, ifMatch));
    this.cacheVersion(id, response);
    return response.data;
  }

  async patchViewSettings({ id, template_settings, ifMatch } = {}) {
    requireViewId(id);
    if (!template_settings || typeof template_settings !== 'object') {
      throw new Error('template_settings (object) is required.');
    }
    const response = await this.httpClient.patch(`/views/${id}/template-settings`, template_settings, this.ifMatchHeaders(id, ifMatch));
    this.cacheVersion(id, response);
    return response.data;
  }

  async patchViewSearchCriteria({ id, search_criteria, ifMatch } = {}) {
    requireViewId(id);
    if (!search_criteria || typeof search_criteria !== 'object') {
      throw new Error('search_criteria (object) is required.');
    }
    const response = await this.httpClient.patch(`/views/${id}/search-criteria`, search_criteria, this.ifMatchHeaders(id, ifMatch));
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Surgical writes — fields
  // ===================================================================

  async addViewField({ id, area, field, ifMatch } = {}) {
    requireViewId(id);
    if (!area) throw new Error('area is required.');
    if (!field || typeof field !== 'object') throw new Error('field (object) is required.');
    if (!field.field_id) throw new Error('field.field_id is required.');
    const response = await this.httpClient.post(
      `/views/${id}/fields/${encodeArea(area)}/_slots`,
      field,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  async patchViewField({ id, area, slot, settings, ifMatch } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    if (!settings || typeof settings !== 'object') {
      throw new Error('settings (object) is required.');
    }
    const response = await this.httpClient.patch(
      `/views/${id}/fields/${encodeArea(area)}/${encodeURIComponent(slot)}`,
      settings,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  async moveViewField({ id, from, to, position, ifMatch } = {}) {
    requireViewId(id);
    if (!from?.area || !from?.slot) throw new Error('from { area, slot } is required.');
    if (!to?.area) throw new Error('to { area } is required.');
    // `to` may carry before_slot / after_slot for ref-relative
    // placement; the server resolves precedence (before > after >
    // position). `position` accepts "start" | "end" | integer.
    const payload = stripUndefined({ from, to, position });
    const response = await this.httpClient.post(`/views/${id}/fields/_move`, payload, this.ifMatchHeaders(id, ifMatch));
    this.cacheVersion(id, response);
    return response.data;
  }

  async removeViewField({ id, area, slot, ifMatch } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    const response = await this.httpClient.delete(
      `/views/${id}/fields/${encodeArea(area)}/${encodeURIComponent(slot)}`,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Grid (Layout Builder) row CRUD
  // ===================================================================

  /**
   * Add a Layout Builder grid row.
   *
   * @param {object} params
   * @param {number} params.id View id.
   * @param {string} [params.type='100'] Row type — see lookup_grid_row_type
   *   on the server. Common values: "100", "50/50", "33/66", "66/33",
   *   "33/33/33", "25/25/25/25", "25/25/50", "25/50/25", "50/25/25".
   * @param {string[]} [params.zones] Zones to materialise the row in.
   *   Defaults server-side to ["directory","single","edit"].
   */
  async addGridRow({ id, surface, type, zones, ifMatch } = {}) {
    requireViewId(id);
    const payload = stripUndefined({ surface, type, zones });
    const response = await this.httpClient.post(
      `/views/${id}/grid/_rows`,
      payload,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  /**
   * Re-key every field in a row from the old type to the new type. When
   * the new type has fewer columns, surplus fields collapse into the
   * first column.
   */
  async patchGridRow({ id, surface, row_uid, type, ifMatch } = {}) {
    requireViewId(id);
    if (!row_uid) throw new Error('row_uid is required.');
    if (!type) throw new Error('type is required.');
    const response = await this.httpClient.patch(
      `/views/${id}/grid/_rows/${encodeURIComponent(row_uid)}`,
      stripUndefined({ surface, type }),
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  /** Remove a grid row and every field placed in any of its areas. */
  async deleteGridRow({ id, surface, row_uid, ifMatch } = {}) {
    requireViewId(id);
    if (!row_uid) throw new Error('row_uid is required.');
    // axios.delete requires `data` inside the config to send a body.
    const config = this.ifMatchHeaders(id, ifMatch) || {};
    if (surface) config.data = { surface };
    const response = await this.httpClient.delete(
      `/views/${id}/grid/_rows/${encodeURIComponent(row_uid)}`,
      config
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Search Bar internal slot CRUD (modern shape only)
  // ===================================================================

  async addSearchField({ id, widget_area, widget_slot, position, field, slot, ifMatch } = {}) {
    requireViewId(id);
    if (!widget_area || !widget_slot) throw new Error('widget_area and widget_slot are required.');
    if (!position) throw new Error('position is required (e.g. "search-general_top::100::ROW_UID").');
    if (!field || typeof field !== 'object' || !field.id) {
      throw new Error('field must be an object with at least an `id` (e.g. "search_all", "submit", or a GF field id).');
    }
    await this.assertSearchInputType(field.input ?? field.input_type);
    const response = await this.httpClient.post(
      `/views/${id}/search-fields/_slots`,
      stripUndefined({ widget_area, widget_slot, position, field, slot }),
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  /**
   * Pre-flight check for `field.input` / `settings.input` values
   * passed to addSearchField / patchSearchField. Fetches the
   * canonical input-type list once per session and throws a clear
   * error before the network round trip when the caller supplies
   * an unknown slug. The server enforces the same allow-list as a
   * safety net — this just gives the agent a faster, more useful
   * error message ("Unknown search input 'datepiker' — did you
   * mean 'date_range'?") than a generic 400.
   *
   * @param {string|undefined} input
   * @returns {Promise<void>}
   */
  async assertSearchInputType(input) {
    const value = String(input ?? '').trim();
    if (value === '') return; // no input → server defaults; nothing to validate
    if (!this._searchInputTypes) {
      try {
        const data = this._searchInputTypesPromise
          || (this._searchInputTypesPromise = this.listSearchFieldInputTypes());
        const resolved = await data;
        this._searchInputTypes = new Set(Array.isArray(resolved?.input_types) ? resolved.input_types : []);
      } catch (_) {
        // Discovery failed (older plugin, network blip) — degrade
        // to permissive; the server still rejects on write.
        this._searchInputTypes = null;
        this._searchInputTypesPromise = null;
        return;
      }
    }
    if (this._searchInputTypes && this._searchInputTypes.size > 0 && !this._searchInputTypes.has(value)) {
      const known = [...this._searchInputTypes].sort().join(', ');
      throw new Error(`Unknown search field input "${value}". Valid types: ${known}.`);
    }
  }

  async patchSearchField({ id, widget_area, widget_slot, position, search_slot, settings, ifMatch } = {}) {
    requireViewId(id);
    if (!widget_area || !widget_slot) throw new Error('widget_area and widget_slot are required.');
    if (!position) throw new Error('position is required.');
    if (!search_slot) throw new Error('search_slot is required.');
    if (!settings || typeof settings !== 'object') throw new Error('settings must be an object.');
    await this.assertSearchInputType(settings.input ?? settings.input_type);
    const response = await this.httpClient.patch(
      `/views/${id}/search-fields/${encodeURIComponent(search_slot)}`,
      { widget_area, widget_slot, position, settings },
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  async removeSearchField({ id, widget_area, widget_slot, position, search_slot, ifMatch } = {}) {
    requireViewId(id);
    if (!widget_area || !widget_slot || !position || !search_slot) {
      throw new Error('widget_area, widget_slot, position, and search_slot are required.');
    }
    const config = this.ifMatchHeaders(id, ifMatch) || {};
    config.data = { widget_area, widget_slot, position };
    const response = await this.httpClient.delete(
      `/views/${id}/search-fields/${encodeURIComponent(search_slot)}`,
      config
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Surgical writes — widgets
  // ===================================================================

  async addViewWidget({ id, area, widget, ifMatch } = {}) {
    requireViewId(id);
    if (!area) throw new Error('area is required.');
    if (!widget || typeof widget !== 'object') throw new Error('widget (object) is required.');
    if (!widget.field_id) throw new Error('widget.field_id is required (use the widget id, e.g. "search_bar").');
    const response = await this.httpClient.post(
      `/views/${id}/widgets/${encodeURIComponent(area)}/_slots`,
      widget,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  async patchViewWidget({ id, area, slot, settings, ifMatch } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    if (!settings || typeof settings !== 'object') {
      throw new Error('settings (object) is required.');
    }
    const response = await this.httpClient.patch(
      `/views/${id}/widgets/${encodeURIComponent(area)}/${encodeURIComponent(slot)}`,
      settings,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  async removeViewWidget({ id, area, slot, ifMatch } = {}) {
    requireViewId(id);
    requireAreaSlot(area, slot);
    const response = await this.httpClient.delete(
      `/views/${id}/widgets/${encodeURIComponent(area)}/${encodeURIComponent(slot)}`,
      this.ifMatchHeaders(id, ifMatch)
    );
    this.cacheVersion(id, response);
    return response.data;
  }

  // ===================================================================
  // Internals
  // ===================================================================

  cacheVersion(viewId, response) {
    if (!viewId) return;
    const tag = response?.headers?.etag || response?.headers?.ETag;
    let version;
    if (typeof tag === 'string') {
      version = tag.replace(/^"(.*)"$/, '$1');
    } else if (response?.data?.version) {
      version = String(response.data.version);
    }
    if (version) {
      this.versionCache.set(Number(viewId), version);
    }
  }

  ifMatchHeaders(viewId, ifMatch) {
    if (!ifMatch) return undefined;
    const value = ifMatch === 'auto' ? this.versionCache.get(Number(viewId)) : ifMatch;
    if (!value) {
      logger.warn(`If-Match: 'auto' requested but no cached version for view ${viewId} — skipping precondition.`);
      return undefined;
    }
    const quoted = /^".*"$/.test(value) ? value : `"${value}"`;
    return { headers: { 'If-Match': quoted } };
  }
}

function requireViewId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('id (positive integer view id) is required.');
  }
}

function requireAreaSlot(area, slot) {
  if (!area) throw new Error('area is required.');
  if (!slot) throw new Error('slot is required.');
}

function encodeArea(area) {
  // Layout-builder areas embed `::` separators (which the server's
  // route regex covers either as `::` or `%3A%3A`) AND `/` glyphs
  // inside row-type names (`50/50`, `33/33/33`, `25/25/25/25`). The
  // `/` MUST be percent-encoded — leaving it literal makes WordPress
  // treat it as a path separator and the route stops matching the
  // intended segment, fatal-404ing /render and similar endpoints.
  return encodeURIComponent(String(area)).replace(/%3A%3A/g, '::');
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export default GravityViewInspectorClient;
