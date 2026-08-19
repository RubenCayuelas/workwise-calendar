/**
 * PATCH  { action?: "edit" | "move" | "resize",
 *          date?, startTime | startMinutes?, durationHours | durationMinutes?, reason? }
 *        -> { gap, gaps, summary }
 * DELETE -> { deleted: true, summary }
 *
 * IT ADDRESSES THE WHOLE ABSENCE, whichever of its rows the id names: the two halves around the
 * comida are one gap with one reason, the duration defaults to their SUM and the rows the edit
 * becomes are reconciled against the rows it has.
 *
 * A PATCH is checked as a WHOLE: omitted fields keep their stored values and the resulting
 * rectangle is tested as on create. `reason` accepts `null` or `""` to clear it.
 *
 * `action` says which gesture is asking, because a drag and a form save send the same fields.
 * `edit` (the default) reaches the past — that is how a past absence is corrected — while `move`
 * and `resize` are refused there, at either end: `past-gap-frozen` for a gap already in the past,
 * `drop-onto-past-day` for a day that is.
 */

import type { NextRequest } from 'next/server';
import {
  MAX_TEXT_LENGTH,
  readClearableText,
  readDate,
  readDurationMinutes,
  readJsonBody,
  readOneOf,
  readStartMinutes,
  route,
} from '@/src/lib/api';
import { ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { deleteGap, patchGap, type GapGesture } from '@/src/lib/operations/gaps';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const GESTURES: readonly GapGesture[] = ['edit', 'move', 'resize'];

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);
    return patchGap(id, {
      action: readOneOf(body, 'action', GESTURES),
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
