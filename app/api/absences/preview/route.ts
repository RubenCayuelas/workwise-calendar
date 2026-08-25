/**
 * POST — the same body `POST /api/absences` takes -> AbsencePreview. Writes NOTHING: it runs the real
 * write and rolls it back, so what it reports is what the save will do, refusals included.
 *
 * A POST rather than a GET so the payload goes through the same readers the save uses: a preview
 * validated differently from the save is a preview that lies.
 */

import type { NextRequest } from 'next/server';
import { readAbsenceInput, readJsonBody, route } from '@/src/lib/api';
import { ABSENCE_KINDS, previewAbsence } from '@/src/lib/operations/absences';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => previewAbsence(readAbsenceInput(await readJsonBody(request), ABSENCE_KINDS)));
}
