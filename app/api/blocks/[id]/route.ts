/**
 * `/api/blocks/:id` — the gestures on one row of the calendar.
 *
 * PATCH  { action: "move",    date, startTime | startMinutes, unitBlockIds? }
 * PATCH  { action: "resize",  durationHours | durationMinutes, freedHours? }
 * PATCH  { action: "release" }
 * PATCH  { action: "lock",    locked: boolean }
 *        -> { block, blocks, summary, placedBlockIds, changed,
 *             touchedLockedBlockIds, mergedBlockIds, displacedProjectIds }
 * DELETE -> { deleted: true, projectId, summary }
 *
 * `action` is the discriminator because all four are edits of the same row and a
 * single endpoint keeps "one gesture, one request, one recomposition" obvious.
 *
 * NOTHING HERE TOUCHES A PAST DAY. Every action, and DELETE, is refused with 409
 * `past-block-frozen` on a row dated before today, and a MOVE aimed at a past day is
 * refused with 409 `drop-onto-past-day`. The past is the record of what the shop did: to
 * change a job whose work is behind it, edit the job (`PATCH /api/projects/:id`), where the
 * hours land on a row on a future day. The one exception is RELEASE, which clears a mark
 * the engine no longer consults there and moves nothing.
 *
 * RESIZE sets the row's length by hand and it STICKS: the row comes back with
 * `manualDuration: true`, the engine stops re-deriving that job's segmentation
 * there, and the job's remaining hours start on the next auto-fill day while the
 * jobs behind it take the hours the day just gained.
 *
 * SHRINKING ASKS RATHER THAN REFUSING. The freed hours go to the job's last row the engine
 * still lays out, skipping the locked ones and cascading backwards. When no row can take
 * them — the job's only row, or every other one locked, on a weekend or in the past — the
 * answer is 409 `shrink-needs-choice` with `details.freedMinutes` and `details.choices`, and
 * NOTHING is written. Put those choices to the owner and send the
 * one they pick back in the same request shape:
 *
 *     { action: "resize", durationMinutes, freedHours: "reduce-total" | "new-block" }
 *
 * `reduce-total` takes the hours off the job's estimate; `new-block` leaves them as a row
 * of their own for the owner to place. Cancel is simply not sending it again. `choices`
 * lists only the answers that exist, so the dialog never has to guess — `new-block` is
 * absent when the freed hours are under a quarter of an hour.
 *
 * Six things the UI must handle in the response:
 *
 * - `placedBlockIds` is where the gesture's hours REALLY ended up, in calendar order, and
 *   it is normally longer than one. Work fills what a day has left and the remainder
 *   overflows to the next day it can use, so 6 h dropped into a 4 h afternoon comes back as
 *   two rows — `block` is only the first of them. Look the ids up in `blocks`.
 * - `changed` is FALSE when the request wrote nothing at all. A move writes a queue rank, so
 *   the reflow may answer it with the calendar the owner already had; that used to be
 *   indistinguishable from a move that worked. Never infer it from geometry.
 * - `block` is NULL when auto-merge absorbed the edited row into a neighbouring row
 *   of the same job. `blocks` — the job's rows as they now stand — is the answer in
 *   that case.
 * - A MOVE onto Monday-Thursday, inside the working periods, does not pin the row. It
 *   sets the row's place in the queue, and the reflow then settles it contiguously after
 *   whatever precedes it. To nail a row to an exact time, follow the move with
 *   `action: "lock"`.
 * - A MOVE onto FRIDAY, the WEEKEND or a VISUAL MARGIN answers `locked: true`. It keeps
 *   the exact slot it was dropped in and the engine never recovers it — which is how the
 *   owner puts work on the colchón. The padlock is only ever ADDED by a move: dropping the
 *   row back onto Mon-Thu leaves it locked, and `action: "lock", locked: false` is the way
 *   off. A row carries two marks at most, `locked` and `manualDuration`, and they are
 *   independent.
 * - A MOVE onto the weekend, into the past or onto a padlocked row lands where the
 *   reflow may not reach, so an overlap there is resolved on the spot: `mergedBlockIds`
 *   lists rows of the same job the drop absorbed (hours SUMMED, so 2 h onto a 2 h row is
 *   one 4 h row), and `displacedProjectIds` lists jobs whose row was cut and pushed
 *   after the drop. Both are empty for `resize` and `lock`.
 *
 * A MOVE THE ENGINE STILL OWNS IS NEVER REFUSED FOR A COLLISION — an unlocked row inside
 * the working periods of Monday to Thursday or the Friday buffer, from today on. There a
 * drop is a re-ranking of the queue and the reflow is what finds the room, so asking
 * whether the footprint fits at this instant answers the wrong question. A move that
 * PADLOCKS lands literally: a gap or another lock in the way slides it forward on that
 * day, and a day with no clear slot is refused. The 409s therefore survive where the drop
 * lands literally — the weekend, a closed day, the frozen past, a margin, and a locked row
 * being dragged: `overlaps-locked-block`, `overlaps-gap`, `merge-exceeds-day` and
 * `displaced-hours-unplaceable`. Nothing is written by any of them.
 *
 * A MOVE THAT LANDS LITERALLY AND IS AIMED BELOW WHAT THE DAY HOLDS LANDS ON THE NEXT DAY
 * the engine would use, at the top of its working periods, instead of being refused for
 * running past the end of the day: aiming past the end of a day means the day after, on any
 * calendar. Monday to Thursday and the Friday buffer roll forward (a row that lands on
 * Friday is padlocked like any Friday drop); the weekend, a closed day and the past do not
 * roll — there the exact minute is the whole promise, and the end-of-day 409 stands. `block`
 * in the response says which day it really was.
 *
 * A MOVE THAT IS ONLY A QUEUE RANK IS NEVER ROLLED — an unlocked row released inside the
 * working periods of Monday to Thursday. It has no footprint to fit: the engine takes what
 * the day has left and carries the rest to the next day it can use, so 6 h released into a
 * 4 h afternoon is 4 h there and 2 h the day after, and `placedBlockIds` names both rows.
 * Rolling it moved the row to a day it might already be on and answered 200 with nothing
 * changed.
 *
 * A drop is stored in SEGMENTS: a stretch crossing the lunch break comes back as two
 * rows of one job (10:00-14:00 and 15:30-17:30 for 6 h at 10:00), never one row running
 * through the break. `block` is the first of them.
 *
 * DELETE removes those hours from the job, so `total_hours` drops by the row's
 * duration. Deleting a job's only row is refused (`delete-last-block`) — use
 * `DELETE /api/projects/:id`.
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
import {
  deleteBlock,
  moveBlock,
  releaseBlock,
  resizeBlock,
  setBlockLock,
} from '@/src/lib/operations/blocks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const ACTIONS = ['move', 'resize', 'release', 'lock'] as const;

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
          // The rows the caller drew as one unit with this one. A unit has a single drag
          // handle, so the whole thing moves in this ONE transaction; without the list it
          // is just this row, which is what an HTTP caller aiming at one row means.
          unitBlockIds: readIdList(body, 'unitBlockIds'),
        });
      case 'resize':
        return resizeBlock(id, {
          durationMinutes: requireDurationMinutes(body),
          // Absent means "ask": the transform refuses with `shrink-needs-choice` and the
          // owner's answer comes back on the next request.
          freedHours: readFreedHoursChoice(body),
        });
      case 'release':
        return releaseBlock(id);
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
