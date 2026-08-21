/**
 * What a drop will do to the row it lands ON, worked out while the pointer is still down: a
 * read-only echo of `resolveManualPlacement`, whose two sides it must not confuse — a PINNED drop
 * collides with the day's fixed rows, a RE-RANKED one with its movable rows.
 */

import { overlapsSegments, segmentDroppedRow, type DropSegment } from '../../lib/dropSegments';
import { dropLandsLiterally, firstClearStart, type DropPin } from '../../lib/dropSlide';
import { dayEndMinutes, netMinutesBetween, netMinutesOf } from '../../lib/manualWindow';
import type { DayRole } from '../../lib/composition';
import type { WorkPeriod } from '../../types';

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
  gaps?: readonly { startMinutes: number; durationMinutes: number }[];
  movingBlockIds: readonly string[];
  projectId: string;
  /** Every row of a weekend day is fixed, whatever its padlock says. */
  dayIsWeekend: boolean;
  /**
   * The drop keeps the minute it was released on. It picks the SIDE the collision is resolved on,
   * and is NOT the same question as `dayReflows`: the Friday buffer pins AND reflows.
   */
  pinned: boolean;
  /** The engine lays this day out: while true a drop can never be refused for a collision. */
  dayReflows: boolean;
  /** The dragged unit is locked, so the reflow will not lay it out either. */
  locked: boolean;
  /** The target day's MANUAL WINDOWS: the view every hand gesture is measured and cut over. */
  manualWindows: readonly WorkPeriod[];
  /** The ghost, in minutes from midnight. */
  startMinutes: number;
  durationMinutes: number;
}

export type DropEffectKind =
  | 'cut'
  /** The row underneath is covered from its very start: moved whole rather than cut. */
  | 'displace'
  /** The same job's row absorbs the drop: one row, hours SUMMED. */
  | 'merge'
  /** A locked row is in the way: refused, nothing written. */
  | 'blocked'
  /** A gap is in the way, on a day that pins: refused, nothing written. */
  | 'gap';

export interface DropEffect {
  kind: DropEffectKind;
  /** The row this happens to. Empty for a gap. */
  blockId: string;
  projectName: string;
  /** Where the row is cut, in minutes from midnight. Only meaningful for `cut`. */
  cutMinutes: number;
}

/**
 * Does this drop keep the minute it was released on? The drop's INTENT, not the last word: on a day
 * the engine reflows the server may slide it forward, or hand it back as a plain rank.
 */
export function dropPins(input: DropPin): boolean {
  return dropLandsLiterally(input);
}

/**
 * Does the engine lay this day out? The mirror of the engine's `dayReflows`, asked of what a
 * `WeekDay` carries. Deliberately NOT the pin question.
 */
export function dayReflowsOn(day: { role: DayRole; isClosed: boolean; isPast: boolean }): boolean {
  return !day.isClosed && day.role !== 'manual' && !day.isPast;
}

/**
 * What an ABSENCE dropped here will do, which is a different question with different answers: a gap
 * is never slid, never merged and never cut. Either the footprint covers a row the engine cannot
 * move — `assertGapFits` refuses the save naming it (`gap-over-fixed-block`) — or it covers ordinary
 * work, which the same transaction pushes forward.
 */
export interface GapEffect {
  kind: 'blocked' | 'displace';
  /** The job the sentence names: the first one in the way, in clock order. */
  projectName: string;
}

/**
 * `isMovable` reduces to "padlocked, or a weekend day" here, exactly as it does in `dropEffectOf`:
 * the drag layer refuses a past day outright, so the third way a row can be fixed cannot arrive.
 */
export function gapDropEffect(input: {
  /** Every row already on the target day. */
  rows: readonly DropRow[];
  dayIsWeekend: boolean;
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  /** Net working minutes: the absence's own total, cut at the break like everything else. */
  durationMinutes: number;
}): GapEffect | null {
  const footprint = dropFootprint(input);
  const covered = [...input.rows]
    .filter((row) => overlapsSegments(footprint, row.startMinutes, row.durationMinutes))
    .sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));

  // The refusal first, being the only outcome where nothing is saved at all.
  const fixed = covered.find((row) => row.locked || input.dayIsWeekend);
  if (fixed !== undefined) return { kind: 'blocked', projectName: fixed.project.name };
  const pushed = covered[0];
  return pushed === undefined ? null : { kind: 'displace', projectName: pushed.project.name };
}

