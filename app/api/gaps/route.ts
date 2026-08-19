/**
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   -> { gaps: Gap[] }   (both or neither)
 * POST { date, startTime | startMinutes, durationHours | durationMinutes, reason? }
 *      -> { gap, summary }
 *
 * Saving recomposes. Space held by a row the engine may not move is refused with
 * `gap-over-fixed-block`, whose `details` name the job, the day and the times.
 *
 * The lunch break is NOT a gap — it is the implicit hole between the two periods.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_TEXT_LENGTH,
  readDateParam,
  readJsonBody,
  readText,
  requireDate,
  requireDurationMinutes,
  requireStartMinutes,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { createGap, readGaps } from '@/src/lib/operations/gaps';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return route(() => {
    const url = new URL(request.url);
    return {
      gaps: readGaps({ from: readDateParam(url, 'from'), to: readDateParam(url, 'to') }),
    };
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return createGap({
      date: requireDate(body),
      startMinutes: requireStartMinutes(body),
      durationMinutes: requireDurationMinutes(body),
      reason: readText(body, 'reason', {
        maxLength: MAX_TEXT_LENGTH,
        messageKey: ERROR_MESSAGE_KEYS.invalidReason,
      }),
    });
  });
}
