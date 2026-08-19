/**
 * POST { startDate, totalHours | totalMinutes, force? } -> CreationPreview
 *
 * A POST rather than a GET so the payload goes through the same helpers `POST /api/projects`
 * uses: a preview validated differently from the save is a preview that lies. Writes nothing.
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
