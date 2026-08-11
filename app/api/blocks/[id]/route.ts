/**
 * `/api/blocks/:id` — the gestures on one row of the calendar.
 *
 * PATCH  { action: "move",   date, startTime | startMinutes }
 * PATCH  { action: "resize", durationHours | durationMinutes }
 * PATCH  { action: "lock",   locked: boolean }
 *        -> { block, blocks, summary, touchedLockedBlockIds }
 * DELETE -> { deleted: true, projectId, summary }
 *
 * `action` is the discriminator because all three are edits of the same row and a
 * single endpoint keeps "one gesture, one request, one recomposition" obvious.
 *
 * Two things the UI must handle in the response:
 *
 * - `block` is NULL when auto-merge absorbed the edited row into a neighbouring row
 *   of the same job. `blocks` — the job's rows as they now stand — is the answer in
 *   that case.
 * - A MOVE does not pin the row. It sets the row's place in the queue, and the
 *   reflow then settles it contiguously after whatever precedes it. To nail a row to
 *   an exact time, follow the move with `action: "lock"`.
 *
 * DELETE removes those hours from the job, so `total_hours` drops by the row's
 * duration. Deleting a job's only row is refused (`delete-last-block`) — use
 * `DELETE /api/projects/:id`.
 */

import type { NextRequest } from 'next/server';
import {
  readJsonBody,
  requireDate,
  requireDurationMinutes,
  requireFlag,
  requireOneOf,
  requireStartMinutes,
  route,
} from '@/src/lib/api';
import { deleteBlock, moveBlock, resizeBlock, setBlockLock } from '@/src/lib/operations/blocks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const ACTIONS = ['move', 'resize', 'lock'] as const;

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);

    switch (requireOneOf(body, 'action', ACTIONS)) {
      case 'move':
        return moveBlock(id, { date: requireDate(body), startMinutes: requireStartMinutes(body) });
      case 'resize':
        return resizeBlock(id, { durationMinutes: requireDurationMinutes(body) });
      case 'lock':
        return setBlockLock(id, requireFlag(body, 'locked'));
    }
  });
}

export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    return { deleted: true, ...deleteBlock(id) };
  });
}
