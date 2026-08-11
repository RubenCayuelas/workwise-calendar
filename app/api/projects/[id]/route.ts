/**
 * `/api/projects/:id` — one job: read it, edit it, delete it.
 *
 * GET    -> { project, blocks }                     every block of the job, all weeks
 * PATCH     { name?, description?, color?, totalHours? }
 *        -> { project, blocks, summary, touchedLockedBlockIds }
 * DELETE -> { deleted: true, summary }
 *
 * `description` accepts `null` (or `""`) to clear it. Changing name, description or
 * colour moves nothing on the calendar; changing `totalHours` goes through the LIFO
 * rule — added hours land on the job's last unlocked block, removed hours come off
 * it and delete any row that reaches zero.
 *
 * Deleting recomposes, so it can fail with `horizon-exceeded` when the remaining
 * backlog no longer fits inside the planning horizon. The whole delete rolls back;
 * widening the horizon in Settings is the way out.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_NAME_LENGTH,
  readClearableText,
  readJsonBody,
  readProjectColor,
  readText,
  readTotalMinutes,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { deleteProject, patchProject, readProject } from '@/src/lib/operations/projects';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  return route(async () => readProject((await context.params).id));
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);
    return patchProject(id, {
      name: readText(body, 'name', {
        maxLength: MAX_NAME_LENGTH,
        messageKey: ERROR_MESSAGE_KEYS.invalidName,
      }),
      description: readClearableText(body, 'description', {
        messageKey: ERROR_MESSAGE_KEYS.invalidDescription,
      }),
      color: readProjectColor(body),
      totalMinutes: readTotalMinutes(body),
    });
  });
}

export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    return { deleted: true, ...deleteProject(id) };
  });
}
