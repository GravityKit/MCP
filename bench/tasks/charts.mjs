/**
 * GravityCharts tasks — can a SMALL model create, configure, and manage
 * *meaningful* charts through the GravityCharts abilities (gc_*)?
 *
 * The suite covers the full surface, not just the happy path:
 *   - discovery (chart types)
 *   - creation: bare, count-per-category, pie, horizontal, custom color/label
 *   - aggregation: sum of a numeric field per category
 *   - mutation: chart-patch type change
 *   - roundtrip: create → chart-get returns the canonical dataset shape
 *   - errors: invalid form id, unsupported chart type (honest failure, no junk)
 *   - delete: idempotent double-delete
 *
 * Graders read GROUND TRUTH (charts-list / chart-get / chart-data-get), never
 * the agent's self-report. Expected values were verified empirically against
 * the real API (see the shapes in each grader's comments).
 */

import { uniqueLabel } from './helpers.mjs';

const STATUS_FIELD = 4; // 'Status' select: Open / Closed / Pending.
const AMOUNT_FIELD = 5; // 'Amount' number field (aggregation fixtures).

/** Form fields for chart fixtures: the default Status select + a numeric Amount. */
const CHART_FORM_FIELDS = [
  { id: 1, type: 'text', label: 'First Name' },
  {
    id: STATUS_FIELD,
    type: 'select',
    label: 'Status',
    choices: [
      { text: 'Open', value: 'open' },
      { text: 'Closed', value: 'closed' },
      { text: 'Pending', value: 'pending' },
    ],
  },
  { id: AMOUNT_FIELD, type: 'number', label: 'Amount' },
];

/** Seed entries with known Status counts AND Amount sums:
 *  counts → Open 3, Closed 2, Pending 1 (total 6)
 *  sums   → Open 60, Closed 20, Pending 7 */
const SEED_ENTRIES = [
  ['open', 10], ['open', 20], ['open', 30],
  ['closed', 5], ['closed', 15],
  ['pending', 7],
];
const EXPECTED_COUNTS = { Open: 3, Closed: 2, Pending: 1 };
const EXPECTED_SUMS = { Open: 60, Closed: 20, Pending: 7 };

async function seedChartForm(client, label) {
  const form = await client.createForm(uniqueLabel(label), CHART_FORM_FIELDS);
  for (const [status, amount] of SEED_ENTRIES) {
    await client.createEntry(form.id, { [STATUS_FIELD]: status, [AMOUNT_FIELD]: amount });
  }
  return form;
}

/** client.ability() returns { status, data }; charts-list data is { charts: [ {id,name,form,type,is_active} ] }. */
async function findChart(client, formId) {
  const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: formId });
  const list = data?.charts || [];
  return list[list.length - 1] || null; // most-recently-created
}

async function chartCount(client, formId) {
  const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: formId });
  return (data?.charts || []).length;
}

/** chart-get data is { id, form_id, is_active, meta } — the raw stored feed config. */
async function storedChart(client, feedId) {
  const { data } = await client.ability('gk-gravitycharts/chart-get', { feed_id: feedId });
  return data || {};
}

/** chart-data-get data is the rendered Chart.js shape { type, data: { labels, datasets }, options }.
 *  Data points are objects like {value,label,x} (or bare numbers) — normalize both. */
async function renderedChart(client, feedId) {
  const { data } = await client.ability('gk-gravitycharts/chart-data-get', { feed_id: feedId });
  const type = data?.type || '';
  const chartData = data?.data || {};
  const labels = chartData?.labels || [];
  const datasets = chartData?.datasets || [];
  const pointValue = (p) => (typeof p === 'number' ? p : (p?.value ?? p?.y ?? (Array.isArray(p) ? p[1] : NaN)));
  const values = datasets.flatMap((d) => (Array.isArray(d?.data) ? d.data : [])).map(pointValue).map(Number).filter((n) => Number.isFinite(n));
  return { type, labels, datasets, values, options: data?.options || {}, raw: data };
}

/** Order-agnostic label→value map from the rendered first dataset.
 *  Use the AXIS label (r.labels[i]) — a point's own `label` is the formatted
 *  VALUE on aggregated charts (e.g. "60" for a sum), not the category. */
