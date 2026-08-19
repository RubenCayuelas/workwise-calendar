/**
 * PATCH  { action: "move",   date, startTime | startMinutes, unitBlockIds? }
 * PATCH  { action: "resize", durationHours | durationMinutes, freedHours? }
 * PATCH  { action: "lock",   locked: boolean }
 *        -> { block, blocks, summary, placedBlockIds, changed,
 *             touchedLockedBlockIds, mergedBlockIds, displacedProjectIds }
 * DELETE -> { deleted: true, projectId, summary }
 *
 * Three response fields a caller gets wrong by reading `block` alone:
 * - `placedBlockIds` is where the hours REALLY ended up, in calendar order, and is normally
 *   longer than one: `block` is only the first. Look the ids up in `blocks`.
 * - `changed` is false when nothing was written. A move is a queue rank, so the reflow may
 *   answer with the calendar the owner already had. Never infer this from geometry.
 * - `block` is null when auto-merge absorbed the row; `blocks` is the answer then.
 *
 * `mergedBlockIds` and `displacedProjectIds` are the overlap resolved in the same
 * transaction, and are empty for `resize` and `lock`.
 *
 * A shrink with nowhere to put the freed hours answers 409 `shrink-needs-choice` carrying
 * `details.freedMinutes` and `details.choices`, writing nothing; send the owner's pick back as
 * `freedHours`. Not sending it again is Cancel.
 */

import type { NextRequest } from 'next/server';
import {
  readIdList,
  readJsonBody,
  readOneOf,
  requireDate,
  requireDurationMinutes,
  requireFlag,
  requireOneOf,
  requireStartMinutes,
  route,
  type JsonBody,
} from '@/src/lib/api';
import type { FreedHoursChoice } from '@/src/lib/composition';
import { deleteBlock, moveBlock, resizeBlock, setBlockLock } from '@/src/lib/operations/blocks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const ACTIONS = ['move', 'resize', 'lock'] as const;

/** The two ways out a `shrink-needs-choice` refusal offers. Cancel is not sending one. */
const FREED_HOURS: readonly FreedHoursChoice[] = ['reduce-total', 'new-block'];

function readFreedHoursChoice(body: JsonBody): FreedHoursChoice | undefined {
  return readOneOf(body, 'freedHours', FREED_HOURS);
}

export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);

    switch (requireOneOf(body, 'action', ACTIONS)) {
      case 'move':
        return moveBlock(id, {
          date: requireDate(body),
          startMinutes: requireStartMinutes(body),
          // Omitted means this row alone, which is what an HTTP caller aiming at one row means.
          unitBlockIds: readIdList(body, 'unitBlockIds'),
        });
      case 'resize':
        return resizeBlock(id, {
          durationMinutes: requireDurationMinutes(body),
          // Absent means "ask": refused with `shrink-needs-choice`, answered on the next request.
          freedHours: readFreedHoursChoice(body),
        });
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
