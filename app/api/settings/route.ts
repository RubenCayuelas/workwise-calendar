/**
 * GET   -> { settings, shape, maxDayCapacityHours }
 * PATCH    any subset of Settings -> { settings, shape, maxDayCapacityHours, summary }
 *
 * `settings` is the form's shape (`HH:mm`, decimal hours); `shape` the same in the minutes the
 * grid draws with.
 *
 * Two caller obligations: a patch that SHORTENS the shift must carry the capacity it wants in
 * the same request, because a capacity above the enabled periods is refused rather than
 * re-capped; and `error.field` names the input to highlight on a 400.
 *
 * A save recomposes, so narrowing `planningHorizonWeeks` can fail with `horizon-exceeded`, which
 * rolls the settings change back with it.
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

/** Only that it IS a number: every bound belongs to `validateSettings`, or it gets two owners. */
function readSettingsNumber(body: JsonBody, key: keyof Settings): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) return undefined;
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.settingsInvalid, { field: key });
  }
  return value;
}
