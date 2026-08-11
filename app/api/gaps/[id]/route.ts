/**
 * `/api/gaps/:id` — edit or remove one gap.
 *
 * PATCH  { date?, startTime | startMinutes?, durationHours | durationMinutes?, reason? }
 *        -> { gap, summary }
 * DELETE -> { deleted: true, summary }
 *
 * A PATCH is checked as a whole: the fields it omits keep their stored values and the
 * resulting rectangle is tested against the rows the engine may not move, exactly as
 * on create. `reason` accepts `null` (or `""`) to clear it.
 *
 * Deleting frees the time, and the recomposition fills it — Mon-Thu first, which is
 * also how work is pulled back off the Friday colchón.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_TEXT_LENGTH,
  readClearableText,
  readDate,
  readDurationMinutes,
  readJsonBody,
  readStartMinutes,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { deleteGap, patchGap } from '@/src/lib/operations/gaps';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);
    return patchGap(id, {
      date: readDate(body),
      startMinutes: readStartMinutes(body),
      durationMinutes: readDurationMinutes(body),
      reason: readClearableText(body, 'reason', {
        maxLength: MAX_TEXT_LENGTH,
        messageKey: ERROR_MESSAGE_KEYS.invalidReason,
      }),
    });
  });
}

export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    return { deleted: true, ...deleteGap(id) };
  });
}
