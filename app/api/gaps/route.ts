/**
 * `/api/gaps` — breaks and holes: maintenance, a breakdown, admin time.
 *
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   -> { gaps: Gap[] }   (both or neither)
 * POST { date, startTime | startMinutes, durationHours | durationMinutes, reason? }
 *      -> { gap, summary }
 *
 * A gap is TIME: it consumes the day's plannable hours exactly like locked work
 * does, so saving one recomposes and pushes the unlocked work forward in the same
 * transaction. If the space is held by a row the engine may not move — locked, in
 * the frozen past, or on a weekend — the save is refused with `gap-over-fixed-block`
 * rather than an overlap being written. The error's `details` name the job, the day
 * and the times so the message can say which block is in the way.
 *
 * The lunch break is NOT a gap. It is the implicit hole between the two periods in
 * Settings.
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
