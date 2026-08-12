/**
 * What a drop will do to the row it lands ON, worked out while the pointer is still
 * down.
 *
 * WHY THIS EXISTS. A drop used to be, for a weekday row, a pure re-ranking: the row
 * took a place in the queue and settled after whatever preceded it, so the ghost's
 * exact minutes were never a promise and nothing else on the day changed. Since
 * 2026-08-12 an overlapping drop CUTS the row underneath (CLAUDE.md, *A Drop That
 * Overlaps*), on any day — so the drop now rewrites somebody else's block, and the
 * preview has to say so before the mouse is released rather than after, in a toast.
 *
 * It mirrors `resolveManualPlacement`, which is the authority; this is a read-only
 * echo of its two branches:
 *
 * | the drop is…                                  | it collides with… | same job | other job |
 * |-----------------------------------------------|-------------------|----------|-----------|
 * | FIXED (weekend, the Friday buffer, or locked)  | the day's FIXED rows | merged, hours summed | cut, tail pushed after |
 * | REFLOWED (Mon-Thu, unlocked)                   | the day's MOVABLE rows | nothing — the reflow lays them out contiguously and auto-merge joins them | cut, but only a row that STARTS BEFORE the drop |
 *
 * FRIDAY IS ON THE FIXED SIDE because a drop there is hand-placed (`handPlaced`), which
 * takes it out of the movable pool — that is how work stays on the colchón at all. So is
 * any row already carrying that mark, whatever day it is on.
 *
 * and a LOCKED row is never overlapped: on the fixed side that is the 409
 * `overlaps-locked-block`, on the reflowed side the row is simply ignored, because
 * flexible work flows around it.
 *
 * THE DROP'S FOOTPRINT IS ITS SEGMENTS, not the rectangle the pointer draws. A drop is
 * stored cut at the break between two working periods (CLAUDE.md, *A Drop Is Stored In
 * Segments*), so 6 h released at 10:00 occupies 10:00-14:00 and 15:30-17:30 and NOT the
 * lunch band between them. That rule is `segmentDroppedRow` in src/lib/dropSegments.ts,
 * imported rather than restated: the engine and this file must give the same answer, and
 * a row sitting inside the lunch band would otherwise be announced as cut by a drop that
 * never touches it.
 *
 * TWO APPROXIMATIONS, both deliberate and both safe in the same direction — they can
 * only make the preview silent, never make it promise something that will not happen:
 *
 * - a unit stored as two rows around lunch is dropped one row at a time, and this
 *   reads the ghost (the unit's whole span) rather than each row's own;
 * - the past is not modelled at all, because a drop onto a past day is refused by the
 *   drag layer before it gets here.
 */

import { overlapsSegments, segmentDroppedRow, type DropSegment } from '../../lib/dropSegments';
import type { WorkPeriod } from '../../types';

/** The row shapes this needs. `WeekBlock` satisfies it; a test can build one by hand. */
export interface DropRow {
  id: string;
  projectId: string;
  startMinutes: number;
  durationMinutes: number;
  locked: boolean;
  /** A human put this row here, so the engine will not move it either. */
  handPlaced: boolean;
  project: { name: string };
}

export interface DropEffectInput {
  /** Every row already on the TARGET day, the dragged unit's own rows included. */
  rows: readonly DropRow[];
  /** The dragged unit's rows: they cannot collide with themselves. */
  movingBlockIds: readonly string[];
  /** The dragged unit's job, which decides merge versus cut. */
  projectId: string;
  /** Every row of a weekend day is fixed, whatever its padlock says. */
  dayIsWeekend: boolean;
  /**
   * The target day is the Friday buffer, where a drop is hand-placed and therefore
   * fixed. Unlike the weekend it does NOT make the rows already there fixed: an
   * engine-placed Friday row is still movable and the reflow can recover it.
   */
  dayIsBuffer: boolean;
  /** The dragged unit is locked, so the reflow will not lay it out either. */
  locked: boolean;
  /**
   * The target day's working periods, which are where the drop is cut. Without them a
   * drop across the lunch break would be measured over the band it does not occupy.
   */
  periods: readonly WorkPeriod[];
  /** The ghost, in minutes from midnight. */
  startMinutes: number;
  durationMinutes: number;
}

