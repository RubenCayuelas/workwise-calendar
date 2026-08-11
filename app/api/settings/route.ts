/**
 * `/api/settings` — the workshop's configuration.
 *
 * GET   -> { settings, shape, maxDayCapacityHours }
 * PATCH    any subset of Settings
 *       -> { settings, shape, maxDayCapacityHours, summary }
 *
 * `settings` mirrors the form: `HH:mm` times and decimal hours. `shape` is the same
 * thing in the minutes the grid draws with — the two periods, the auto-fill stop
 * line, and the margin-to-margin timeline (07:00-20:30 by default).
 *
 * TWO THINGS THE SETTINGS SCREEN MUST DO:
 *
 * 1. Render the RETURNED settings, not its own form state. `defaultDayCapacity` is a
 *    stop line derived from the shift, so shortening the periods or switching the
 *    afternoon off re-caps it instead of rejecting the save — and the re-cap is
 *    invisible if the form keeps showing what was typed.
 * 2. Surface `error.field` on a 400. Every other value is rejected rather than
 *    repaired, and `field` names the input to highlight.
 *
 * A save recomposes, because periods and capacity decide every day's plannable
 * hours. So NARROWING `planningHorizonWeeks` can fail with `horizon-exceeded` if the
 * queued work no longer fits, and that failure rolls the settings change back with
 * it.
 */

import type { NextRequest } from 'next/server';
import { readFlag, readJsonBody, readText, route } from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS, badRequest } from '@/src/lib/errors';
import { readSettingsView, updateSettings } from '@/src/lib/operations/settings';
import type { JsonBody } from '@/src/lib/api';
import type { Settings } from '@/src/types';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => readSettingsView());
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return updateSettings({
      period1Start: readText(body, 'period1Start'),
      period1End: readText(body, 'period1End'),
      period2Start: readText(body, 'period2Start'),
      period2End: readText(body, 'period2End'),
      period2Enabled: readFlag(body, 'period2Enabled'),
      defaultDayCapacity: readSettingsNumber(body, 'defaultDayCapacity'),
      visualMarginTop: readSettingsNumber(body, 'visualMarginTop'),
      visualMarginBottom: readSettingsNumber(body, 'visualMarginBottom'),
      planningHorizonWeeks: readSettingsNumber(body, 'planningHorizonWeeks'),
      gapColor: readText(body, 'gapColor'),
    });
  });
}

/**
 * Only checks that the value IS a number — the ranges, the cross-field rules and the
 * capacity re-cap all belong to `validateSettings`, which throws with the offending
 * `field` attached. Duplicating a bound here would give it two owners.
 */
function readSettingsNumber(body: JsonBody, key: keyof Settings): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) return undefined;
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.settingsInvalid, { field: key });
  }
  return value;
}
