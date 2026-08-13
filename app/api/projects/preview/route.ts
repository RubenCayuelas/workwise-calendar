/**
 * `/api/projects/preview` — where a job WOULD land, without creating it.
 *
 * POST { startDate, totalHours | totalMinutes, force? } -> CreationPreview
 *
 * The create form calls this whenever the owner picks a start date, because choosing a
 * date is only worth anything if the consequence is visible before saving: which day the
 * hours really start on, what is already sitting across the whole span they would
 * occupy, whether every row would be locked, and which days are free instead.
 *
 * It is a POST rather than a GET so the payload is read and validated by exactly the
 * same helpers `POST /api/projects` uses — a preview validated differently from the save
 * would be a preview that lies. It opens no transaction and writes nothing.
 */

import type { NextRequest } from 'next/server';
import { readFlag, readJsonBody, requireDate, requireTotalMinutes, route } from '@/src/lib/api';
import { previewProjectCreation } from '@/src/lib/operations/projects';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    return previewProjectCreation({
      startDate: requireDate(body, 'startDate'),
      totalMinutes: requireTotalMinutes(body),
      force: readFlag(body, 'force'),
    });
  });
}
