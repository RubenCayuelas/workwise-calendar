/**
 * POST { kind: "gap" | "closed-days", from, to?, reason?,
 *        startTime | startMinutes?, durationHours | durationMinutes? }
 *      -> AbsenceMutation
 *
 * A RANGE in ONE transaction: `to` absent means one day, Saturday and Sunday are skipped unless the
 * range is entirely inside one weekend, and a refusal on any day of it writes nothing at all.
 * `reason` is the gap's reason, or the closed day's note.
 *
 * `startMinutes` and `durationMinutes` belong to `gap` and are required there. Closing a day takes no
 * hours: a short day is a gap, and `capacity_hours` deliberately has no screen.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_TEXT_LENGTH,
  readDate,
  readDurationMinutes,
  readJsonBody,
  readStartMinutes,
  readText,
  requireDate,
  requireOneOf,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { ABSENCE_KINDS, saveAbsence } from '@/src/lib/operations/absences';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return saveAbsence({
      kind: requireOneOf(body, 'kind', ABSENCE_KINDS),
      from: requireDate(body, 'from'),
      to: readDate(body, 'to'),
      reason: readText(body, 'reason', {
        maxLength: MAX_TEXT_LENGTH,
        messageKey: ERROR_MESSAGE_KEYS.invalidReason,
      }),
      startMinutes: readStartMinutes(body),
      durationMinutes: readDurationMinutes(body),
    });
  });
}
