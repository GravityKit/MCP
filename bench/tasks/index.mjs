/**
 * Task registry — the whole flow. Each task maps to a behavior a SMALL model
 * must handle cleanly via the MCP; most also guard a specific contract change.
 *
 * Coverage:
 *   discovery      list / scan / layouts (empty-input + scalar-status)
 *   forms          form + field CRUD, notifications, confirmations
 *   entries        create/submit/validate (entries.mjs) + read/search/update/delete (entries-crud.mjs)
 *   authoring      seeded View creation
 *   views          View settings / status / duplicate / delete
 *   view-fields    field add / settings / reorder / remove
 *   view-widgets   widget add / remove
 *   search         search-bar field add / configure
 *   grid           Layout Builder grid-row add / populate
 */

import discovery from './discovery.mjs';
import forms from './forms.mjs';
import entries from './entries.mjs';
import entriesCrud from './entries-crud.mjs';
import authoring from './authoring.mjs';
import views from './views.mjs';
import viewFields from './view-fields.mjs';
import viewWidgets from './view-widgets.mjs';
import search from './search.mjs';
import grid from './grid.mjs';

export const TASKS = [
  ...discovery,
  ...forms,
  ...entries,
  ...entriesCrud,
  ...authoring,
  ...views,
  ...viewFields,
  ...viewWidgets,
  ...search,
  ...grid,
];
