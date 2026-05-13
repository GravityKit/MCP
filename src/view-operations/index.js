/**
 * GravityView Inspector tool surface for the GravityKit MCP.
 *
 * Exports:
 *   - createViewOperations(client) → { manager, validator }
 *   - viewToolDefinitions          → JSON Schema for every gv_* tool
 *   - viewToolHandlers             → { tool_name: async (params, ctx) => result }
 *
 * Handlers run client-side validation BEFORE calling the REST API
 * so structural mistakes fail with a useful error instead of a 400.
 * Schema-aware validation is gated on `validateAgainstSchemas: true`
 * because each unique field type costs one network round trip.
 */

import { ViewValidator } from './view-validator.js';

// Shared compact arg used by every tool — mirrors the gf_* convention.
const COMPACT_ARG = {
  compact: { type: 'boolean', description: 'Set false for full raw response data', default: true },
};

// Reusable arg shapes.
const VIEW_ID = { type: 'integer', description: 'GravityView post id' };
const AREA = {
  type: 'string',
  description: 'Area key in the form `{zone}_{areaid}` (e.g. directory_list-title). Layout Builder templates append `::cols::row_uid` for compound keys.',
};
const SLOT = {
  type: 'string',
  description: 'Slot UID (UUID v4 for new slots; legacy slots may use 13-char MD5 hex).',
};
const IF_MATCH = {
  type: 'string',
  description: 'Optional optimistic-concurrency token. Pass the `version` from a previous read, or "auto" to use the client-cached version. Server returns 412 on stale.',
};

export function createViewOperations(client) {
  const validator = new ViewValidator(client);
  return { client, validator };
}

