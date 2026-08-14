/**
 * `/api/blocks/:id/split` — the scissors: move a PORTION of a job out of this row.
 *
 * POST { durationHours | durationMinutes, date, startTime | startMinutes }
 *   -> { block, blocks, summary, touchedLockedBlockIds,
 *        mergedBlockIds, displacedProjectIds }
 *
 * The source row shrinks by that much, the portion becomes a new row of the same job
 * at the drop point, and `total_hours` does not change — no hours are created or
 * destroyed. Asking for the whole row is refused (`split-exceeds-block`): moving an
 * entire block is `PATCH /api/blocks/:id` with `action: "move"`.
 *
 * `block` in the response is the SOURCE row (null if auto-merge absorbed it);
 * `blocks` is every row of the job afterwards, which is where the new fragment is.
 *
 * The FRAGMENT is the dropped row, so splitting onto a weekend the job already
 * occupies MERGES the two into one row of the summed hours and reports the absorbed
 * id in `mergedBlockIds`; splitting onto another job's weekend row cuts that row and
 * lists it in `displacedProjectIds`; splitting onto a LOCKED weekend row is refused with
 * 409 `overlaps-locked-block`.
 *
 * The fragment is a drop, so it follows a drop's rules exactly: onto a day the engine
 * reflows (Mon-Thu, the Friday buffer) it is never refused for a collision — it slides
 * clear of a gap or a lock, or takes an ordinary queue rank. See `PATCH /api/blocks/:id`.
 */

import type { NextRequest } from 'next/server';
import {
  readJsonBody,
  requireDate,
  requireDurationMinutes,
  requireStartMinutes,
  route,
} from '@/src/lib/api';
import { splitBlock } from '@/src/lib/operations/blocks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const body = await readJsonBody(request);
    return splitBlock(id, {
      durationMinutes: requireDurationMinutes(body),
      date: requireDate(body),
      startMinutes: requireStartMinutes(body),
    });
  });
}