export interface QueueRow {
  id: string;
  date: string;
  startMinutes: number;
  locked: boolean;
  project: { name: string };
}

/**
 * The row a re-ranked drop will fall in behind, or `null` when nothing in the week precedes it —
 * `null` rather than "it goes first", since the queue reaches back before the week on screen.
 */
export function dropPredecessor(
  /** Every MOVABLE row of the visible week, in queue order. */
  queue: readonly QueueRow[],
  movingBlockIds: readonly string[],
  date: string,
  startMinutes: number,
): QueueRow | null {
  let found: QueueRow | null = null;
  for (const row of queue) {
    if (movingBlockIds.includes(row.id)) continue;
    if (row.date > date || (row.date === date && row.startMinutes >= startMinutes)) break;
    found = row;
  }
  return found;
}

/**
 * The week's movable rows in queue order. The Friday buffer is IN it — an engine-placed Friday row
 * is still reclaimable — even though Friday is what decides whether a drop ONTO it pins.
 */
export function buildDropQueue(
  rows: readonly QueueRow[],
  isReflowingDate: (date: string) => boolean,
): QueueRow[] {
  return rows
    .filter((row) => !row.locked && isReflowingDate(row.date))
    .sort(
      (a, b) =>
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        a.startMinutes - b.startMinutes ||
        (a.id < b.id ? -1 : 1),
    );
}

export interface DropResolution {
  /**
   * The minute the row will be STORED at: the release point moved forward past the gaps and locks
   * the server will not let it share minutes with. Meaningless when `pinned` is false — there the
   * reflow picks the clock.
   */
  startMinutes: number;
  /** The row keeps `startMinutes` and comes back padlocked. */
  pinned: boolean;
  /** The drop moved DOWN the day to clear a gap or a lock, so it is not under the pointer. */
  slid: boolean;
  /** What it does to the row underneath, or `null` when it disturbs nothing. */
  effect: DropEffect | null;
}

/**
 * The whole answer the ghost needs, in the server's own two steps: a drop the engine still owns is
 * a queue RANK, refused for nothing and promising no minutes; a drop that PINS lands literally,
 * slid forward to the first slot clear of a gap and of a lock, and where the day has no such slot
 * the refusal stands, because the pin cannot be given up — it IS the padlock.
 */
export function resolveDropPreview(input: DropEffectInput): DropResolution {
  if (!input.pinned || !input.dayReflows) {
    return {
      startMinutes: input.startMinutes,
      pinned: input.pinned,
      slid: false,
      effect: dropEffectOf(input),
    };
  }

  const slid = firstClearStart({
    windows: input.manualWindows,
    immovable: [
      ...(input.gaps ?? []),
      ...input.rows.filter((row) => row.locked && !input.movingBlockIds.includes(row.id)),
    ].map((row) => ({ startMinutes: row.startMinutes, durationMinutes: row.durationMinutes })),
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
  });

  if (slid === null) {
    // Nowhere on this day to get clear: the server refuses it at the release point.
    return {
      startMinutes: input.startMinutes,
      pinned: true,
      slid: false,
      effect: dropEffectOf(input),
    };
  }
  const settled = { ...input, startMinutes: slid };
  return {
    startMinutes: slid,
    pinned: true,
    slid: slid !== input.startMinutes,
    effect: dropEffectOf(settled),
  };
}

/**
 * The one thing worth drawing, or `null` when the drop disturbs nothing — a refusal always wins,
 * being the only outcome where nothing is saved. It answers about the minute it is GIVEN; callers
 * on the grid go through `resolveDropPreview`, which asks at the stored minute.
 */
