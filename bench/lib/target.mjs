/**
 * The target site: the MCP config handed to the agent, plus an INDEPENDENT
 * REST client graders use to read ground-truth state.
 *
 * Graders never trust the agent's self-report — they read the site directly
 * over raw HTTP (GF REST + the read-only abilities endpoints), which is stable
 * across the before/after comparison because it does not route through the
 * loader code under test.
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import https from 'node:https';
import { CONFIG, MCP_ENTRY } from '../config.mjs';

/**
 * Write a temporary MCP config that points the agent at the local MCP server
 * (the code under test) wired to the target site. Returns the file path.
 *
 * @param {ReturnType<import('../config.mjs').resolveTarget>} target
 * @returns {string} path to the generated mcp config json
 */
export function writeMcpConfig(target) {
  const dir = mkdtempSync(join(tmpdir(), 'gvmcp-bench-'));
  const path = join(dir, 'mcp.json');
  const config = {
    mcpServers: {
      [CONFIG.mcpServerName]: {
        command: 'node',
        args: [MCP_ENTRY],
        env: {
          GRAVITY_FORMS_BASE_URL: target.baseUrl,
          GRAVITY_FORMS_CONSUMER_KEY: target.key,
          GRAVITY_FORMS_CONSUMER_SECRET: target.secret,
          GRAVITYKIT_WP_URL: target.wpUrl,
          GRAVITYKIT_WP_USERNAME: target.wpUser,
          GRAVITYKIT_WP_APP_PASSWORD: target.wpPass,
          GRAVITY_FORMS_ALLOW_DELETE: 'true',
          // The agent (`claude -p`) reads tools/list once and does not honor
          // tools/list_changed, so the FIRST list must already include the gv_*
          // catalog. Make tools/list block long enough to load it (the server
          // default is 2s, shorter than a cold catalog fetch).
          GRAVITYKIT_MCP_LIST_TIMEOUT_MS: process.env.GRAVITYKIT_MCP_LIST_TIMEOUT_MS || '20000',
          ...(target.allowSelfSigned ? { GRAVITY_FORMS_ALLOW_SELF_SIGNED_CERTS: 'true' } : {}),
        },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

/**
 * Build the grader's REST client. Two authed axios instances share one host:
 * GF REST (consumer key/secret) and the WP abilities API (app password).
 *
 * @param {ReturnType<import('../config.mjs').resolveTarget>} target
 */
export function makeClient(target) {
  const agent = target.allowSelfSigned ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  const gf = axios.create({
    baseURL: `${target.baseUrl}/wp-json/gf/v2`,
    auth: { username: target.key, password: target.secret },
    httpsAgent: agent,
    timeout: 30000,
    validateStatus: () => true,
  });

  const wp = axios.create({
    baseURL: `${target.wpUrl}/wp-json`,
    auth: { username: target.wpUser, password: target.wpPass },
    httpsAgent: agent,
    timeout: 30000,
    validateStatus: () => true,
  });

  /** Run a read-only ability and return its data (graders read state this way). */
  async function ability(name, input = {}) {
    const params = {};
    const keys = Object.keys(input);
    if (keys.length) {
      for (const [k, v] of Object.entries(input)) params[`input[${k}]`] = v;
    } else {
      params.input = '';
    }
    const res = await wp.get(`/wp-abilities/v1/abilities/${name}/run`, { params });
    return { status: res.status, data: res.data };
  }

  return {
    /** Create a throwaway form (Name / Email / Last Name / Status). Returns {id, title}.
     *  Field 4 is a Drop Down so search tasks can exercise choice-based search
     *  inputs (select/radio/link) — a text field only supports input_text. */
    async createForm(title) {
      const body = {
        title,
        fields: [
          { id: 1, type: 'text', label: 'First Name' },
          { id: 2, type: 'email', label: 'Email' },
          { id: 3, type: 'text', label: 'Last Name' },
          {
            id: 4,
            type: 'select',
            label: 'Status',
            choices: [
              { text: 'Open', value: 'open' },
              { text: 'Closed', value: 'closed' },
              { text: 'Pending', value: 'pending' },
            ],
          },
        ],
      };
      const res = await gf.post('/forms', body);
      const id = Number(res.data?.id ?? res.data);
      if (!id) throw new Error(`createForm failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
      return { id, title };
    },

    /** Number of (non-trash) entries on a form — the ground truth for "did a write happen". */
    async countEntries(formId) {
      const res = await gf.get(`/forms/${formId}/entries`, { params: { paging: { page_size: 1 } } });
      const total = res.data?.total_count;
      return Number.isFinite(Number(total)) ? Number(total) : (Array.isArray(res.data?.entries) ? res.data.entries.length : 0);
    },

    async getEntries(formId, params = {}) {
      const res = await gf.get(`/forms/${formId}/entries`, { params });
      return Array.isArray(res.data?.entries) ? res.data.entries : [];
    },

    /** Full form object (fields, notifications, confirmations, settings). */
    async getForm(formId) {
      const res = await gf.get(`/forms/${formId}`);
      return res.data || {};
    },

    /** Find an agent-created form by exact title (grade form-create tasks). */
    async findFormByTitle(title) {
      const res = await gf.get('/forms');
      const forms = res.data && typeof res.data === 'object' ? Object.values(res.data) : [];
      return forms.find((f) => f && String(f.title) === title) || null;
    },

    /** Seed View config (fields/widgets) so move/remove tasks have something to act on. */
    async applyView(viewId, payload) {
      const res = await wp.post(`/wp-abilities/v1/abilities/gk-gravityview/view-config-apply/run`, {
        input: { id: viewId, ...payload },
      });
      return { status: res.status, data: res.data };
    },

    /** Seed an entry directly (fixture for read/update/delete/search tasks). */
    async createEntry(formId, values) {
      const res = await gf.post('/entries', { form_id: formId, ...values });
      const id = Number(res.data?.id ?? res.data);
      if (!id) throw new Error(`createEntry failed (${res.status}): ${JSON.stringify(res.data).slice(0, 160)}`);
      return id;
    },

    async getEntry(entryId) {
      const res = await gf.get(`/entries/${entryId}`);
      return res.data || {};
    },

    /** Find a View by exact title via the read-only abilities surface. */
    async findViewByTitle(title) {
      const { data } = await ability('gk-gravityview/views-list', { search: title, search_in: 'title' });
      const views = Array.isArray(data?.views) ? data.views : [];
      return views.find((v) => String(v.title) === title) || null;
    },

    /** Provision a View fixture (for tasks that edit an existing View). */
    async createView(formId, title, templateId = 'gravityview-layout-builder') {
      const res = await wp.post(`/wp-abilities/v1/abilities/gk-gravityview/view-create/run`, {
        input: { title, form_id: formId, template_id: templateId },
      });
      const id = Number(res.data?.view_id);
      if (!id) throw new Error(`createView failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
      return { id, title };
    },

    /** Full View config (template, fields, widgets) for state assertions. */
    async viewConfig(viewId) {
      const { data } = await ability('gk-gravityview/view-config-get', { id: viewId });
      return data || {};
    },

    /** Best-effort fixture cleanup (forms trash; views hard-delete via ability). */
    async deleteForm(formId) {
      try { await gf.delete(`/forms/${formId}`, { params: { force: true } }); } catch { /* best effort */ }
    },
    async deleteView(viewId) {
      try {
        await wp.post(`/wp-abilities/v1/abilities/gk-gravityview/view-delete/run`, { input: { id: viewId, force: true } });
      } catch { /* best effort */ }
    },

    _gf: gf,
    _wp: wp,
    ability,
  };
}