export type DropEffectKind =
  /** The row underneath is cut here and its tail continues after the drop. */
  | 'cut'
  /** The same job's row absorbs the drop: one row, hours SUMMED. */
  | 'merge'
  /** A locked row is in the way. The save is refused (409) and nothing is written. */
  | 'blocked';

export interface DropEffect {
  kind: DropEffectKind;
  /** The row this happens to. */
  blockId: string;
  /** Its job's name, so the hint can name it the way the toast afterwards will. */
  projectName: string;
  /** Where the row is cut, in minutes from midnight. Only meaningful for `cut`. */
  cutMinutes: number;
}

/**
 * The one thing worth drawing, or `null` when the drop disturbs nothing.
 *
 * One effect rather than a list: a drop can legally cut several rows at once, but the
 * hint has room for one sentence and the first row the drop lands in is the one the
 * pointer is actually over. A refusal always wins, because it is the only outcome
 * where nothing is saved at all.
 */
export function dropEffectOf(input: DropEffectInput): DropEffect | null {
  // The clock the drop will really hold once it is stored: its segments, with the break
  // it skips left out of them.
  const footprint = dropFootprint(input);
  // The drop's own side of the calendar: a fixed drop lands where the reflow may not
  // reach, so it collides with the other fixed rows and nothing will separate them.
  const reflowed = !input.locked && !input.dayIsWeekend && !input.dayIsBuffer;

  const overlapping = [...input.rows]
    .filter(
      (row) =>
        !input.movingBlockIds.includes(row.id) &&
        overlapsSegments(footprint, row.startMinutes, row.durationMinutes) &&
        // Each branch only ever sees its own side. `isMovable` reduces to this here:
        // the day is not past (the drag layer refuses those), so a row is fixed iff the
        // day is a weekend, or it is locked, or a human placed it.
        (input.dayIsWeekend || row.locked || row.handPlaced) !== reflowed,
    )
    .sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));

  if (overlapping.length === 0) return null;

  if (reflowed) {
    // A row starting at or after the drop already ranks behind it and is left alone;
    // a locked row was filtered out above, so no drop on this side is ever refused.
    const victim = overlapping.find(
      (row) => row.projectId !== input.projectId && row.startMinutes < input.startMinutes,
    );
    return victim === undefined ? null : effect('cut', victim, input.startMinutes);
  }

  // The fixed side, in the order `resolveManualPlacement` applies it: the same-job
  // merge first (and it refuses when either side is locked), then the cut.
  const sameJob = overlapping.find((row) => row.projectId === input.projectId);
  if (sameJob !== undefined) {
    // Refused when EITHER side is locked: merging moves the surviving row's start, so
    // it would move the lock. The row named is the same job's either way, which is the
    // dragged unit's own name — the sentence reads the same from both sides.
    const blocked = sameJob.locked || input.locked;
    return effect(blocked ? 'blocked' : 'merge', sameJob, input.startMinutes);
  }

  const locked = overlapping.find((row) => row.locked);
  if (locked !== undefined) return effect('blocked', locked, input.startMinutes);

  const victim = overlapping[0];
  return effect('cut', victim, Math.max(victim.startMinutes, input.startMinutes));
}

function effect(kind: DropEffectKind, row: DropRow, cutMinutes: number): DropEffect {
  return { kind, blockId: row.id, projectName: row.project.name, cutMinutes };
}

/**
 * The rows the drop will be stored as — what the ghost should draw, and what the
 * collision test above measures against.
 *
 * Exported because WeekGrid draws the ghost from it: one rectangle per segment, so the
 * preview shows the two rows the server will write rather than one rectangle running
 * through the lunch band.
 */
export function dropFootprint(input: {
  periods: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): DropSegment[] {
  return segmentDroppedRow(input.periods, {
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
  });
}
