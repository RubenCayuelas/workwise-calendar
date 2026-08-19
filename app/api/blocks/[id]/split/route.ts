/**
 * POST { durationHours | durationMinutes, date, startTime | startMinutes }
 *   -> { block, blocks, summary, touchedLockedBlockIds, mergedBlockIds, displacedProjectIds }
 *
 * `total_hours` does not change. Asking for the whole row is refused (`split-exceeds-block`):
 * moving an entire block is `PATCH /api/blocks/:id` with `action: "move"`.
 *
 * `block` is the SOURCE row, null if auto-merge absorbed it; the new fragment is in `blocks`.
 * The FRAGMENT is the dropped row, so it follows a drop's rules and refusals exactly.
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
