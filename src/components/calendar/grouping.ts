/**
 * Turning a day's rows into what the owner should see.
 *
 * Two jobs, both pure:
 *
 * 1. GROUPING. A block never straddles a non-working interval, so three hours of work
 *    across the lunch break are stored as two rows (13:00-14:00 and 15:30-17:30).
 *    CLAUDE.md: they are drawn as "one grouped unit (outer rounded corners, label on
 *    the first, single drag handle) so the owner still sees and moves one 3h job".
 *    That grouping is also what the ENGINE does — `buildQueue` merges consecutive
 *    rows of the same project into a single queue item — so a group is exactly one
 *    thing to drag, not a UI illusion.
 *
 * 2. LANES. The engine never overlaps rows, but the owner can: a weekend or a past day
 *    accepts hand-placed work with no overlap check (deliberately, so a legitimate
 *    hand-made state stays savable). Two rows at the same time must not hide each
 *    other, so overlapping items share the column's width.
 */

import type { Gap, WorkPeriod } from '../../types';
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
  /**
   * The rows of the unit whose LENGTH was set by hand, in clock order.
   *
   * `locked` above is rolled up into one boolean because its only consumer asks a
   * yes/no question about the whole unit. A hand-set length cannot be, for two
   * reasons that pull in opposite directions: the unit is one gesture on screen
   * (one resize handle, one *back to automatic*), but the mark is per row — a
   * hand-set stretch cut at the lunch break comes back as TWO marked rows, and a
   * hand-set row can sit next to an automatic row of the same job, which is exactly
   * why the engine refuses to join them into one queue item.
   *
   * So the group carries the ids instead of a flag: empty means the engine owns the
   * unit's length, non-empty is precisely what the release action must send, and
   * `length === blocks.length` means the whole unit is the length the owner drew.
   */
  manualBlockIds: string[];
}

/** One row, with the group it belongs to and its place in it. */
export interface BlockSegment {
  block: WeekBlock;
  group: BlockGroup;
  index: number;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * A day's groups, in clock order.
 *
 * Two rows join when the working time between them is zero — which is true both for
 * rows that touch and for the two halves around lunch, and false when a gap or
 * another job sits between them. Same rule, no special case for the lunch break.
 */
export function groupBlocks(
  blocks: readonly WeekBlock[],
  periods: readonly WorkPeriod[],
): BlockGroup[] {
  const ordered = [...blocks].sort(byClockThenId);
  const groups: BlockGroup[] = [];

  for (const block of ordered) {
    const open = groups[groups.length - 1];
    const joins =
      open !== undefined &&
      open.projectId === block.projectId &&
      block.startMinutes >= open.endMinutes &&
      workingMinutesBetween(periods, open.endMinutes, block.startMinutes) === 0;

    if (joins) {
      open.blocks.push(block);
      open.totalMinutes += block.durationMinutes;
      open.endMinutes = block.startMinutes + block.durationMinutes;
      open.locked = open.locked && block.locked;
      if (block.manualDuration) open.manualBlockIds.push(block.id);
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
      manualBlockIds: block.manualDuration ? [block.id] : [],
    });
  }

  return groups;
}

/** Every row of every group, flattened, so the grid can map straight to elements. */
export function segmentsOf(groups: readonly BlockGroup[]): BlockSegment[] {
  const segments: BlockSegment[] = [];
  for (const group of groups) {
    group.blocks.forEach((block, index) => {
      segments.push({
        block,
        group,
        index,
        isFirst: index === 0,
        isLast: index === group.blocks.length - 1,
      });
    });
  }
  return segments;
}

/** Working minutes inside `[from, to)`. Zero across the lunch break and the margins. */
export function workingMinutesBetween(
  periods: readonly WorkPeriod[],
  from: number,
  to: number,
): number {
  if (to <= from) return 0;
  let total = 0;
  for (const period of periods) {
    total += Math.max(0, Math.min(period.endMinutes, to) - Math.max(period.startMinutes, from));
  }
  return total;
}

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
 * Side-by-side placement for items that overlap in time.
 *
 * Greedy over a cluster (a run of items connected by overlap): each item takes the
 * first lane whose previous occupant has already ended, and every item in the cluster
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

/** Groups and gaps share the column, so they are packed together. */
export function packDay(groups: readonly BlockGroup[], gaps: readonly Gap[]): Map<string, LanePlacement> {
  return assignLanes([
    ...groups.map((group) => ({ id: group.id, startMinutes: group.startMinutes, endMinutes: group.endMinutes })),
    ...gaps.map((gap) => ({
      id: gap.id,
      startMinutes: gap.startMinutes,
      endMinutes: gap.startMinutes + gap.durationMinutes,
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
