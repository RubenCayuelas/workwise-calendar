/**
 * `/api/projects/:id` — one job: read it, edit it, delete it.
 *
 * GET    -> { project, blocks }                     every block of the job, all weeks
 * PATCH     { name?, description?, color?, totalHours? }
 *        -> { project, blocks, summary, touchedLockedBlockIds }
 * DELETE ?lang=es -> { deleted: true, summary, preservedGapIds }
 *
 * `description` accepts `null` (or `""`) to clear it. Changing name, description or
 * colour moves nothing on the calendar; changing `totalHours` goes through the LIFO
 * rule — added hours land on the job's last unlocked block, removed hours come off
 * it and delete any row that reaches zero.
 *
 * DELETING LEAVES THE JOB'S PAST BEHIND. Its rows on days the shop has already worked
 * become GAPS — same date, same start, same duration — each one carrying the job's name in
 * its reason (`Trabajo «Barandilla» eliminado`), so those days keep their shape and the
 * owner can still tell what was there. `preservedGapIds` lists them, newest week last, and
 * they are editable and deletable like any other gap.
 *
 * `?lang=` is what those sentences are written in. They become stored user data and cannot
 * be re-translated afterwards, so the language the owner is READING the app in is the one
 * to send; Spanish is used when it is missing or unknown.
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

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    // The wording of the gaps the job's past leaves behind, and nothing else. An unknown
    // value is not an error: it falls back to Spanish, the shop's own language.
    const language = new URL(request.url).searchParams.get('lang') ?? undefined;
    return { deleted: true, ...deleteProject(id, { language }) };
  });
}
