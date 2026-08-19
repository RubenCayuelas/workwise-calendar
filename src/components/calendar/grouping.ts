/**
 * A day's rows as what the owner should see, pure. GROUPING: rows of one job with nothing workable
 * between them are drawn as one unit, which is also what the engine's `buildQueue` does, so a group is
 * one thing to drag rather than a UI illusion. LANES: the engine never overlaps rows but a hand
 * placement on a weekend or a past day can, so overlapping items share the column's width.
 */

import { adjacentInWindows } from '../../lib/manualWindow';
import type { Gap, GapUnit, WorkPeriod } from '../../types';
import type { WeekBlock } from '../../lib/api-client';

/** Consecutive rows of one job on one day, drawn as a single unit. */
export interface BlockGroup {
  /** The first row's id. Stable as long as the group is. */
  id: string;
  projectId: string;
  date: string;
  /** In clock order. Always at least one. */
  blocks: WeekBlock[];
  /** The work the unit represents — the "3 h" of a job split around lunch. */
  totalMinutes: number;
  startMinutes: number;
  /** End of the last row. Includes the lunch break it spans, unlike `totalMinutes`. */
  endMinutes: number;
  /** True only when every row of the group is locked. */
  locked: boolean;
}

/** One row, with the group it belongs to and its place in it. */
export interface BlockSegment {
  block: WeekBlock;
  group: BlockGroup;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  /**
   * The BREAK BETWEEN TWO WINDOWS — the lunch break — separates this row from the previous / next row
   * of its unit. That, and only that, is what the "· sigue…" marks, the dashed seam and the tooltip may
   * say. NOT the same question as `isFirst` / `isLast`, which is where the ROUNDED CORNERS come from: a
   * unit also joins rows that TOUCH and rows split by a margin the owner has since set to 0.
   */
  seamAbove: boolean;
  seamBelow: boolean;
}

/**
 * A day's groups, in clock order. Two rows join when nothing WORKABLE separates them — true for rows
 * that touch and for the two halves around lunch, false when a gap, another job or free time sits
 * between them. Read over the day's MANUAL WINDOWS, the same predicate the server's resize uses to find
 * the stretch it is sizing, so screen and server cannot disagree about where a unit ends. The periods
 * alone would call a row in the top margin and one starting at 08:00 contiguous.
 */
export function groupBlocks(
  blocks: readonly WeekBlock[],
  manualWindows: readonly WorkPeriod[],
): BlockGroup[] {
  const ordered = [...blocks].sort(byClockThenId);
  const groups: BlockGroup[] = [];

  for (const block of ordered) {
    const open = groups[groups.length - 1];
    const joins =
      open !== undefined &&
      open.projectId === block.projectId &&
      adjacentInWindows(manualWindows, open.endMinutes, block.startMinutes);

    if (joins) {
      open.blocks.push(block);
      open.totalMinutes += block.durationMinutes;
      open.endMinutes = block.startMinutes + block.durationMinutes;
      open.locked = open.locked && block.locked;
      continue;
    }

    groups.push({
      id: block.id,
      projectId: block.projectId,
      date: block.date,
      blocks: [block],
      totalMinutes: block.durationMinutes,
      startMinutes: block.startMinutes,
      endMinutes: block.startMinutes + block.durationMinutes,
      locked: block.locked,
    });
  }

  return groups;
}

/**
 * Every row of every group, flattened, so the grid can map straight to elements. Each row is also told
 * whether the lunch break sits above and below it inside its unit (`seamAbove` / `seamBelow`), asked of
 * the same `manualWindows` the grouping used.
 */
