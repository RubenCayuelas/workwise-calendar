/**
 * GET    -> { project, blocks }   every block of the job, all weeks
 * PATCH     { name?, description?, color?, totalHours? }
 *        -> { project, blocks, summary, touchedLockedBlockIds }
 * DELETE ?lang=es -> { deleted: true, summary, preservedGapIds }
 *
 * `description` accepts `null` or `""` to clear it.
 *
 * A delete turns the job's PAST rows into gaps and lists them in `preservedGapIds`. `?lang=`
 * is the language their reason sentence is written in: it becomes stored user data and cannot
 * be re-translated afterwards, so send the language the owner is READING (Spanish otherwise).
 *
 * A delete recomposes, so it can fail with `horizon-exceeded` and roll back whole.
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
