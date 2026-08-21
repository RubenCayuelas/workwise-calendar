/**
 * GET  -> { projects: Project[] }   in creation order
 * POST    { name, description?, color, totalHours, startDate?, startMinutes?, force? }
 *      -> { project, blocks, summary, touchedLockedBlockIds, placement? }
 *
 * `totalHours` may also be sent as `totalMinutes`. `color` must be one of the eight
 * `PROJECT_COLORS` swatches.
 *
 * `startDate` is a FLOOR — "not before this day" — and is NOT stored. `force: true` says the
 * owner disagreed with the deferral. `POST /api/projects/preview` answers the same question
 * without writing.
 *
 * `startMinutes` turns that floor into a POINT: a band painted on the grid, whose hours start
 * exactly there and whose rows on that day are padlocked. It needs `startDate` and refuses `force`.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_NAME_LENGTH,
  readDate,
  readFlag,
  readJsonBody,
  readStartMinutes,
  readText,
  requirePaintedShape,
  requireProjectColor,
  requireText,
  requireTotalMinutes,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { createProject } from '@/src/lib/operations/projects';
import { listProjects } from '@/src/lib/repositories/projects';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => ({ projects: listProjects() }));
}

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    const startDate = readDate(body, 'startDate');
    const startMinutes = readStartMinutes(body);
    const force = readFlag(body, 'force');
    requirePaintedShape({ startDate, startMinutes, force });
    return createProject({
      name: requireText(body, 'name', {
        maxLength: MAX_NAME_LENGTH,
        messageKey: ERROR_MESSAGE_KEYS.invalidName,
      }),
      description: readText(body, 'description', {
        messageKey: ERROR_MESSAGE_KEYS.invalidDescription,
      }),
      color: requireProjectColor(body),
      totalMinutes: requireTotalMinutes(body),
      startDate,
      force,
      startMinutes,
    });
  });
}
