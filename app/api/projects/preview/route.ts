/**
 * POST { startDate, totalHours | totalMinutes, force?, startMinutes? } -> CreationPreview
 *
 * A POST rather than a GET so the payload goes through the same helpers `POST /api/projects`
 * uses: a preview validated differently from the save is a preview that lies. Writes nothing.
 */

import type { NextRequest } from 'next/server';
import {
  readFlag,
  readJsonBody,
  readStartMinutes,
  requireDate,
  requirePaintedShape,
  requireTotalMinutes,
  route,
} from '@/src/lib/api';
import { previewProjectCreation } from '@/src/lib/operations/projects';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    const startDate = requireDate(body, 'startDate');
    const startMinutes = readStartMinutes(body);
    const force = readFlag(body, 'force');
    requirePaintedShape({ startDate, startMinutes, force });
    return previewProjectCreation({
      startDate,
      totalMinutes: requireTotalMinutes(body),
      force,
      startMinutes,
    });
  });
}
