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
 * | the drop is…                              | it collides with… | same job | other job |
 * |-------------------------------------------|-------------------|----------|-----------|
 * | FIXED (weekend day, or a locked unit)      | the day's FIXED rows | merged, hours summed | cut, tail pushed after |
 * | REFLOWED (weekday, unlocked)               | the day's MOVABLE rows | nothing — the reflow lays them out contiguously and auto-merge joins them | cut, but only a row that STARTS BEFORE the drop |
 *
 * and a LOCKED row is never overlapped: on the fixed side that is the 409
 * `overlaps-locked-block`, on the reflowed side the row is simply ignored, because
 * flexible work flows around it.
 *
 * TWO APPROXIMATIONS, both deliberate and both safe in the same direction — they can
 * only make the preview silent, never make it promise something that will not happen:
 *
 * - a unit stored as two rows around lunch is dropped one row at a time, and this
 *   reads the ghost (the unit's whole span) rather than each row's own;
 * - the past is not modelled at all, because a drop onto a past day is refused by the
 *   drag layer before it gets here.
 */

/** The row shapes this needs. `WeekBlock` satisfies it; a test can build one by hand. */
export interface DropRow {
  id: string;
  projectId: string;
  startMinutes: number;
  durationMinutes: number;
  locked: boolean;
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
  /** The dragged unit is locked, so the reflow will not lay it out either. */
  locked: boolean;
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
  const endMinutes = input.startMinutes + input.durationMinutes;
  // The drop's own side of the calendar: a fixed drop lands where the reflow may not
  // reach, so it collides with the other fixed rows and nothing will separate them.
  const reflowed = !input.locked && !input.dayIsWeekend;

  const overlapping = [...input.rows]
    .filter(
      (row) =>
        !input.movingBlockIds.includes(row.id) &&
        row.startMinutes < endMinutes &&
        row.startMinutes + row.durationMinutes > input.startMinutes &&
        // Each branch only ever sees its own side. `isMovable` reduces to this here:
        // the day is neither past (the drag layer refuses those) nor, on the reflowed
        // branch, a weekend.
        (input.dayIsWeekend || row.locked) !== reflowed,
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
