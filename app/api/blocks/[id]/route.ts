/**
 * `/api/blocks/:id` — the gestures on one row of the calendar.
 *
 * PATCH  { action: "move",    date, startTime | startMinutes }
 * PATCH  { action: "resize",  durationHours | durationMinutes }
 * PATCH  { action: "release" }
 * PATCH  { action: "lock",    locked: boolean }
 *        -> { block, blocks, summary, touchedLockedBlockIds,
 *             mergedBlockIds, displacedProjectIds }
 * DELETE -> { deleted: true, projectId, summary }
 *
 * `action` is the discriminator because all four are edits of the same row and a
 * single endpoint keeps "one gesture, one request, one recomposition" obvious.
 *
 * RESIZE sets the row's length by hand and it STICKS: the row comes back with
 * `manualDuration: true`, the engine stops re-deriving that job's segmentation
 * there, and the job's remaining hours start on the next auto-fill day while the
 * jobs behind it take the hours the day just gained. RELEASE is the way back —
 * `manualDuration: false` and the row rejoins its run on the same recomposition.
 * Both are offered on EVERY row; a resize that would leave a job's blocks summing to
 * less than its total (shrinking its last or only row) is refused with 409
 * `shrink-last-block`, never quietly ignored.
 *
 * Three things the UI must handle in the response:
 *
 * - `block` is NULL when auto-merge absorbed the edited row into a neighbouring row
 *   of the same job. `blocks` — the job's rows as they now stand — is the answer in
 *   that case.
 * - A MOVE does not pin the row. It sets the row's place in the queue, and the
 *   reflow then settles it contiguously after whatever precedes it. To nail a row to
 *   an exact time, follow the move with `action: "lock"`.
 * - A MOVE onto the weekend or into the past lands where the reflow may not reach, so
 *   an overlap there is resolved on the spot: `mergedBlockIds` lists rows of the same
 *   job the drop absorbed (hours SUMMED, so 2 h onto a 2 h row is one 4 h row), and
 *   `displacedProjectIds` lists jobs whose row was cut and pushed after the drop.
 *   Both are empty for `resize` and `lock`. A drop onto a LOCKED row is refused with
 *   409 `overlaps-locked-block` and nothing is written.
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
import {
  deleteBlock,
  moveBlock,
  releaseBlockDuration,
  resizeBlock,
  setBlockLock,
} from '@/src/lib/operations/blocks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const ACTIONS = ['move', 'resize', 'release', 'lock'] as const;

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);

    switch (requireOneOf(body, 'action', ACTIONS)) {
      case 'move':
        return moveBlock(id, { date: requireDate(body), startMinutes: requireStartMinutes(body) });
      case 'resize':
        return resizeBlock(id, { durationMinutes: requireDurationMinutes(body) });
      case 'release':
        return releaseBlockDuration(id);
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