export function segmentsOf(
  groups: readonly BlockGroup[],
  manualWindows: readonly WorkPeriod[] = [],
): BlockSegment[] {
  const segments: BlockSegment[] = [];
  for (const group of groups) {
    group.blocks.forEach((block, index) => {
      const previous = group.blocks[index - 1];
      const next = group.blocks[index + 1];
      segments.push({
        block,
        group,
        index,
        isFirst: index === 0,
        isLast: index === group.blocks.length - 1,
        seamAbove:
          previous !== undefined &&
          isWindowBreak(manualWindows, previous.startMinutes + previous.durationMinutes, block.startMinutes),
        seamBelow:
          next !== undefined &&
          isWindowBreak(manualWindows, block.startMinutes + block.durationMinutes, next.startMinutes),
      });
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// The same question, asked of gaps
// ---------------------------------------------------------------------------

/** Consecutive rows of ONE gap on one day, drawn as a single unit. */
export interface GapGroup {
  /** The first row's id. Stable as long as the group is. */
  id: string;
  /** What makes these rows ONE absence. Any of them addresses the whole of it. */
  unitId: string;
  date: string;
  /** In clock order. Always at least one. */
  gaps: Gap[];
  /** The time the unit reserves — the "10 h" of a gap split around lunch. */
  totalMinutes: number;
  startMinutes: number;
  /** End of the last row. Includes the lunch break it spans, unlike `totalMinutes`. */
  endMinutes: number;
  /** The reason every row of the unit carries. The halves of one gap share it. */
  reason: string;
}

/** One gap row, with the unit it belongs to and its place in it. */
export interface GapSegment {
  gap: Gap;
  group: GapGroup;
  isFirst: boolean;
  isLast: boolean;
  /** The break between two windows separates this row from the previous / next row of its unit. */
  seamAbove: boolean;
  seamBelow: boolean;
}

/**
 * A day's gap units, in clock order, grouped by `unit_id` ALONE.
 *
 * Where a block's unit has to be DERIVED — `groupBlocks` reads `projectId` plus adjacency, because
 * nothing stored says which rows are one run — a gap's is a stored fact. Asking for adjacency on top
 * of it can therefore only DISAGREE with the write path, which always addresses the whole unit:
 * another absence's row sorting between the two halves made the grid draw one unit as two, each
 * labelled with half the hours, and a gesture on either then edited the whole absence while claiming
 * to edit half of it.
 */
export function groupGaps(gaps: readonly Gap[], _manualWindows: readonly WorkPeriod[] = []): GapGroup[] {
  const byUnit = new Map<string, GapGroup>();

  for (const gap of [...gaps].sort(
    (a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )) {
    const open = byUnit.get(gap.unitId);
    if (open === undefined) {
      byUnit.set(gap.unitId, {
        id: gap.id,
        unitId: gap.unitId,
        date: gap.date,
        gaps: [gap],
        totalMinutes: gap.durationMinutes,
        startMinutes: gap.startMinutes,
        endMinutes: gap.startMinutes + gap.durationMinutes,
        reason: gap.reason ?? '',
      });
      continue;
    }
    open.gaps.push(gap);
    open.totalMinutes += gap.durationMinutes;
    open.startMinutes = Math.min(open.startMinutes, gap.startMinutes);
    open.endMinutes = Math.max(open.endMinutes, gap.startMinutes + gap.durationMinutes);
  }

  return [...byUnit.values()].sort(
    (a, b) => a.startMinutes - b.startMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The ABSENCE a unit is: its first row's id, the day, the start and the NET TOTAL of its rows. This
 * is what the form edits and what both gestures send, because `PATCH /api/gaps/:id` addresses the
 * whole unit through any of its rows — a 10 h absence opened by its `08:00 +6 h` half and saved
 * unchanged came back 6 h long, the afternoon row deleted by the reconcile.
 */
export function gapUnitOf(group: GapGroup): GapUnit {
  return {
    id: group.id,
    date: group.date,
    startMinutes: group.startMinutes,
    durationMinutes: group.totalMinutes,
    // `Gap.reason` is absent rather than empty when there is none, and the form asks for `??  ''`.
    reason: group.reason === '' ? undefined : group.reason,
  };
}

/** Every row of every gap unit, flattened, each told where the break falls inside its unit. */
export function gapSegmentsOf(
  groups: readonly GapGroup[],
  manualWindows: readonly WorkPeriod[] = [],
): GapSegment[] {
  const segments: GapSegment[] = [];
  for (const group of groups) {
    group.gaps.forEach((gap, index) => {
      const previous = group.gaps[index - 1];
      const next = group.gaps[index + 1];
      segments.push({
        gap,
        group,
        isFirst: index === 0,
        isLast: index === group.gaps.length - 1,
        seamAbove:
          previous !== undefined &&
          isWindowBreak(manualWindows, previous.startMinutes + previous.durationMinutes, gap.startMinutes),
        seamBelow:
          next !== undefined &&
          isWindowBreak(manualWindows, gap.startMinutes + gap.durationMinutes, next.startMinutes),
      });
    });
  }
  return segments;
}

/**
 * True when `[from, to)` is the break BETWEEN two manual windows — 14:00-15:30 and nothing else on the
 * documented shift. It must start exactly where one window ends and finish where the next begins: two
 * rows that touch give `to === from`, and a hole left by a margin set to 0 starts nowhere in particular.
 */
function isWindowBreak(
  manualWindows: readonly WorkPeriod[],
  from: number,
  to: number,
): boolean {
  if (to <= from) return false;
  return (
    manualWindows.some((window) => window.endMinutes === from) &&
    manualWindows.some((window) => window.startMinutes === to)
  );
}

// ---------------------------------------------------------------------------
// Runs: the unit a DRAG moves
// ---------------------------------------------------------------------------

/**
 * A RUN — consecutive units of one job with no other job's work between them, across days — and the unit
 * a DRAG moves. The lunch break does not break one, a night does not, another job does. It is exactly
 * the engine's `QueueItem`, read the same way on purpose: the engine lays the run out as one item
 * however it is dragged, so a drag that moved anything else would be arguing with the reflow. A unit the
 * engine never moves is SKIPPED rather than treated as a separator, and drags on its own.
 */
export interface BlockRun {
  /** Every row of the run in queue order, across days. What the request names. */
  blockIds: string[];
  /** The run's net working minutes — what the ghost draws. */
  totalMinutes: number;
  /** The run's head: the first row's day and start. */
  date: string;
  startMinutes: number;
}

/**
 * Every group's run, keyed by group id. Built for the whole week in one pass rather than per column,
 * because a run's other half is usually on another day — the entire reason this exists. `isMovable` is
 * the caller's mirror of the engine's predicate; the grid has the day flags, and this file has no
 * business re-deriving them.
 */
export function buildRuns(
  groups: readonly BlockGroup[],
  isMovable: (block: WeekBlock) => boolean,
): Map<string, BlockRun> {
  const ordered = [...groups].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.startMinutes - b.startMinutes,
  );

  const runs = new Map<string, BlockRun>();
  let open: BlockGroup[] = [];

  const close = (): void => {
    if (open.length === 0) return;
    const run = runOf(open);
    for (const group of open) runs.set(group.id, run);
    open = [];
  };

  for (const group of ordered) {
    // Fixed work is an obstacle, never a separator: the run continues past it, and it drags alone.
    if (!group.blocks.some(isMovable)) {
      runs.set(group.id, runOf([group]));
      continue;
    }
    if (open.length > 0 && open[0].projectId === group.projectId) {
      open.push(group);
      continue;
    }
    close();
    open = [group];
  }
  close();

  return runs;
}

function runOf(groups: readonly BlockGroup[]): BlockRun {
  return {
    blockIds: groups.flatMap((group) => group.blocks.map((block) => block.id)),
    totalMinutes: groups.reduce((total, group) => total + group.totalMinutes, 0),
    date: groups[0].date,
    startMinutes: groups[0].startMinutes,
  };
}

/**
 * Working minutes inside `[from, to)`. Re-exported rather than implemented here: the same arithmetic
 * decides a unit on screen, a stretch on the server and the net minutes a resize is saved with, and
 * three copies would drift the first time the shift is reconfigured.
 */
export { netMinutesBetween as workingMinutesBetween } from '../../lib/manualWindow';

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface LaneItem {
  id: string;
  startMinutes: number;
  endMinutes: number;
}

export interface LanePlacement {
  /** 0-based column within the cluster. */
  lane: number;
  /** How many lanes the cluster needs. 1 for everything that overlaps nothing. */
  lanes: number;
}

/**
 * Side-by-side placement for items that overlap in time. Greedy over a cluster (items connected by
 * overlap): each takes the first lane whose previous occupant has ended, and every item in the cluster
 * reports the same `lanes` so their widths match.
 */
export function assignLanes(items: readonly LaneItem[]): Map<string, LanePlacement> {
  const ordered = [...items].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const placements = new Map<string, LanePlacement>();

  let cluster: LaneItem[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = (): void => {
    const lanes = Math.max(1, laneEnds.length);
    for (const item of cluster) {
      const placement = placements.get(item.id);
      if (placement !== undefined) placement.lanes = lanes;
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of ordered) {
    if (item.startMinutes >= clusterEnd) flush();

    let lane = laneEnds.findIndex((end) => end <= item.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMinutes);
    } else {
      laneEnds[lane] = item.endMinutes;
    }

    placements.set(item.id, { lane, lanes: 1 });
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMinutes);
  }

  flush();
  return placements;
}

/**
 * Groups and gaps share the column, so they are packed together — both as UNITS, so the two halves of
 * one gap take one lane between them instead of each claiming its own.
 */
export function packDay(
  groups: readonly BlockGroup[],
  gaps: readonly GapGroup[],
): Map<string, LanePlacement> {
  return assignLanes([
    ...groups.map((group) => ({ id: group.id, startMinutes: group.startMinutes, endMinutes: group.endMinutes })),
    ...gaps.map((group) => ({
      id: group.id,
      startMinutes: group.startMinutes,
      endMinutes: group.endMinutes,
    })),
  ]);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The same total order the engine uses within a day, so the UI cannot disagree. */
function byClockThenId(a: WeekBlock, b: WeekBlock): number {
  if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
