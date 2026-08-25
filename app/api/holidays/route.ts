/**
 * GET  -> HolidayState: which town, how many holidays, how far they reach, when we last looked.
 * POST -> HolidayCheckResult. `{ force: true }` is the "check now" button and skips the weekly wait.
 *
 * Called once when the app is opened, like the automatic backup. The days with work on them come back
 * in `pending` and NOTHING is written for them until the panel answers through ./apply.
 */

import type { NextRequest } from 'next/server';
import { readFlag, readJsonBody, route } from '@/src/lib/api';
import { readHolidayState, runHolidayCheck } from '@/src/lib/operations/holidays';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => readHolidayState());
}

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    // An empty body is the ordinary once-per-visit check; only the button sends anything.
    const body = await readJsonBody(request).catch(() => ({}));
    return runHolidayCheck({ force: readFlag(body, 'force') ?? false });
  });
}
