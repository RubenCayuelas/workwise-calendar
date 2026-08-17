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
 *    accepts work placed by hand with no overlap check (deliberately, so a legitimate
 *    hand-made state stays savable). Two rows at the same time must not hide each
 *    other, so overlapping items share the column's width.
 */

import { adjacentInWindows } from '../../lib/manualWindow';
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
   * The rows of the unit whose LENGTH was set by hand, in clock order — and therefore
   * exactly what *back to automatic* sends. Empty means the engine already owns the unit's
   * length and the action is absent rather than disabled.
   *
   * `locked` above is rolled up into one boolean because its only consumer asks a
   * yes/no question about the whole unit. A hand-set length cannot be, for two
   * reasons that pull in opposite directions: the unit is one gesture on screen
   * (one resize handle, one *back to automatic*), but the mark is per row — a
   * hand-set stretch cut at the lunch break comes back as TWO marked rows, and a
   * hand-set row can sit next to an automatic row of the same job, which is exactly
   * why the engine refuses to join them into one queue item.
   *
   * There is no second list next to it any more. While the pin was a mark of its own
   * (`hand_placed`) the release cleared both and had to be offered for either, so the
   * group carried a wider set; now the pin IS the padlock, undone by pressing the padlock,
   * and *back to automatic* means one thing again.
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
  /**
   * THE BREAK BETWEEN TWO WINDOWS — the lunch break — separates this row from the previous
   * / next row of its unit. That, and only that, is what the "· sigue…" marks, the dashed
   * seam and the "después de la comida" tooltip are allowed to say.
   *
   * NOT the same question as `isFirst` / `isLast`, which is where the ROUNDED CORNERS come
   * from, and telling the two apart is a defect fix (2026-08-13, found by dragging). A
   * unit joins two rows when nothing WORKABLE separates them, which is true in two more
   * cases than "cut at lunch":
   *
   * - THE ROWS TOUCH, with no hole at all. Reachable whenever auto-merge may not fold
   *   them: the scissors moving an hour into the top margin leaves a padlocked
   *   `07:00-08:00` against `08:00-11:00`, one contiguous rectangle, and read off
   *   `!isFirst`/`!isLast` every mark was drawn straight down the middle of it while the
   *   tooltip announced a lunch break three hours away.
   * - THE HOLE IS A MARGIN THE OWNER HAS SINCE SET TO 0, so those minutes stopped being
   *   workable and two units became one. The hole is real but it is not the comida.
   *
   * Both are excluded by asking the day's windows rather than the row's position: the hole
   * has to START where a window ends and END where the next one starts.
   */
  seamAbove: boolean;
  seamBelow: boolean;
}

/**
 * A day's groups, in clock order.
 *
 * Two rows join when nothing WORKABLE separates them — which is true both for rows that
 * touch and for the two halves around lunch, and false when a gap, another job, or free
 * time sits between them. Same rule, no special case for the lunch break.
 *
 * Read over the day's MANUAL WINDOWS (`adjacentInWindows`, src/lib/manualWindow.ts), which
 * is also the predicate the server's resize uses to find the stretch it is sizing — so a
 * unit on screen and a stretch on the server can never disagree about where one ends. The
 * periods alone would call a row in the top margin and one starting at 08:00 contiguous,
 * because the margin between them is not working time to the ENGINE, and draw the pair as
 * one unit with a phantom seam.
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

/**
 * Every row of every group, flattened, so the grid can map straight to elements.
 *
 * Each row is also told whether the LUNCH BREAK sits above and below it inside its unit —
 * see `seamAbove` / `seamBelow`, which is what the "· sigue…" marks are drawn from. That
 * is asked of the same `manualWindows` the grouping used, because a unit can also hold rows
 * that touch and rows separated by time that has stopped being workable, and a mark on
 * either would be saying something untrue.
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

/**
 * True when `[from, to)` is the break BETWEEN two manual windows — on the documented shift,
 * 14:00-15:30 and nothing else.
 *
 * It has to start exactly where one window ends and finish exactly where the next begins.
 * Two rows that touch give `to === from` and fail the first test; a hole left by a margin
 * the owner has since set to 0 starts nowhere in particular and fails it too. Grouping has
 * already guaranteed no window overlaps the stretch, so nothing else has to be checked.
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
 * A RUN — consecutive units of one job with no other job's work between them, across days.
 *
 * THE UNIT OF A DRAG IS THIS, not the block and not the job (decided with the owner,
 * 2026-08-14). Their own words are the rule:
 *
 * > «Mueve el trabajo si este no ha sido dividido. Si tengo pedazos de hoy por la mañana,
 * > hoy por la tarde y pasado por la mañana, todo eso si no lo he dividido yo a mano (no
 * > hay ninguna tarea en medio) muevo todo hasta la tarea que los separe, indicativo de
 * > que esa división la he hecho yo.»
 *
 * So the lunch break does not break a run (nothing is between the pieces), a night does
 * not break one either, and ANOTHER JOB does — because that separation is the owner's own
 * decision and the drag has to respect it and stop there.
 *
 * That is exactly the engine's `QueueItem` (src/lib/composition.ts), and this is read the
 * same way on purpose: the engine will lay the run out as one item however it is dragged,
 * so a drag that moved anything else would be arguing with the reflow. Two consequences
 * fall straight out of `buildQueue`:
 *
 * - A UNIT THE ENGINE NEVER MOVES IS SKIPPED, not treated as a separator. Fixed work
 *   (padlocked, weekend, past) is an obstacle the reflow flows around, so it does not end
 *   the run — and it is its own drag unit, because dragging it is a literal placement.
 * - A HAND-SET LENGTH ENDS THE RUN. `buildQueue` never joins a hand-set stretch to an
 *   automatic one, and never joins two of them across days; the drag must not either, or
 *   it would promise to move hours the engine is about to separate again.
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
 * Every group's run, keyed by group id.
 *
 * Built for the whole week in one pass rather than per column, because a run's other half
 * is usually on another day — which is the entire reason this exists.
 *
 * `isMovable` is the caller's mirror of the engine's predicate (unlocked, not past, not a
 * weekend); the grid has the day flags and this file has no business re-deriving them.
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
    // Fixed work is an obstacle, never a separator: the run continues past it, and it
    // drags on its own.
    if (!group.blocks.some(isMovable)) {
      runs.set(group.id, runOf([group]));
      continue;
    }
    // A hand-set stretch is its own queue item wherever it sits, so it is its own run and
    // it ends whatever run was open.
    if (group.blocks.some((block) => block.manualDuration)) {
      close();
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
 * Working minutes inside `[from, to)`. Zero across the lunch break and the margins when
 * given the periods; zero only across the lunch break when given the manual windows.
 *
 * Re-exported from src/lib/manualWindow.ts rather than implemented here: the same
 * arithmetic decides a unit on screen, a stretch on the server and the net minutes a
 * resize is saved with, and three copies of it would drift the first time the shift is
 * reconfigured.
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