export function dropEffectOf(input: DropEffectInput): DropEffect | null {
  const footprint = dropFootprint(input);
  // A pinned drop lands where the reflow may not reach, so it collides with the fixed rows.
  const reflowed = !input.pinned;

  const overlapping = [...input.rows]
    .filter(
      (row) =>
        !input.movingBlockIds.includes(row.id) &&
        overlapsSegments(footprint, row.startMinutes, row.durationMinutes) &&
        // `isMovable` reduces to this here: the day is not past (the drag layer refuses those),
        // so a row is fixed iff the day is a weekend or the row is padlocked.
        (input.dayIsWeekend || row.locked) !== reflowed,
    )
    .sort((a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : 1));

  if (reflowed) {
    // A row starting at or after the drop already ranks behind it and is left alone. Nothing on
    // this side is ever refused: locks were filtered out, and the reflow keeps auto work off a gap.
    const victim = overlapping.find(
      (row) => row.projectId !== input.projectId && row.startMinutes < input.startMinutes,
    );
    return victim === undefined ? null : effect('cut', victim, input.startMinutes);
  }

  // The fixed side, in the server's own order: the SAME job folds first, then the two REFUSALS —
  // another job's lock, then a gap — then the cut.
  const sameJob = overlapping.find((row) => row.projectId === input.projectId);
  if (sameJob !== undefined) return effect('merge', sameJob, input.startMinutes);

  const locked = overlapping.find((row) => row.locked);
  if (locked !== undefined) return effect('blocked', locked, input.startMinutes);

  const covered = (input.gaps ?? []).find((candidate) =>
    overlapsSegments(footprint, candidate.startMinutes, candidate.durationMinutes),
  );
  if (covered !== undefined) return { kind: 'gap', blockId: '', projectName: '', cutMinutes: input.startMinutes };

  const victim = overlapping[0];
  if (victim === undefined) return null;
  // Nothing is left in FRONT of the drop, so there is no head to leave behind: the server
  // re-places the row's whole duration after the drop, reusing its id.
  const kind = input.startMinutes <= victim.startMinutes ? 'displace' : 'cut';
  return effect(kind, victim, Math.max(victim.startMinutes, input.startMinutes));
}

function effect(kind: DropEffectKind, row: DropRow, cutMinutes: number): DropEffect {
  return { kind, blockId: row.id, projectName: row.project.name, cutMinutes };
}

export function dropFootprint(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): DropSegment[] {
  return segmentDroppedRow(input.manualWindows, {
    startMinutes: input.startMinutes,
    durationMinutes: input.durationMinutes,
  });
}

/**
 * The footprint AS IT IS DRAWN: the same segments, capped at the net minutes this day can still
 * hold from that start, so the shape is one that can exist. `dropFootprint` is the STORAGE answer
 * and returns a stretch UNCUT when its tail would pass midnight. Deliberately NOT used for the
 * collision test, which still measures the uncut footprint.
 */
export function footprintWithinDay(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): DropSegment[] {
  const holds = netMinutesBetween(
    input.manualWindows,
    input.startMinutes,
    dayEndMinutes(input.manualWindows),
  );
  // Past the last window there are no working minutes ahead at all, and the release keeps its own
  // latitude not to be cut. A start inside the BREAK is not one of these: it reads as 15:30.
  if (holds <= 0 || input.durationMinutes <= holds) return dropFootprint(input);
  return dropFootprint({ ...input, durationMinutes: holds });
}

/**
 * The clock minute the gesture ends at, or `null` when it does not end on this day at all —
 * `durationMinutes` is NET WORKING minutes, and a drag's is the whole RUN's across days. A caller
 * that gets `null` must say something other than a time.
 */
export function footprintEnd(input: {
  manualWindows: readonly WorkPeriod[];
  startMinutes: number;
  durationMinutes: number;
}): number | null {
  const segments = dropFootprint(input);
  const last = segments[segments.length - 1];
  const end = last.startMinutes + last.durationMinutes;
  return end > dayEndMinutes(input.manualWindows) ? null : end;
}

/**
 * Can this day hold `durationMinutes` of work from ANY start? The drag layer's clamp cannot answer
 * it: `latestStartFor` falls back to the first window's start when nothing fits, so the clamp would
 * report 07:00 as «the latest start» for a run no start could hold.
 */
export function dayHoldsMinutes(
  manualWindows: readonly WorkPeriod[],
  durationMinutes: number,
): boolean {
  return durationMinutes <= netMinutesOf(manualWindows);
}
