/**
 * POST — the same body `POST /api/absences` takes -> AbsencePreview. Writes NOTHING: it runs the real
 * write and rolls it back, so what it reports is what the save will do, refusals included.
 *
 * A POST rather than a GET so the payload goes through the same readers the save uses: a preview
 * validated differently from the save is a preview that lies.
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
import { ABSENCE_KINDS, previewAbsence } from '@/src/lib/operations/absences';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return previewAbsence({
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
