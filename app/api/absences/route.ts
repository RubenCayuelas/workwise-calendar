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
 *
 * `keepWork` belongs to `closed-days`: the dates whose work stays where it is instead of being
 * displaced, which PADLOCKS it. It is the answer to the question the form asks before a close moves
 * anything, and the holiday check asks the same one.
 */

import type { NextRequest } from 'next/server';
import { readAbsenceInput, readJsonBody, route } from '@/src/lib/api';
import { ABSENCE_KINDS, saveAbsence } from '@/src/lib/operations/absences';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => saveAbsence(readAbsenceInput(await readJsonBody(request), ABSENCE_KINDS)));
}