export const viewToolDefinitions = [
  // -------------------------------------------------------------- Discovery
  {
    name: 'gv_list_templates',
    description: 'List every installed GravityView layout template (id, slug, label, description, logo). Use to discover valid template_id values before creating or switching a View.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_list_widgets',
    description: 'List every registered GravityView widget (id, label, description, icon, class). Use to discover valid widget ids before placing one with gv_add_view_widget. Sourced live from \\GV\\Widget::registered() so third-party widgets surface automatically.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_list_grid_row_types',
    description: 'List every registered Layout Builder row type (100, 50/50, 33/66, 33/33/33, 25/25/25/25, …) with their column structure. Use to discover valid `type` values before calling gv_create_grid_row. Sourced live from \\GV\\Grid::get_row_types() so add-on row layouts surface automatically.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_list_widget_zones',
    description: 'List the widget meta-zones (header, footer). Use as the `zones` param for surface=widgets grid CRUD. Note: visible zone names like "header_top" / "header_left" are zone+column combinations — pick the meta-zone here, then the row type determines the columns.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_list_search_zones',
    description: 'List the Search Bar internal zones (search-general, search-advanced). Filterable via `gk/gravityview/rest/search-zones` for add-ons.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_list_view_forms',
    description: 'List Gravity Forms forms exposed via the GravityView Inspector REST surface. Lighter than gf_list_forms (returns just id/title/fields count). For full form details use gf_get_form.',
    inputSchema: { type: 'object', properties: { ...COMPACT_ARG } },
  },
  {
    name: 'gv_get_field_type_schema',
    description: 'Get the settings schema for a GravityView field type (e.g. "custom", "entry_link", "text"). No View id required — useful for AI agents authoring a fresh View.',
    inputSchema: {
      type: 'object',
      properties: {
        field_type: { type: 'string', description: 'Field type slug (e.g. "custom", "entry_link"). For form-bound fields (numeric ids), use gv_get_view_field_schemas instead.' },
        template_id: { type: 'string', description: 'Optional layout template id; affects which settings the schema includes. Defaults to default_list.' },
        context: { type: 'string', enum: ['multiple', 'single', 'edit', 'search'], description: 'Render context. Defaults to multiple.' },
        input_type: { type: 'string', description: 'Optional GF input type (textarea, select, …) for form-bound fields.' },
        form_id: { type: 'integer', description: 'Optional form id for input-type detection.' },
        ...COMPACT_ARG,
      },
      required: ['field_type'],
    },
  },

  // --------------------------------------------------------------- Per-view reads
  {
    name: 'gv_get_view_config',
    description: 'Read the full View configuration tree (template, fields, widgets, template_settings, search_criteria, version). Returns the version that subsequent writes can pass via ifMatch.',
    inputSchema: { type: 'object', properties: { id: VIEW_ID, ...COMPACT_ARG }, required: ['id'] },
  },
  {
    name: 'gv_get_view_areas',
    description: 'Inventory of zones (directory / single / edit) and area ids the View\'s template exposes. Tells you the valid `area` keys for adding/moving fields.',
    inputSchema: { type: 'object', properties: { id: VIEW_ID, ...COMPACT_ARG }, required: ['id'] },
  },
  {
    name: 'gv_list_available_fields',
    description: 'Form fields placeable into the View, plus GravityView meta-fields (custom content, entry link, edit link, etc.). Use the returned ids as `field_id` when adding fields.',
    inputSchema: { type: 'object', properties: { id: VIEW_ID, ...COMPACT_ARG }, required: ['id'] },
  },
  {
    name: 'gv_get_view_field_schemas',
    description: 'Bulk schema for every CONFIGURED slot in the View — `{area/slot}` → settings schema. One call instead of N gv_get_field_type_schema calls.',
    inputSchema: { type: 'object', properties: { id: VIEW_ID, ...COMPACT_ARG }, required: ['id'] },
  },
  {
    name: 'gv_render_view_field',
    description: 'Render a single configured slot to HTML. Pass `settings` to preview an in-flight settings change WITHOUT persisting (server renders in-memory). Use to verify a format/conditional-logic change before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        area: AREA,
        slot: SLOT,
        settings: { type: 'object', description: 'Optional staged settings overrides. Persists nothing.' },
        ...COMPACT_ARG,
      },
      required: ['id', 'area', 'slot'],
    },
  },

  // --------------------------------------------------------------- Create
  {
    name: 'gv_create_view',
    description: 'Create a draft GravityView View, optionally seeded with template settings + fields + widgets in one shot. Returns the full config envelope (including `view_id`, `version`, and `admin_url`) so no follow-up GET is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'View title (post title).' },
        form_id: { type: 'integer', description: 'Source Gravity Forms form id. Use gf_list_forms to discover.' },
        template_id: { type: 'string', description: 'Layout template for the directory zone (Multiple Entries listing). Defaults to gravityview-layout-builder. Use gv_list_templates for the catalogue.' },
        template_ids: {
          type: 'object',
          description: 'Optional per-zone template overrides — { single?, edit? }. Multiple Entries (directory) and Single Entry can use different layouts (e.g. directory: gravityview-layout-builder, single: default_table). Single defaults to directory; edit follows directory unless explicitly set.',
        },
        status: { type: 'string', enum: ['draft', 'publish', 'pending', 'private'], description: 'Initial post status. Defaults to draft.' },
        template_settings: { type: 'object', description: 'Optional initial template_settings (page_size, lightbox, etc.).' },
        search_criteria: { type: 'object', description: 'Optional initial search_criteria (sort, pagination defaults).' },
        fields: { type: 'object', description: 'Optional initial field tree, keyed by area key. Each value is an ordered array of `{ field_id, label?, slot?, …settings }` objects.' },
        widgets: { type: 'object', description: 'Optional initial widget tree (same shape as fields).' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: 'Apply mode for fields/widgets. Default: replace.' },
        validateAgainstSchemas: { type: 'boolean', description: 'When true, fetches each referenced field type\'s schema and rejects unknown setting keys before sending. Costs extra round trips. Default: false.' },
        ...COMPACT_ARG,
      },
      required: ['title', 'form_id'],
    },
  },

  // --------------------------------------------------------------- Bulk apply
  {
    name: 'gv_apply_view_config',
    description: 'Bulk apply template + settings + ordered fields + widgets to an existing View in one round trip. Server-side mode: replace (default — each area in payload replaces existing area) or merge (additive). Pass ifMatch to enforce optimistic concurrency.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        template_id: { type: 'string', description: 'Switch the directory-zone template before applying fields/widgets. Equivalent to gv_set_view_template (zone=directory) + the apply.' },
        template_ids: {
          type: 'object',
          description: 'Optional per-zone template overrides — { single?, edit? }. Same shape as gv_create_view. Pass an empty string for a zone to clear its override (falls back to directory).',
        },
        template_settings: { type: 'object', description: 'Partial-merge into template_settings.' },
        search_criteria: { type: 'object', description: 'Pagination + sort defaults. Persisted into template_settings.' },
        fields: { type: 'object', description: 'Ordered field arrays per area key.' },
        widgets: { type: 'object', description: 'Ordered widget arrays per area key.' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace = each area in fields/widgets replaces existing. merge = additive. Default: replace.' },
        ifMatch: IF_MATCH,
        validateAgainstSchemas: { type: 'boolean', description: 'When true, fetches each referenced field type\'s schema and rejects unknown setting keys before sending. Default: false.' },
        ...COMPACT_ARG,
      },
      required: ['id'],
    },
  },

  // --------------------------------------------------------------- Surgical settings + template
  {
    name: 'gv_set_view_template',
    description: 'Switch a View zone\'s layout template. The directory zone (Multiple Entries) is the default; pass `zone: "single"` for Single Entry or `zone: "edit"` for Edit Entry. Discard policy controls whether the affected zone\'s existing field/widget placements survive the switch.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        template_id: { type: 'string', description: 'New template id. Use gv_list_templates to discover.' },
        zone: { type: 'string', enum: ['directory', 'single', 'edit'], description: 'Zone to switch. Defaults to directory.' },
        policy: { type: 'string', enum: ['discard', 'keep'], description: 'discard (default) clears the zone\'s field+widget placements so they don\'t reference the old template\'s areas; keep preserves them at the risk of orphan placements.' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'template_id'],
    },
  },
  {
    name: 'gv_patch_view_settings',
    description: 'Partial-merge into template_settings (page_size, lightbox, show_only_approved, etc.). Other settings preserved.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, template_settings: { type: 'object' }, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'template_settings'],
    },
  },
  {
    name: 'gv_patch_view_search_criteria',
    description: 'Partial-merge into search_criteria (sort_field, sort_direction, page_size). Persisted into template_settings.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, search_criteria: { type: 'object' }, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'search_criteria'],
    },
  },

  // --------------------------------------------------------------- Surgical field ops
  {
    name: 'gv_add_view_field',
    description: 'Add a single field slot to an area. Server mints the slot UID and returns it. For multi-field changes prefer gv_apply_view_config with mode=merge.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        area: AREA,
        field: {
          type: 'object',
          description: '{ field_id (required), label?, custom_label?, …settings }',
          required: ['field_id'],
        },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'area', 'field'],
    },
  },
  {
    name: 'gv_patch_view_field',
    description: 'Patch a single field slot\'s settings. Only keys present in `settings` are updated; rest preserved. Use for cosmetic edits (custom_label, custom_class) and per-field options (show_label, only_loggedin, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, area: AREA, slot: SLOT, settings: { type: 'object' }, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'area', 'slot', 'settings'],
    },
  },
  {
    name: 'gv_move_view_field',
    description: 'Move a field across areas, or reorder within the same area. The moved slot keeps its UID. Placement precedence in `to`: `before_slot` > `after_slot` > `position`. Use ref-relative placement ("place this field BEFORE the Title") instead of counting positions when possible — slot UIDs are stable across other moves.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        from: { type: 'object', properties: { area: AREA, slot: SLOT }, required: ['area', 'slot'] },
        to: {
          type: 'object',
          properties: {
            area: AREA,
            before_slot: { type: 'string', description: 'Insert immediately BEFORE this slot UID (preferred when known).' },
            after_slot: { type: 'string', description: 'Insert immediately AFTER this slot UID.' },
          },
          required: ['area'],
        },
        position: { description: 'Symbolic ("start" | "end") or zero-based integer. Defaults to "end". Negative integers append. Ignored when before_slot / after_slot is set.' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'from', 'to'],
    },
  },
  {
    name: 'gv_remove_view_field',
    description: 'Delete a single field slot. Requires GRAVITYVIEW_ALLOW_DELETE=true (or GRAVITY_FORMS_ALLOW_DELETE=true) in the MCP env to guard against accidents.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, area: AREA, slot: SLOT, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'area', 'slot'],
    },
  },

  // --------------------------------------------------------------- Surgical widget ops
  {
    name: 'gv_add_view_widget',
    description: 'Add a single widget slot to a widget area. Use gv_list_widgets to discover valid widget.field_id values (search_bar, page_links, page_info, custom_content, poll, gravityforms, etc.). For widget-specific settings, fetch gv_get_field_type_schema with the widget id (e.g. search_bar returns search_layout, search_fields, search_clear, search_mode, sieve_choices).',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        area: { type: 'string', description: 'Widget area key. Fixed list across templates: header_top, header_bottom, header_left, header_right, footer_top, footer_bottom, footer_left, footer_right.' },
        widget: { type: 'object', required: ['field_id'] },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'area', 'widget'],
    },
  },
  {
    name: 'gv_patch_view_widget',
    description: 'Patch a single widget slot\'s settings.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, area: { type: 'string' }, slot: SLOT, settings: { type: 'object' }, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'area', 'slot', 'settings'],
    },
  },
  {
    name: 'gv_remove_view_widget',
    description: 'Delete a single widget slot. Requires GRAVITYVIEW_ALLOW_DELETE=true.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, area: { type: 'string' }, slot: SLOT, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'area', 'slot'],
    },
  },

  // --------------------------------------------------------------- Grid (any surface)
  {
    name: 'gv_create_grid_row',
    description: 'Add a grid row to one of the View\'s grid surfaces. surface=fields (default) targets the View\'s main field tree per zone (directory|single, prefixed by per-zone Layout Builder template). surface=widgets targets header / footer widget zones. Returns the new row_uid + materialised areaids per zone — use those areaids when placing fields/widgets via gv_apply_view_config. Use gv_list_grid_row_types for valid `type` values; gv_list_widget_zones for widget meta-zones.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        surface: { type: 'string', enum: ['fields', 'widgets'], description: 'fields = View main field tree (default). widgets = header/footer widget zones.' },
        type: { type: 'string', description: 'Row type. Defaults to "100" (full width). Use gv_list_grid_row_types to discover the live catalogue (100, 50/50, 33/66, 33/33/33, 25/25/25/25, …).' },
        zones: { type: 'array', description: 'Zones to materialise the row in. surface=fields default: [directory, single]. surface=widgets default: [header, footer].', items: { type: 'string' } },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id'],
    },
  },
  {
    name: 'gv_patch_grid_row',
    description: 'Re-key every field/widget in a grid row from one type to another (e.g. resize 100 → 50/50, or 33/33/33 → 50/50). When the new type has fewer columns, surplus items collapse into the first column rather than vanishing. Pass the same `surface` you used to create the row.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        surface: { type: 'string', enum: ['fields', 'widgets'], description: 'Defaults to fields.' },
        row_uid: { type: 'string', description: 'Row UID returned by gv_create_grid_row or visible in gv_get_view_areas response.' },
        type: { type: 'string', description: 'New row type (see gv_list_grid_row_types).' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'row_uid', 'type'],
    },
  },
  {
    name: 'gv_delete_grid_row',
    description: 'Remove a grid row and every field/widget placed in any of its areas on the targeted surface. Requires GRAVITYVIEW_ALLOW_DELETE=true.',
    inputSchema: {
      type: 'object',
      properties: { id: VIEW_ID, surface: { type: 'string', enum: ['fields', 'widgets'] }, row_uid: { type: 'string' }, ifMatch: IF_MATCH, ...COMPACT_ARG },
      required: ['id', 'row_uid'],
    },
  },

  // --------------------------------------------------------------- Search Bar internal slot CRUD (modern shape)
  {
    name: 'gv_add_search_field',
    description: 'Add a Search Field inside a search_bar widget\'s modern search_fields_section. Identify the parent widget via widget_area + widget_slot (find them with gv_get_view_config; widget_area is a key under `widgets`, widget_slot is the search_bar\'s slot UID). The position string is `{search_zone}_{areaid}::{type}::{row_uid}` — get search_zone from gv_list_search_zones, build a row_uid + type via gv_create_grid_row (surface=widgets) if needed.\n\nfield.id options: "search_all" (free text), "submit", "search_mode", "created_by", "is_starred", "is_read", or a GF field id (e.g. "3"). field.input: input_text, select, multiselect, radio, checkbox, single_checkbox, date, date_range, number_range, link, hidden, submit. Use gv_get_field_type_schema with the search_field type for the full settings catalogue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        widget_area: { type: 'string', description: 'Widget area key (e.g. "header_top::100::ROW_UID").' },
        widget_slot: { type: 'string', description: 'Search bar widget\'s slot UID.' },
        position: { type: 'string', description: 'Search-bar internal position: `{search_zone}_{areaid}::{type}::{row_uid}`.' },
        field: {
          type: 'object',
          description: '{ id (required), type, input, label?, show_label?, ...settings }',
          required: ['id'],
        },
        slot: { type: 'string', description: 'Optional search slot UID. Auto-minted when omitted.' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'widget_area', 'widget_slot', 'position', 'field'],
    },
  },
  {
    name: 'gv_patch_search_field',
    description: 'Patch settings on an existing search field slot. Settings keys present in the payload overwrite; null values delete that key.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        widget_area: { type: 'string' },
        widget_slot: { type: 'string' },
        position: { type: 'string' },
        search_slot: { type: 'string' },
        settings: { type: 'object' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'widget_area', 'widget_slot', 'position', 'search_slot', 'settings'],
    },
  },
  {
    name: 'gv_remove_search_field',
    description: 'Remove a search field slot from a search_bar widget\'s search_fields_section. Requires GRAVITYVIEW_ALLOW_DELETE=true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: VIEW_ID,
        widget_area: { type: 'string' },
        widget_slot: { type: 'string' },
        position: { type: 'string' },
        search_slot: { type: 'string' },
        ifMatch: IF_MATCH,
        ...COMPACT_ARG,
      },
      required: ['id', 'widget_area', 'widget_slot', 'position', 'search_slot'],
    },
  },
];

