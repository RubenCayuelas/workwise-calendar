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
import { readJsonBody, route } from '@/src/lib/api';
import { readSettingsView, updateSettings } from '@/src/lib/operations/settings';
import { settingsPatchOf } from '@/src/lib/settingsPatch';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => readSettingsView());
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return route(async () => updateSettings(settingsPatchOf(await readJsonBody(request))));
}
