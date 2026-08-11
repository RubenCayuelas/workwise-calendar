/**
 * `/api/projects` — the job list, and creating a job.
 *
 * GET  -> { projects: Project[] }                      in creation order
 * POST    { name, description?, color, totalHours }
 *      -> { project, blocks, summary, touchedLockedBlockIds }
 *
 * `totalHours` may also be sent as `totalMinutes`; see src/lib/api.ts on units.
 * `color` must be one of the eight `PROJECT_COLORS` swatches.
 *
 * A new job is appended to the END of the queue and never targets Friday: it fills
 * Mon-Thu and, if it does not fit, skips the colchón for next week's Monday.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_NAME_LENGTH,
  readJsonBody,
  readText,
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
    });
  });
}