/**
 * Build the handler map. Returns `{ tool_name: async (params) => raw_result }`.
 * The MCP transport layer handles compaction + content envelope wrapping.
 */
export function buildViewToolHandlers({ client, validator }) {
  return {
    // Discovery
    gv_list_templates: () => client.listTemplates(),
    gv_list_widgets: () => client.listWidgets(),
    gv_list_grid_row_types: () => client.listGridRowTypes(),
    gv_list_widget_zones: () => client.listWidgetZones(),
    gv_list_search_zones: () => client.listSearchZones(),
    gv_list_view_forms: () => client.listForms(),
    gv_get_field_type_schema: (params) => client.getFieldTypeSchema(params),

    // Reads
    gv_get_view_config: (params) => client.getViewConfig(params),
    gv_get_view_areas: (params) => client.getViewAreas(params),
    gv_list_available_fields: (params) => client.listAvailableFields(params),
    gv_get_view_field_schemas: (params) => client.getViewFieldSchemas(params),
    gv_render_view_field: (params) => client.renderViewField(params),

    // Create
    gv_create_view: async (params) => {
      validator.validateCreatePayload(params);
      if (params.validateAgainstSchemas) {
        await validator.validateAgainstSchemas({
          fields: params.fields || {},
          widgets: params.widgets || {},
          template_id: params.template_id,
        });
      }
      // Layout Builder area validation skipped on create — the View
      // doesn't exist yet, so its grid hasn't been materialised.
      const { validateAgainstSchemas, compact, ...payload } = params;
      return client.createView(payload);
    },

    // Bulk apply
    gv_apply_view_config: async (params) => {
      validator.validateApplyPayload(params);
      if (params.validateAgainstSchemas) {
        await validator.validateAgainstSchemas({
          fields: params.fields || {},
          widgets: params.widgets || {},
          template_id: params.template_id,
        });
      }
      // Layout Builder area validation: when any of the area keys
      // contain `::` (the Layout Builder compound form), confirm
      // they exist in the View's current grid before sending.
      // Cheap (one extra GET) and saves a 400 round trip on typos.
      await validator.validateLayoutBuilderAreas({
        id: params.id,
        fields: params.fields || {},
        widgets: params.widgets || {},
      });
      const { validateAgainstSchemas, compact, ...payload } = params;
      return client.applyViewConfig(payload);
    },

    // Surgical settings + template
    gv_set_view_template: (params) => client.setViewTemplate(params),
    gv_patch_view_settings: (params) => client.patchViewSettings(params),
    gv_patch_view_search_criteria: (params) => client.patchViewSearchCriteria(params),

    // Surgical field ops
    gv_add_view_field: (params) => client.addViewField(params),
    gv_patch_view_field: (params) => client.patchViewField(params),
    gv_move_view_field: (params) => client.moveViewField(params),
    gv_remove_view_field: (params) => client.removeViewField(params),

    // Surgical widget ops
    gv_add_view_widget: (params) => client.addViewWidget(params),
    gv_patch_view_widget: (params) => client.patchViewWidget(params),
    gv_remove_view_widget: (params) => client.removeViewWidget(params),

    // Grid CRUD (any surface — fields | widgets)
    gv_create_grid_row: (params) => client.addGridRow(params),
    gv_patch_grid_row: (params) => client.patchGridRow(params),
    gv_delete_grid_row: (params) => client.deleteGridRow(params),

    // Search Bar internal slot CRUD (modern shape)
    gv_add_search_field: (params) => client.addSearchField(params),
    gv_patch_search_field: (params) => client.patchSearchField(params),
    gv_remove_search_field: (params) => client.removeSearchField(params),
  };
}

export { ViewValidator };
