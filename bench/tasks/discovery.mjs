/**
 * Discovery tasks — the surface most exposed to the input-contract changes.
 * A no-argument list/scan call used to 400 ("input is not of type object" /
 * oneOf "matches more than one"); a small model would then stall or give up.
 */

import { noToolErrors, calledOk } from './helpers.mjs';

const errorCodes = (t) => [...new Set((t.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode || c.text?.slice(0, 60)).filter(Boolean))];

export default [
  {
    id: 'discovery.list-views',
    category: 'discovery',
    expectedTurns: 2,
    maxTurns: 8,
    prompt: 'List all the GravityView Views on this site and tell me how many there are.',
    async grade({ telemetry }) {
      const ok = calledOk(telemetry, 'views_list') && noToolErrors(telemetry);
      return {
        pass: ok,
        detail: ok ? '' : `views-list did not complete cleanly; errors: ${errorCodes(telemetry).join(', ') || 'none, but no clean views_list call'}`,
      };
    },
  },
  {
    id: 'discovery.list-layouts',
    category: 'discovery',
    expectedTurns: 2,
    maxTurns: 8,
    prompt: 'What View layouts (templates) are available on this site? Name them.',
    async grade({ telemetry }) {
      const clean = calledOk(telemetry, 'layouts_list') && noToolErrors(telemetry);
      const named = /table|list|datatables|map|layout builder|diy/i.test(telemetry.finalText || '');
      return {
        pass: clean && named,
        detail: clean ? (named ? '' : 'layouts listed but none named in the answer') : `layouts-list errored: ${errorCodes(telemetry).join(', ')}`,
      };
    },
  },
  {
    id: 'discovery.scan-by-status',
    category: 'discovery',
    expectedTurns: 2,
    maxTurns: 8,
    prompt: 'Which Views on this site are published (post status "publish")? List them.',
    async grade({ telemetry }) {
      // The scalar-status oneOf bug surfaced as a 400 on the status-filtered call.
      const clean = noToolErrors(telemetry) && (calledOk(telemetry, 'views_list') || calledOk(telemetry, 'views_scan'));
      return {
        pass: clean,
        detail: clean ? '' : `status-filtered listing errored: ${errorCodes(telemetry).join(', ')}`,
      };
    },
  },
];