function labelValueMap(r) {
  const map = {};
  const points = Array.isArray(r.datasets?.[0]?.data) ? r.datasets[0].data : [];
  points.forEach((p, i) => {
    const label = r.labels?.[i] ?? (p && typeof p === 'object' ? p.label : undefined);
    const value = typeof p === 'number' ? p : (p?.value ?? p?.y);
    if (label !== undefined) map[String(label)] = Number(value);
  });
  return map;
}

function mapsEqual(actual, expected) {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every((k) => actual[k] === expected[k]);
}

/** Label→value map for ONE rendered dataset (multi-dataset charts). */
function datasetValueMap(r, ds) {
  const map = {};
  const points = Array.isArray(ds?.data) ? ds.data : [];
  points.forEach((p, i) => {
    const label = r.labels?.[i];
    const value = typeof p === 'number' ? p : (p?.value ?? p?.y);
    if (label !== undefined) map[String(label)] = Number(value);
  });
  return map;
}

/** Find a rendered dataset by its legend label. */
const datasetByLabel = (r, label) => (r.datasets || []).find((d) => String(d?.label || '') === label) || null;

/** Color match that tolerates hex vs rgb()/rgba() emission of the same color. */
function colorMatches(value, hex) {
  const s = JSON.stringify(value ?? '').toLowerCase();
  if (s.includes(hex.replace('#', '').toLowerCase())) return true;
  const n = parseInt(hex.replace('#', ''), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  return s.includes(rgb) || s.includes(rgb.replace(/ /g, ''));
}

const agentErrors = (t) => (t.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode || (c.text || '').slice(0, 60)).filter(Boolean);

export default [
  // ── Discovery ────────────────────────────────────────────────────────────

  {
    id: 'charts.discover-types',
    category: 'charts',
    expectedTurns: 2,
    maxTurns: 8,
    prompt: 'What chart types can GravityCharts create on this site? List them.',
    async grade({ telemetry }) {
      const called = (telemetry.toolCalls || []).some((c) => /chart[_-]?types[_-]?list/i.test(c.name || '') && !c.isError);
      const named = /\b(bar|line|pie|table)\b/i.test(telemetry.finalText || '');
      return { pass: called && named, detail: called ? (named ? '' : 'listed types but named none in the answer') : 'never cleanly called chart-types-list' };
    },
  },

  {
    id: 'charts.spec-discovery',
    category: 'charts',
    expectedTurns: 2,
    maxTurns: 10,
    prompt:
      'What settings and options are possible for a LINE chart in GravityCharts on this site? ' +
      'Use the GravityCharts schema tools to find out, then list the available settings.',
    async grade({ client, telemetry }) {
      // The clean path: gc_chart_schema_get called with chart_type "line".
      const schemaCall = (telemetry.toolCalls || []).find(
        (c) => /chart[_-]?schema[_-]?get/i.test(c.name || '') && !c.isError && !c.denied && String(c.input?.chart_type || '') === 'line',
      );
      // Ground-truth vocabulary straight from the live schema (verified shape:
      // { supported_settings: [...], dataset_schema.items.properties, schema.properties }).
      const { data } = await client.ability('gk-gravitycharts/chart-schema-get', { chart_type: 'line' });
      const vocab = [
        ...(data?.supported_settings || []),
        ...Object.keys(data?.dataset_schema?.items?.properties || {}),
        ...Object.keys(data?.schema?.properties || {}),
      ];
      // Drop tokens that are everyday words — they'd match prose incidentally.
      const generic = new Set(['min', 'max', 'id', 'name', 'label', 'color', 'title', 'fill', 'offset', 'datasets']);
      const text = telemetry.finalText || '';
      // Match camelCase setting names whether written verbatim ("pointRadius")
      // or spelled out ("point radius").
      const matches = [...new Set(vocab)].filter((token) => {
        if (generic.has(token.toLowerCase())) return false;
        const spaced = token.replace(/([a-z0-9])([A-Z])/g, '$1[\\s_-]?$2');
        return new RegExp(`\\b${spaced}\\b`, 'i').test(text);
      });
      const pass = !!schemaCall && matches.length >= 3;
      return {
        pass,
        detail: pass ? '' : `schemaCall=${!!schemaCall} namedSettings=${JSON.stringify(matches)} — wanted a clean gc_chart_schema_get(chart_type:"line") + >=3 real line-chart settings named in the answer`,
      };
    },
  },

  // ── Creation ─────────────────────────────────────────────────────────────

  {
    id: 'charts.create-basic-bar',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      return { formId: form.id, name: uniqueLabel('GC Basic Bar') };
    },
    prompt: (s) => `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" using GravityCharts.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created on form ${state.formId}; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const isBar = /bar/i.test(chart.type || '');
      return { pass: isBar, detail: isBar ? '' : `created a chart but type="${chart.type || '?'}" (wanted bar)` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId); // cascades its feeds
    },
  },

  {
    id: 'charts.count-per-category',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Status Bar') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" that shows how many entries there are ` +
      `for each value of the "Status" field (the choices are Open, Closed, and Pending). The chart should count entries per status.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const counts = labelValueMap(r);
      const exact = mapsEqual(counts, EXPECTED_COUNTS);
      const pass = /bar/i.test(r.type || chart.type || '') && exact;
      return { pass, detail: pass ? '' : `type=${r.type || '?'} rendered=${JSON.stringify(counts)} — wanted exact counts ${JSON.stringify(EXPECTED_COUNTS)}` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.create-pie',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Status Pie') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a pie chart named "${s.name}" showing the proportion of entries in each Status.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const counts = labelValueMap(r);
      const pass = /pie/i.test(r.type || chart.type || '') && mapsEqual(counts, EXPECTED_COUNTS);
      return { pass, detail: pass ? '' : `type=${r.type || '?'} rendered=${JSON.stringify(counts)} — wanted a pie with counts ${JSON.stringify(EXPECTED_COUNTS)}` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.horizontal-bar',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Horizontal') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a HORIZONTAL bar chart named "${s.name}" counting entries per Status ` +
      `(the bars should run left-to-right, not bottom-to-top).`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      // Horizontal = meta.indexAxis "y", which the renderer emits as options.indexAxis "y" (verified).
      const horizontal = String(r.options?.indexAxis || '') === 'y';
      const counts = labelValueMap(r);
      const pass = /bar/i.test(r.type || '') && horizontal && mapsEqual(counts, EXPECTED_COUNTS);
      return {
        pass,
        detail: pass ? '' : `type=${r.type || '?'} indexAxis=${JSON.stringify(r.options?.indexAxis)} rendered=${JSON.stringify(counts)} — wanted a horizontal (indexAxis "y") bar with counts ${JSON.stringify(EXPECTED_COUNTS)}`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.dataset-color',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Colored') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" counting entries per Status. ` +
      `Make the bars the exact color #ff6384 and label the data series "By Status".`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const ds0 = stored.meta?.datasets?.[0] || {};
      const r = await renderedChart(client, chart.id);
      const rendered0 = r.datasets?.[0] || {};
      // Verified: dataset color "#ff6384" is stored verbatim and emitted verbatim as backgroundColor.
      const storedOk = String(ds0.color || '').toLowerCase() === '#ff6384' && ds0.label === 'By Status';
      const renderedOk = JSON.stringify(rendered0.backgroundColor || '').toLowerCase().includes('ff6384') && rendered0.label === 'By Status';
      const pass = storedOk && renderedOk;
      return {
        pass,
        detail: pass ? '' : `stored ds0=${JSON.stringify({ color: ds0.color, label: ds0.label })} rendered ds0=${JSON.stringify({ backgroundColor: rendered0.backgroundColor, label: rendered0.label })} — wanted color #ff6384 + label "By Status" in both`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Aggregation ──────────────────────────────────────────────────────────

  {
    id: 'charts.sum-per-category',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Amount Sum') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" showing the TOTAL of the "Amount" field ` +
      `for each Status. So each bar is the sum of Amount across that status's entries, not a count of entries.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const sums = labelValueMap(r);
      // Seeded amounts: Open 10+20+30=60, Closed 5+15=20, Pending 7 (verified rendering).
      const pass = mapsEqual(sums, EXPECTED_SUMS);
      return { pass, detail: pass ? '' : `rendered=${JSON.stringify(sums)} — wanted exact sums ${JSON.stringify(EXPECTED_SUMS)} (dataOperationField "sum" + dataAggregateField "${AMOUNT_FIELD}")` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Mutation ─────────────────────────────────────────────────────────────

  {
    id: 'charts.change-type',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      const feedId = await client.createChart(form.id, {
        chart_type: 'bar',
        name: uniqueLabel('GC Morph'),
        datasets: [{ dataField: String(STATUS_FIELD) }],
      });
      return { formId: form.id, feedId };
    },
    prompt: (s) => `Chart feed ${s.feedId} on Gravity Forms form ${s.formId} is currently a bar chart. Change it to a LINE chart. Don't change anything else about it.`,
    async grade({ client, state, telemetry }) {
      const stored = await storedChart(client, state.feedId);
      const isLine = String(stored.meta?.chartType || '') === 'line';
      // "Don't change anything else": the dataset mapping must survive the patch.
      const dsIntact = String(stored.meta?.datasets?.[0]?.dataField || '') === String(STATUS_FIELD);
      const pass = isLine && dsIntact;
      return {
        pass,
        detail: pass ? '' : `chartType=${JSON.stringify(stored.meta?.chartType)} datasets[0].dataField=${JSON.stringify(stored.meta?.datasets?.[0]?.dataField)} (errors: ${agentErrors(telemetry).join(', ') || 'none'}) — wanted line + dataset untouched`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Roundtrip fidelity ───────────────────────────────────────────────────

  {
    id: 'charts.roundtrip-shape',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Roundtrip') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" counting entries per Status. ` +
      `Then read the chart's stored configuration back and tell me exactly which field id drives the chart and how the data is aggregated.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const ds0 = stored.meta?.datasets?.[0] || {};
      // The canonical shape must round-trip: dataField (NOT field_id), categories mode, and the chart must render.
      const canonical = String(ds0.dataField || '') === String(STATUS_FIELD) && !('field_id' in ds0) && String(stored.meta?.xAxisMode || '') === 'categories';
      const r = await renderedChart(client, chart.id);
      const renders = mapsEqual(labelValueMap(r), EXPECTED_COUNTS);
      const reported = new RegExp(`\\b${STATUS_FIELD}\\b`).test(telemetry.finalText || '') && /count/i.test(telemetry.finalText || '');
      const pass = canonical && renders && reported;
      return {
        pass,
        detail: pass ? '' : `stored ds0=${JSON.stringify(ds0)} xAxisMode=${JSON.stringify(stored.meta?.xAxisMode)} renders=${renders} reported=${reported} — wanted canonical dataField shape, correct render, and an answer naming field ${STATUS_FIELD} + counting`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Error handling ───────────────────────────────────────────────────────

  {
    id: 'charts.error-invalid-form',
    category: 'charts',
    expectedTurns: 2,
    maxTurns: 10,
    prompt:
      'Create a GravityCharts bar chart on Gravity Forms form 999999. If that is not possible, do not create a chart anywhere else — just tell me exactly what went wrong.',
    async grade({ client, telemetry }) {
      // Honest failure: the agent reports the form doesn't exist and creates nothing.
      const admitted = /not (found|exist)|doesn'?t exist|no (such )?form|invalid form|couldn'?t find/i.test(telemetry.finalText || '');
      const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: 999999 });
      const nothingCreated = (data?.charts || []).length === 0;
      const pass = admitted && nothingCreated;
      return { pass, detail: pass ? '' : `admitted=${admitted} chartsOn999999=${(data?.charts || []).length} — wanted an honest "form not found" and zero charts created` };
    },
  },

  {
    id: 'charts.error-invalid-type',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      return { formId: form.id };
    },
    prompt: (s) =>
      `Create a "scatter" chart on Gravity Forms form ${s.formId} using GravityCharts. If scatter is not a supported chart type, ` +
      `do NOT create a chart of any other type — instead tell me which chart types ARE supported.`,
    async grade({ client, state, telemetry }) {
      const created = await chartCount(client, state.formId);
      // Refusal phrasings vary ("not supported" / "not a supported chart type" /
      // "won't create…") — grade the semantics (a negation + the types named), not one phrasing.
      const text = telemetry.finalText || '';
      const namedTypes = ['bar', 'line', 'pie'].filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(text)).length;
      const negation = /\b(not|no|isn'?t|aren'?t|unsupported|unavailable|won'?t|cannot|can'?t|doesn'?t)\b/i.test(text);
      const listedSupported = namedTypes >= 3 && negation;
      const pass = created === 0 && listedSupported;
      return { pass, detail: pass ? '' : `chartsCreated=${created} listedSupported=${listedSupported} — wanted zero charts + an answer naming the supported types` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Spec & validation (gc_chart_validate dry-run surface) ───────────────

  {
    id: 'charts.validate-before-create',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Validated') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId} there is a "Status" select field (field ${STATUS_FIELD}) and a numeric "Amount" field (field ${AMOUNT_FIELD}). ` +
      `I want a bar chart named "${s.name}" where each bar is the TOTAL of Amount for one Status. ` +
      `BEFORE creating anything, dry-run VALIDATE that exact chart configuration using the GravityCharts validation tool. ` +
      `Only create the chart if validation reports the configuration is valid.`,
    async grade({ client, state, telemetry }) {
      const calls = telemetry.toolCalls || [];
      // Verified: gc_chart_validate is a dry-run — valid configs return {"valid":true,...}
      // as a SUCCESSFUL (non-error) result and persist nothing.
      const vIdx = calls.findIndex((c) => /chart[_-]?validate/i.test(c.name || '') && !c.isError && !c.denied);
      const cIdx = calls.findIndex((c) => /chart[_-]?create/i.test(c.name || '') && !c.isError && !c.denied);
      const validatedFirst = vIdx >= 0 && cIdx > vIdx;
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `validatedFirst=${validatedFirst}(vIdx=${vIdx},cIdx=${cIdx}) but no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const sums = labelValueMap(r);
      const rendersOk = /bar/i.test(r.type || '') && mapsEqual(sums, EXPECTED_SUMS);
      const pass = validatedFirst && rendersOk;
      return {
        pass,
        detail: pass ? '' : `validatedFirst=${validatedFirst}(vIdx=${vIdx},cIdx=${cIdx}) type=${r.type || '?'} rendered=${JSON.stringify(sums)} — wanted a clean gc_chart_validate BEFORE gc_chart_create + a bar chart rendering sums ${JSON.stringify(EXPECTED_SUMS)}`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.self-correct-invalid',
    category: 'charts',
    expectedTurns: 6,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Corrected') };
    },
    // dataOperationField "total" is the planted invalid value (real ops:
    // entry_count/sum/max/min/average). It is rejected at DIFFERENT layers
    // depending on route — chart-create's input schema (400 "ability_invalid_input"),
    // chart-validate's dry-run (200 {"valid":false, code "invalid_enum"}) — while
    // schema-passing spec violations 400 as "gravitycharts_invalid_config". All
    // carry corrective guidance, so the grader accepts any of the three as
    // "rejected"; pinning one code would fail agents that took another valid route.
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" where each bar shows the Amount field (field ${AMOUNT_FIELD}) ` +
      `aggregated for each Status (field ${STATUS_FIELD}). IMPORTANT: on your FIRST attempt, set the dataset's data operation ` +
      `(dataOperationField) to exactly "total" — do not substitute a different value on your own. ` +
      `If the GravityCharts API rejects or flags that configuration, follow the error guidance in its response to fix the ` +
      `configuration and finish creating a working chart.`,
    async grade({ client, state, telemetry }) {
      const calls = telemetry.toolCalls || [];
      // The invalid value must actually have been attempted against the API...
      const attemptedTotal = calls.some(
        (c) => /chart[_-]?(create|validate|patch)/i.test(c.name || '') && JSON.stringify(c.input || {}).includes('"total"'),
      );
      // ...and visibly rejected (error result, or a dry-run reporting valid:false).
      const rejectionSeen = calls.some(
        (c) =>
          (c.isError && /gravitycharts_invalid_config|ability_invalid_input/i.test(c.text || '')) ||
          (/chart[_-]?validate/i.test(c.name || '') && !c.isError && /"valid"\s*:\s*false/.test(c.text || '')),
      );
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `attemptedTotal=${attemptedTotal} rejectionSeen=${rejectionSeen} but no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const ds0 = stored.meta?.datasets?.[0] || {};
      const corrected = String(ds0.dataOperationField || '') === 'sum' && String(ds0.dataAggregateField || '') === String(AMOUNT_FIELD);
      const r = await renderedChart(client, chart.id);
      const rendersOk = mapsEqual(labelValueMap(r), EXPECTED_SUMS);
      const pass = attemptedTotal && rejectionSeen && corrected && rendersOk;
      return {
        pass,
        detail: pass ? '' : `attemptedTotal=${attemptedTotal} rejectionSeen=${rejectionSeen} stored ds0={op:${JSON.stringify(ds0.dataOperationField)}, agg:${JSON.stringify(ds0.dataAggregateField)}} rendered=${JSON.stringify(labelValueMap(r))} — wanted "total" attempted, a rejection observed, then a corrected sum chart rendering ${JSON.stringify(EXPECTED_SUMS)}`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Extreme combinations ─────────────────────────────────────────────────

  {
    id: 'charts.kitchen-sink-dual-axis',
    category: 'charts',
    expectedTurns: 6,
    maxTurns: 20,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Kitchen Sink') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create one GravityCharts bar chart named "${s.name}" with TWO data series:\n` +
      `1. "Entries" — the number of entries per Status, as bars, colored #ff6384.\n` +
      `2. "Revenue" — the TOTAL of the Amount field per Status, drawn as a LINE (not bars) plotted against a SECOND y-axis on the right side, colored #00a0d2.\n` +
      `Both series share the same Status categories on the x-axis.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const entries = datasetByLabel(r, 'Entries');
      const revenue = datasetByLabel(r, 'Revenue');
      if (!entries || !revenue) return { pass: false, detail: `datasets=${JSON.stringify((r.datasets || []).map((d) => d.label))} — wanted "Entries" and "Revenue"` };
      // Verified emission: the line series carries type "line" + yAxisID "y1"; scales gain y1.
      const countsOk = mapsEqual(datasetValueMap(r, entries), EXPECTED_COUNTS);
      const sumsOk = mapsEqual(datasetValueMap(r, revenue), EXPECTED_SUMS);
      const mixedOk = String(revenue.type || '') === 'line' && !/line/i.test(String(entries.type || ''));
      const dualAxisOk = String(revenue.yAxisID || '') === 'y1' && !!r.options?.scales?.y1;
      const colorsOk = colorMatches(entries.backgroundColor, '#ff6384') && colorMatches(revenue.borderColor ?? revenue.backgroundColor, '#00a0d2');
      const pass = countsOk && sumsOk && mixedOk && dualAxisOk && colorsOk;
      return {
        pass,
        detail: pass ? '' : `counts=${countsOk}(${JSON.stringify(datasetValueMap(r, entries))}) sums=${sumsOk}(${JSON.stringify(datasetValueMap(r, revenue))}) mixed=${mixedOk}(rev.type=${revenue.type}) dualAxis=${dualAxisOk}(yAxisID=${revenue.yAxisID}) colors=${colorsOk}`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.multi-turn-evolve',
    category: 'charts',
    expectedTurns: 10,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Evolving'), newName: uniqueLabel('GC Evolved') };
    },
    // A real user's conversational flow: create → add a series → restyle one series.
    // Turn 3 is the patch-discipline trap: datasets replace WHOLESALE on patch, so
    // restyling series 1 without touching series 2 forces read-modify-write.
    turns: [
      (s) => `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" that counts entries per Status.`,
      (s) => `Now add a second data series to that same chart: the TOTAL of the Amount field per Status, drawn as a LINE against a second y-axis on the right, labeled "Revenue", colored #00a0d2.`,
      (s) => `Rename the chart to "${s.newName}", and change the FIRST series (the entry counts) to be labeled "Ticket Count" with color #22aa44. Do not change the Revenue series in any way.`,
    ],
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed exists; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const renamed = String(stored.meta?.chartName || '') === state.newName;
      const r = await renderedChart(client, chart.id);
      const counts = datasetByLabel(r, 'Ticket Count');
      const revenue = datasetByLabel(r, 'Revenue');
      if (!counts || !revenue) return { pass: false, detail: `renamed=${renamed} datasets=${JSON.stringify((r.datasets || []).map((d) => d.label))} — wanted "Ticket Count" + "Revenue" after 3 turns` };
      const countsOk = mapsEqual(datasetValueMap(r, counts), EXPECTED_COUNTS) && colorMatches(counts.backgroundColor, '#22aa44');
      const revenueIntact = mapsEqual(datasetValueMap(r, revenue), EXPECTED_SUMS)
        && String(revenue.type || '') === 'line'
        && String(revenue.yAxisID || '') === 'y1'
        && colorMatches(revenue.borderColor ?? revenue.backgroundColor, '#00a0d2');
      const pass = renamed && countsOk && revenueIntact;
      return {
        pass,
        detail: pass ? '' : `renamed=${renamed} countsOk=${countsOk}(${JSON.stringify(datasetValueMap(r, counts))}, bg=${JSON.stringify(counts.backgroundColor)}) revenueIntact=${revenueIntact}(type=${revenue.type} yAxis=${revenue.yAxisID} ${JSON.stringify(datasetValueMap(r, revenue))})`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.multi-turn-transform',
    category: 'charts',
    expectedTurns: 8,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Transformer') };
    },
    // Create as one thing, then reshape it twice — type/orientation, then the
    // aggregation itself. End state must reflect ALL THREE turns at once.
    turns: [
      (s) => `On Gravity Forms form ${s.formId}, create a pie chart named "${s.name}" showing entries per Status.`,
      () => `Change that chart into a HORIZONTAL bar chart (bars running left-to-right). Keep the same data.`,
      () => `Now change what it measures: instead of counting entries, each bar should show the TOTAL of the Amount field for that Status.`,
    ],
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed exists; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const isBar = /bar/i.test(r.type || '');
      const horizontal = String(r.options?.indexAxis || '') === 'y';
      const sums = labelValueMap(r);
      const sumsOk = mapsEqual(sums, EXPECTED_SUMS);
      const pass = isBar && horizontal && sumsOk;
      return {
        pass,
        detail: pass ? '' : `type=${r.type || '?'} indexAxis=${JSON.stringify(r.options?.indexAxis)} rendered=${JSON.stringify(sums)} — wanted a horizontal bar totaling Amount per Status (${JSON.stringify(EXPECTED_SUMS)})`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Delete ───────────────────────────────────────────────────────────────

  {
    id: 'charts.delete-idempotent',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      const feedId = await client.createChart(form.id, { chart_type: 'bar', name: uniqueLabel('GC Doomed') });
      return { formId: form.id, feedId };
    },
    prompt: (s) =>
      `Delete GravityCharts chart feed ${s.feedId} (it's on form ${s.formId}). Then try deleting the SAME feed id a second time ` +
      `and tell me what the second attempt reported.`,
    async grade({ client, state, telemetry }) {
      const remaining = await chartCount(client, state.formId);
      const deleteCalls = (telemetry.toolCalls || []).filter((c) => /chart[_-]?delete/i.test(c.name || ''));
      const mentionedIdempotent = /already[ _-]?(deleted|gone|removed)|no longer exists|was already/i.test(telemetry.finalText || '');
      const pass = remaining === 0 && deleteCalls.length >= 2 && mentionedIdempotent;
      return {
        pass,
        detail: pass ? '' : `remaining=${remaining} deleteCalls=${deleteCalls.length} mentionedIdempotent=${mentionedIdempotent} — wanted the feed gone, two delete calls, and the answer relaying already_deleted`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
];
