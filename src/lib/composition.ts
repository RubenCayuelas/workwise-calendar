/**
 * The composition engine: a pure function over a snapshot, schedule state in and placement out. It
 * never touches the database, never reads the clock (`today` is an input) and returns i18n keys
 * rather than prose, which is what makes the engine's rules testable. Integer minutes.
 */

import type { Block, DayOverride, DayShape, Gap, WorkPeriod } from '../types';
import {
  FRIDAY,
  MINUTES_PER_DAY,
  addDays,
  compareDates,
  hoursToMinutes,
  isWeekend,
  weekdayOf,
} from './dates';
import { overlapsSegments, segmentDroppedRow, type DropSegment } from './dropSegments';
import { firstClearStart } from './dropSlide';
// The quarter-hour floor on a split. Shared with the drag ghost via src/lib/dropSpill.ts.
import { takeableFrom } from './dropSpill';
import { adjacentInWindows, clockEndOf, dayEndMinutes, type DayWindows } from './manualWindow';
import { MIN_ROW_MINUTES } from './validation';

export const HORIZON_EXCEEDED_KEY = 'errors.horizonExceeded';

const DAYS_PER_WEEK = 7;

/** A provisional row's rank must stay a valid time of day. */
const MAX_RANK_MINUTES = 1439;

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

/** How the engine may treat a day: `auto` Mon-Thu, `buffer` Friday, `manual` the weekend. */
export type DayRole = 'auto' | 'buffer' | 'manual';

/**
 * One day as the engine reads it; `getDayConfig(date)` is its only source. It carries BOTH views
 * (`DayWindows`): auto-fill is stated over `periods`, every hand gesture over `manualWindows`.
 */
export interface DayConfig extends DayWindows {
  /** Working periods, chronological and non-overlapping (morning, afternoon). */
  periods: readonly WorkPeriod[];
  /** The periods plus the visual margins, fused where they touch. Auto-fill never sees it. */
  manualWindows: readonly WorkPeriod[];
  /** The auto-fill stop line for this day, in minutes. Never a limit on manual placement. */
  capacityMinutes: number;
  role: DayRole;
  /** A holiday or a closed week: no plannable time at all, whatever `role` says. */
  isClosed: boolean;
}

/**
 * The standard resolver: global settings, then the weekday rule, then `day_overrides`. Pure. An
 * override's `capacityHours` is still capped at the shift — capacity stops auto-fill early, it
 * never books hours the periods do not cover.
 */
export function createDayConfigResolver(
  shape: DayShape,
  overrides: readonly DayOverride[] = [],
): (date: string) => DayConfig {
  const byDate = new Map<string, DayOverride>();
  for (const override of overrides) byDate.set(override.date, override);

  const shiftMinutes = totalPeriodMinutes(shape.periods);
  const defaultCapacity = clamp(shape.capacityMinutes, 0, shiftMinutes);

  return (date: string): DayConfig => {
    const override = byDate.get(date);
    const capacityHours = override?.capacityHours;
    return {
      periods: shape.periods,
      manualWindows: shape.manualWindows,
      capacityMinutes:
        capacityHours === null || capacityHours === undefined
          ? defaultCapacity
          : clamp(hoursToMinutes(capacityHours), 0, shiftMinutes),
      role: roleOf(date),
      isClosed: override?.isClosed ?? false,
    };
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ComposeInput {
  /** Local `YYYY-MM-DD`. The engine never writes to an earlier date. */
  today: string;

  /**
   * The calendar as it stands, in any order; whatever is passed comes back in the result.
   *
   * A block's `date`/`startMinutes` are its QUEUE RANK as much as its position, so a caller inserts
   * work by writing a provisional row whose start sorts where the user aimed. That row may carry the
   * job's whole duration; the engine re-segments the movable pool anyway.
   */
  blocks: readonly Block[];

  /** Fixed occupancy. Gaps consume plannable minutes and are never modified. */
  gaps: readonly Gap[];

  getDayConfig: (date: string) => DayConfig;

  /** Auto-placement never creates a block beyond this many weeks from `today`. */
  planningHorizonWeeks: number;

  /**
   * Projects created in this same operation. Their work never targets the Friday buffer, wherever
   * the caller parked the provisional row — including on a Friday itself.
   */
  newProjectIds?: readonly string[];

  /**
   * Projects whose hours THIS operation raised: the ONLY way new hours reach the buffer, so leave it
   * empty for a deletion, a drag, a gap, a capacity change or a rename. Work ALREADY on a Friday is
   * not pushed off it by an unrelated save — see `QueueItem.originalDates`.
   */
  grownProjectIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One row of the recomposed calendar. */
export interface PlacedBlock {
  /**
   * The row this segment reuses, or `null` when the caller must INSERT it. An item's segments
   * reuse the ids of the blocks it was built from, in order; ids left over are in `deletedBlockIds`.
   */
  id: string | null;
  projectId: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  locked: boolean;
}

export type ComposeErrorCode = 'horizon-exceeded';

/** The only way composition fails. */
export interface ComposeError {
  code: ComposeErrorCode;
  /** i18n key, never a translated sentence. */
  messageKey: string;
  /** The project whose hours ran past the horizon. */
  projectId: string;
  unplacedMinutes: number;
  /** The last date auto-placement was allowed to use. */
  horizonEndDate: string;
}

export interface ComposeSuccess {
  ok: true;
  /** The whole calendar after recomposition, fixed rows included. Sorted by date, then start. */
  blocks: PlacedBlock[];
  /** Input ids absent from `blocks`: rows the caller must DELETE. */
  deletedBlockIds: string[];
}

export interface ComposeFailure {
  ok: false;
  error: ComposeError;
}

export type ComposeResult = ComposeSuccess | ComposeFailure;

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * One unit of work the engine places as a single indivisible piece: a run of consecutive movable
 * blocks of the same project, with no OTHER MOVABLE project between them in queue order, so
 * `B, A, C, A` stays four items. A fixed block (locked, past, weekend) does NOT break a run.
 *
 * DO NOT DERIVE GROUPING FROM THE PLACEMENT. The reflow is derived from the grouping, so if a
 * fixed block split a run, moving the run past that block — which the reflow does all the time —
 * would regroup the queue and lay the same hours out differently on the NEXT recomposition.
 * Movable order the reflow preserves, so grouping on it alone makes `compose` a fixed point; see
 * the regression test "recomposing twice is not a second reflow".
 */
export interface QueueItem {
  projectId: string;
  /** The blocks this item was built from, in queue order. */
  blockIds: string[];
  durationMinutes: number;
  isNew: boolean;
  grown: boolean;
  /**
   * The dates this item's rows already sit on. Only consulted for the Friday buffer, where it is
   * what keeps an unrelated save from pushing absorbed overflow off Friday and into next week.
   */
  originalDates: string[];
}

/**
 * The rows drawn as one unit with `target` — the RUN the owner actually grabs.
 *
 * A transcription of the grid's two steps in the grid's order, so a unit on screen and a unit here
 * cannot disagree: `groupBlocks` then `buildRuns`. It must NOT filter to the target's own date —
 * that made every cross-day run move only its first day's part.
 */
export function unitOf(
  blocks: readonly Block[],
  target: Block,
  windowsOf: (date: string) => readonly WorkPeriod[],
  today: string,
): Block[] {
  // 1. The rectangles the grid draws.
  const groups: Block[][] = [];
  for (const row of sortedByQueueRank(blocks)) {
    const open = groups[groups.length - 1];
    const last = open?.[open.length - 1];
    const joins =
      last !== undefined &&
      last.date === row.date &&
      last.projectId === row.projectId &&
      adjacentInWindows(
        windowsOf(row.date),
        last.startMinutes + last.durationMinutes,
        row.startMinutes,
      );
    if (joins) open.push(row);
    else groups.push([row]);
  }

  // 2. The runs those rectangles belong to.
  const runs: Block[][] = [];
  let open: Block[] | null = null;
  for (const group of groups) {
    if (!group.some((row) => isMovable(row, today))) {
      // Fixed work: its own unit, and the open run survives past it.
      runs.push(group);
      continue;
    }
    if (open !== null && open[0].projectId === group[0].projectId) {
      open.push(...group);
      continue;
    }
    open = [...group];
    runs.push(open);
  }

  return runs.find((run) => run.some((row) => row.id === target.id)) ?? [target];
}

/**
 * Queue order is `date, start_time`, plus `createdAt` then `id` as tiebreakers so it is total and
 * the engine deterministic. Fixed blocks are obstacles, not queue items, and are skipped without
 * breaking the run around them — see `QueueItem` for why that has to be so.
 */
export function buildQueue(input: ComposeInput): QueueItem[] {
  const newProjects = new Set(input.newProjectIds ?? []);
  const grownProjects = new Set(input.grownProjectIds ?? []);
  const items: QueueItem[] = [];
  let open: QueueItem | null = null;

  for (const block of sortedByQueueRank(input.blocks)) {
    if (!isMovable(block, input.today)) continue;
    // Only a movable block of ANOTHER job ends a run, which is the whole of the grouping rule.
    if (open !== null && open.projectId === block.projectId) {
      open.blockIds.push(block.id);
      open.durationMinutes += block.durationMinutes;
      if (!open.originalDates.includes(block.date)) open.originalDates.push(block.date);
      continue;
    }
    open = {
      projectId: block.projectId,
      blockIds: [block.id],
      durationMinutes: block.durationMinutes,
      isNew: newProjects.has(block.projectId),
      grown: grownProjects.has(block.projectId),
      originalDates: [block.date],
    };
    items.push(open);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Predicates and arithmetic
// ---------------------------------------------------------------------------

/**
 * The movable pool, and it is the single line below. Which places EARN a padlock is the
 * CALLER's policy (`pinsTheRow` in operations/blocks.ts), never the engine's.
 */
export function isMovable(block: Block, today: string): boolean {
  if (block.locked) return false;
  if (compareDates(block.date, today) < 0) return false;
  return !isWeekend(block.date);
}

/**
 * WHETHER THE REFLOW LAYS THE DAY OUT AT ALL — not "will it move this row", which is `isMovable`.
 * The two must not be confused: this is what says whether a drop here may be REFUSED for a
 * collision, and "does the footprint fit as the calendar stands right now" is circular on a day the
 * engine reflows, since moving the row off its current day is what opens the room here.
 */
export function dayReflows(config: DayConfig, date: string, today: string): boolean {
  if (config.isClosed || config.role === 'manual') return false;
  return compareDates(date, today) >= 0;
}

/**
 * The minutes the engine may fill on `date`. Zero for a closed day,
 * a `manual` day and any date before today.
 */
export function plannableMinutes(input: ComposeInput, date: string): number {
  return buildDayPlan(input, date).plannableMinutes;
}

/** The last date auto-placement may use: `today + planningHorizonWeeks * 7 − 1` days. */
export function horizonEndDate(today: string, planningHorizonWeeks: number): string {
  // Below one week the engine would have nowhere to write at all; `writeSettings` floors it too.
  const weeks = Math.max(1, Math.trunc(planningHorizonWeeks));
  return addDays(today, weeks * DAYS_PER_WEEK - 1);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Reflows the movable pool in queue order, from `today` forward. A cursor walks forward and never goes back, which is what makes never-backfill and strict
 * order fall out of the walk rather than being enforced anywhere; `takeableFrom` is what keeps every
 * piece it cuts a legal row.
 */
export function compose(input: ComposeInput): ComposeResult {
  const horizon = horizonEndDate(input.today, input.planningHorizonWeeks);
  const plans = new Map<string, DayPlan>();
  const planFor = (date: string): DayPlan => {
    let plan = plans.get(date);
    if (plan === undefined) {
      plan = buildDayPlan(input, date);
      plans.set(date, plan);
    }
    return plan;
  };

  // Everything outside the movable pool comes back exactly as it went in, and is never
  // auto-merged: tidying two touching weekend rows would rewrite a decision the engine did not
  // make, and merging a locked row would move it.
  const fixed: PlacedBlock[] = [];
  for (const block of input.blocks) {
    if (isMovable(block, input.today)) continue;
    fixed.push({
      id: block.id,
      projectId: block.projectId,
      date: block.date,
      startMinutes: block.startMinutes,
      durationMinutes: block.durationMinutes,
      locked: block.locked,
    });
  }

  const deletedBlockIds: string[] = [];
  const reflowed: PlacedBlock[] = [];

  // The forward-only cursor: a date, plus how far into that date we have got.
  let cursorDate = input.today;
  let cursor = openDay(planFor(cursorDate));

  /** Places one item, or reports the engine's single failure without writing anything. */
  const placeItem = (item: QueueItem): ComposeError | null => {
    if (item.durationMinutes <= 0) {
      // Defensive: the schema forbids a zero-length row.
      deletedBlockIds.push(...item.blockIds);
      return null;
    }

    // FILL AND OVERFLOW: one path for every item — a brand-new job, a tail a drop cut off, and a
    // job longer than a week all take exactly this one.
    const segments: Segment[] = [];
    let remaining = item.durationMinutes;
    // TWICE OVER THE HORIZON, THE SECOND PASS A LAST RESORT: the quarter-hour floor prefers to step
    // over a stretch too short to hold a row, which is wrong only when no bigger one exists further
    // on. Continuing from where the first pass stopped is safe — nothing was taken from the days it
    // stepped over, so their cursors come back full.
    for (const lastResort of [false, true]) {
      for (
        let date = cursorDate;
        remaining > 0 && compareDates(date, horizon) <= 0;
        date = addDays(date, 1)
      ) {
        const day = date === cursorDate ? cursor : openDay(planFor(date));
        if (!acceptsItem(day.plan, item)) continue;
        const taken = takeFrom(day, remaining, lastResort);
        if (taken.length === 0) continue;
        for (const segment of taken) remaining -= segment.durationMinutes;
        cursorDate = date;
        cursor = day;
        segments.push(...taken);
      }
      if (remaining <= 0) break;
    }

    if (remaining > 0) {
      // One clean failure, no placement to roll back by hand.
      return {
        code: 'horizon-exceeded',
        messageKey: HORIZON_EXCEEDED_KEY,
        projectId: item.projectId,
        unplacedMinutes: remaining,
        horizonEndDate: horizon,
      };
    }

    // The item's rows reuse the ids it was built from, in order; the ones left
    // over are the rows auto-merge absorbed and the caller must delete.
    const rows = mergeTouchingSegments(segments);
    rows.forEach((segment, index) => {
      reflowed.push({
        id: item.blockIds[index] ?? null,
        projectId: item.projectId,
        date: segment.date,
        startMinutes: segment.startMinutes,
        durationMinutes: segment.durationMinutes,
        // A queue item is movable by definition, so nothing the reflow places is fixed.
        locked: false,
      });
    });
    deletedBlockIds.push(...item.blockIds.slice(rows.length));
    return null;
  };

  for (const item of buildQueue(input)) {
    const failure = placeItem(item);
    if (failure !== null) return { ok: false, error: failure };
  }

  // Auto-merge is about what ends up touching on the calendar, not about what the
  // queue thought, so the last word on it is taken over the whole reflowed set.
  reflowed.sort(byCalendarPosition);
  const blocks = [...fixed, ...mergeTouchingRows(reflowed, deletedBlockIds)].sort(byCalendarPosition);
  return { ok: true, blocks, deletedBlockIds };
}

// ---------------------------------------------------------------------------
// Internals — the working timeline
// ---------------------------------------------------------------------------
//
// Placement happens entirely in INDEX SPACE: a day is one ruler of `shiftMinutes` minutes with the
// breaks cut out, so index 360 is both 14:00 and 15:30. That is what makes "a job flows across
// lunch" and "a job never straddles a non-working interval" the same statement — one contiguous
// index range, cut back into rows by `toClockSegments`. Obstacles are projected into the same space.

/** One working period, mapped onto the day's index ruler. */
interface PeriodSpan {
  startIndex: number;
  endIndex: number;
  /** The clock minute index `startIndex` stands for. */
  startClock: number;
}

/** A half-open range of the index ruler. */
interface IndexRange {
  start: number;
  end: number;
}

/** One row of the calendar, before it is given an id. */
interface Segment {
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

/**
 * A day's index ruler plus the date its clock times belong to — everything `toClockSegments`
 * needs. Both `DayPlan` (auto-fill) and `ManualDayPlan` (a hand drop displacing a row) are one.
 */
interface ClockRuler {
  date: string;
  spans: PeriodSpan[];
}

/** Everything the engine needs to know about one day, derived once and cached. */
interface DayPlan extends ClockRuler {
  role: DayRole;
  workingMinutes: number;
  /**
   * Unoccupied stretches of the index ruler, in order. Two are one run iff no obstacle AND no
   * real break between periods separates them — see `splitAtBreaks`.
   */
  freeRuns: IndexRange[];
  plannableMinutes: number;
  /** False for the past, a closed day, the weekend, and a day with no room left. */
  fillable: boolean;
}

/** How far auto-fill has got into one day. */
interface DayCursor {
  plan: DayPlan;
  budgetMinutes: number;
  runIndex: number;
  positionIndex: number;
}

/** One helping a day gives an item: where on the index ruler, and how much. */
interface TakePiece {
  runIndex: number;
  startIndex: number;
  minutes: number;
}

function roleOf(date: string): DayRole {
  const weekday = weekdayOf(date);
  if (weekday < FRIDAY) return 'auto';
  if (weekday === FRIDAY) return 'buffer';
  return 'manual';
}

function totalPeriodMinutes(periods: readonly WorkPeriod[]): number {
  return periods.reduce((total, period) => total + Math.max(0, period.endMinutes - period.startMinutes), 0);
}

function buildPeriodSpans(periods: readonly WorkPeriod[]): { spans: PeriodSpan[]; workingMinutes: number } {
  const spans: PeriodSpan[] = [];
  let offset = 0;
  for (const period of periods) {
    const length = Math.max(0, period.endMinutes - period.startMinutes);
    if (length === 0) continue;
    spans.push({ startIndex: offset, endIndex: offset + length, startClock: period.startMinutes });
    offset += length;
  }
  return { spans, workingMinutes: offset };
}

/**
 * Projects a clock interval onto the index ruler, dropping whatever falls outside the working
 * periods — an obstacle over the lunch break costs the day nothing. This is what makes gaps and
 * locked blocks ONE occupancy set.
 */
function toIndexRanges(spans: PeriodSpan[], startClock: number, endClock: number): IndexRange[] {
  const ranges: IndexRange[] = [];
  for (const span of spans) {
    const spanEndClock = span.startClock + (span.endIndex - span.startIndex);
    const from = Math.max(startClock, span.startClock);
    const to = Math.min(endClock, spanEndClock);
    if (to > from) {
      ranges.push({
        start: span.startIndex + (from - span.startClock),
        end: span.startIndex + (to - span.startClock),
      });
    }
  }
  return ranges;
}

/** The union of intervals: overlapping and touching ranges become one. */
function mergeRanges(ranges: IndexRange[]): IndexRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: IndexRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/**
 * Cuts the free stretches wherever a row would have to be cut anyway: at a REAL break between two
 * periods. The index ruler is continuous across the break, so without this a stretch spanning it is
 * ONE stretch to `takeableFrom` and TWO rows to `toClockSegments`, and the quarter-hour floor gets
 * applied to the pair rather than to either row.
 */
function splitAtBreaks(free: IndexRange[], spans: PeriodSpan[]): IndexRange[] {
  const breaks: number[] = [];
  for (let index = 0; index + 1 < spans.length; index += 1) {
    const span = spans[index];
    const endClock = span.startClock + (span.endIndex - span.startIndex);
    if (spans[index + 1].startClock > endClock) breaks.push(span.endIndex);
  }
  if (breaks.length === 0) return free;

  const cut: IndexRange[] = [];
  for (const range of free) {
    let start = range.start;
    for (const bound of breaks) {
      if (bound <= start || bound >= range.end) continue;
      cut.push({ start, end: bound });
      start = bound;
    }
    cut.push({ start, end: range.end });
  }
  return cut;
}

/** What is left of `[0, total)` once the occupied ranges are taken out. */
function freeRangesOf(occupied: IndexRange[], total: number): IndexRange[] {
  const free: IndexRange[] = [];
  let cursor = 0;
  for (const range of occupied) {
    if (range.start > cursor) free.push({ start: cursor, end: Math.min(range.start, total) });
    cursor = Math.max(cursor, range.end);
    if (cursor >= total) break;
  }
  if (cursor < total) free.push({ start: cursor, end: total });
  return free.filter((range) => range.end > range.start);
}

function buildDayPlan(input: ComposeInput, date: string): DayPlan {
  const config = input.getDayConfig(date);
  const { spans, workingMinutes } = buildPeriodSpans(config.periods);

  // The three ways a day is off limits to the engine: the past is frozen, a
  // holiday has no hours, and the weekend is outside the engine entirely.
  const usable =
    compareDates(date, input.today) >= 0 && !config.isClosed && config.role !== 'manual' && workingMinutes > 0;

  const obstacles: IndexRange[] = [];
  for (const gap of input.gaps) {
    if (gap.date !== date) continue;
    obstacles.push(...toIndexRanges(spans, gap.startMinutes, gap.startMinutes + gap.durationMinutes));
  }
  for (const block of input.blocks) {
    if (block.date !== date || isMovable(block, input.today)) continue;
    obstacles.push(...toIndexRanges(spans, block.startMinutes, block.startMinutes + block.durationMinutes));
  }

  const occupied = mergeRanges(obstacles);
  const occupiedMinutes = occupied.reduce((total, range) => total + (range.end - range.start), 0);
  const capacityMinutes = clamp(config.capacityMinutes, 0, workingMinutes);
  const plannable = usable ? Math.max(0, Math.min(capacityMinutes, workingMinutes - occupiedMinutes)) : 0;

  return {
    date,
    role: config.role,
    spans,
    workingMinutes,
    freeRuns: usable ? splitAtBreaks(freeRangesOf(occupied, workingMinutes), spans) : [],
    plannableMinutes: plannable,
    fillable: usable && plannable > 0,
  };
}

function openDay(plan: DayPlan): DayCursor {
  return { plan, budgetMinutes: plan.plannableMinutes, runIndex: 0, positionIndex: 0 };
}

/**
 * The Friday buffer — the one asymmetry in the engine.
 * Membership by DATE rather than by weekday is what makes the rule a fixed point: the item's own
 * rows are the evidence, and they are exactly what the previous pass wrote.
 */
function acceptsItem(plan: DayPlan, item: QueueItem): boolean {
  if (!plan.fillable) return false;
  if (plan.role !== 'buffer') return true;
  if (item.isNew) return false;
  return item.grown || item.originalDates.includes(plan.date);
}

/**
 * What this day would give an item of `remaining` minutes, run by run, without committing anything;
 * `takeFrom` plans the whole helping first so a day is never left half-taken.
 *
 * Forward only — runs before the cursor are never considered, which is the whole of no-backfill —
 * and every run is visited at most once, so a run whose take `takeableFrom` reduced leaves the rest
 * of itself unused rather than being re-offered the sliver it just avoided.
 */
function planTake(day: DayCursor, remaining: number, lastResort: boolean): TakePiece[] {
  const pieces: TakePiece[] = [];
  let left = remaining;
  let budget = day.budgetMinutes;

  for (
    let index = day.runIndex;
    index < day.plan.freeRuns.length && left > 0 && budget > 0;
    index += 1
  ) {
    const run = day.plan.freeRuns[index];
    const startIndex = index === day.runIndex ? Math.max(day.positionIndex, run.start) : run.start;
    const space = Math.min(run.end - startIndex, budget);
    if (space <= 0) continue;
    const minutes = takeableFrom(space, left, lastResort);
    if (minutes <= 0) continue;
    pieces.push({ runIndex: index, startIndex, minutes });
    left -= minutes;
    budget -= minutes;
  }

  return pieces;
}

/** Fills the day from the cursor with as much of `remaining` as it holds, leaving the cursor there. */
function takeFrom(day: DayCursor, remaining: number, lastResort: boolean): Segment[] {
  const segments: Segment[] = [];
  for (const piece of planTake(day, remaining, lastResort)) {
    segments.push(...toClockSegments(day.plan, piece.startIndex, piece.minutes));
    day.budgetMinutes -= piece.minutes;
    day.runIndex = piece.runIndex;
    day.positionIndex = piece.startIndex + piece.minutes;
  }
  return segments;
}

/**
 * Turns one contiguous index range back into rows, cutting it at every period boundary: a stored
 * block is always a solid rectangle on the clock.
 */
function toClockSegments(ruler: ClockRuler, startIndex: number, minutes: number): Segment[] {
  const segments: Segment[] = [];
  const endIndex = startIndex + minutes;
  for (const span of ruler.spans) {
    const from = Math.max(startIndex, span.startIndex);
    const to = Math.min(endIndex, span.endIndex);
    if (to <= from) continue;
    segments.push({
      date: ruler.date,
      startMinutes: span.startClock + (from - span.startIndex),
      durationMinutes: to - from,
    });
  }
  return segments;
}

/**
 * Auto-merge on the segments of one item: two that touch inside one period are one row. The halves
 * around lunch touch on the index ruler but not on the clock, so they stay two rows — while a shift
 * configured with no lunch break comes back out as one solid rectangle.
 */
function mergeTouchingSegments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.date === segment.date && last.startMinutes + last.durationMinutes === segment.startMinutes) {
      last.durationMinutes += segment.durationMinutes;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/**
 * The same rule across items: rows of the SAME job that touch on one day become one row. Only ever
 * called with reflowed rows, so it can never merge across jobs, touch a locked row, or tidy the
 * weekend or the past. It is the backstop rather than the common path, and the survivor keeps the
 * group's first real id so the caller writes an UPDATE, not a DELETE plus an INSERT.
 */
function mergeTouchingRows(rows: PlacedBlock[], deletedBlockIds: string[]): PlacedBlock[] {
  const merged: PlacedBlock[] = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.projectId === row.projectId &&
      last.date === row.date &&
      last.startMinutes + last.durationMinutes === row.startMinutes
    ) {
      last.durationMinutes += row.durationMinutes;
      if (last.id === null) last.id = row.id;
      else if (row.id !== null) deletedBlockIds.push(row.id);
      continue;
    }
    merged.push({ ...row });
  }
  return merged;
}

/** `ORDER BY date, start_time`, then `created_at`, then `id`: a total order. */
function sortedByQueueRank(blocks: readonly Block[]): Block[] {
  return [...blocks].sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      a.startMinutes - b.startMinutes ||
      compareText(a.createdAt, b.createdAt) ||
      compareText(a.id, b.id),
  );
}

function byCalendarPosition(a: PlacedBlock, b: PlacedBlock): number {
  return compareDates(a.date, b.date) || a.startMinutes - b.startMinutes;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Editing a job's hours — the transforms that feed `compose`
// ---------------------------------------------------------------------------
//
// These move hours between the rows of ONE job and never place anything. The caller applies one,
// then hands the result to `compose` in the same transaction:
//
//     const edit = resizeBlock(blocks, { blockId, durationMinutes, today });
//     if (!edit.ok) return edit.error;                  // nothing written
//     const placement = compose({ ...input, blocks: edit.blocks });
//
// `totalMinutesDelta` is what the caller adds to `projects.total_hours` to keep the hours invariant
// true. Zero for every pure transfer.

export type EditErrorCode =
  | 'unknown-block'
  | 'invalid-duration'
  | 'resize-needs-padlock'
  | 'shrink-needs-choice'
  | 'transfer-exceeds-job'
  | 'reduction-exceeds-job';

export const EDIT_MESSAGE_KEYS: Record<EditErrorCode, string> = {
  'unknown-block': 'errors.unknownBlock',
  'invalid-duration': 'errors.invalidDuration',
  'resize-needs-padlock': 'errors.resizeNeedsPadlock',
  'shrink-needs-choice': 'errors.shrinkNeedsChoice',
  'transfer-exceeds-job': 'errors.transferExceedsJob',
  'reduction-exceeds-job': 'errors.reductionExceedsJob',
};

/**
 * The two ways out when a shrink frees hours no block of the job can take: `reduce-total` makes the
 * job smaller, `new-block` gives the hours a row of their own. The third — cancel — is not a value,
 * it is the caller not asking again.
 */
export type FreedHoursChoice = 'reduce-total' | 'new-block';

export interface EditError {
  code: EditErrorCode;
  /** i18n key, never a translated sentence. */
  messageKey: string;
  blockId?: string;
  projectId?: string;
  /**
   * `shrink-needs-choice` only: the hours with nowhere to go and the answers that really exist for
   * them, so the caller can put the question WITHOUT a second round trip.
   */
  freedMinutes?: number;
  choices?: FreedHoursChoice[];
}

export interface EditSuccess {
  ok: true;
  /** The job's rows after the transfer, ready to hand to `compose`. */
  blocks: Block[];
  /** Rows that reached zero and must be DELETEd. */
  deletedBlockIds: string[];
  /** What to add to `projects.total_hours`, in minutes. Zero for a pure transfer. */
  totalMinutesDelta: number;
  /**
   * Locked rows the transfer had to touch because the job had no unlocked hours left. A locked
   * block is never grown or shrunk silently, so it is reported rather than swallowed.
   */
  touchedLockedBlockIds: string[];
}

export interface EditFailure {
  ok: false;
  error: EditError;
}

export type EditResult = EditSuccess | EditFailure;

/** Raising or lowering a job's estimate in the job form. */
export interface HoursChange {
  projectId: string;
  /** Signed minutes: positive adds hours to the job, negative takes them away. */
  deltaMinutes: number;
  /** Local `YYYY-MM-DD`. Used to keep a created row inside the movable pool. */
  today: string;
  /** Id for the row the engine has to create when the job has no unlocked block. */
  newBlockId: string;
  /** `created_at` / `updated_at` for a created row — the caller's clock. */
  now: string;
}

/**
 * LIFO. Per the implementer default the engine
 * works on the job's last block IN THE MOVABLE POOL, creating one ranked after its last row when it
 * has none.
 */
export function changeProjectMinutes(blocks: readonly Block[], change: HoursChange): EditResult {
  const delta = Math.round(change.deltaMinutes);
  const draft = blocks.map(cloneBlock);
  if (delta === 0) return settledEdit(draft, [], 0, []);

  const own = sortedByQueueRank(draft.filter((block) => block.projectId === change.projectId));

  if (delta > 0) {
    const target = lastAutomatic(own, change.today);
    if (target !== undefined) {
      target.durationMinutes += delta;
      return settledEdit(draft, [], delta, []);
    }
    // Every row of the job is outside the pool, or it has none: give the hours a row of their
    // own rather than growing one the reflow cannot settle afterwards. `compose` places it.
    draft.push(createdRowAfter(own[own.length - 1], draft, delta, change));
    return settledEdit(draft, [], delta, []);
  }

  const taken = takeMinutes(own, -delta);
  if (!taken.ok) {
    return failedEdit('reduction-exceeds-job', { projectId: change.projectId });
  }
  return settledEdit(
    draft.filter((block) => block.durationMinutes > 0),
    taken.deletedBlockIds,
    delta,
    taken.touchedLockedBlockIds,
  );
}

/** Dragging a block's bottom edge. */
export interface BlockResize {
  blockId: string;
  /**
   * The new NET WORKING MINUTES of the STRETCH that begins at that row's start — net, so the lunch
   * break contributes nothing; the stretch, because the row may already continue past it.
   */
  durationMinutes: number;
  /**
   * Local `YYYY-MM-DD`. The row the freed hours are handed to must be one the reflow can settle,
   * and "is this row in the movable pool" is not answerable without today — see `lastAutomatic`.
   */
  today: string;
  /**
   * The day the row sits on. A resize is a hand action, so it is measured and cut over
   * `manualWindows`; the whole `DayWindows` is passed because that is what `getDayConfig` hands out.
   */
  day: DayWindows;
  /**
   * The owner's answer to "these freed hours have nowhere to go". Absent means ASK: the transform
   * refuses with `shrink-needs-choice` and writes nothing.
   */
  freedHours?: FreedHoursChoice;
  /** An id per extra row the stretch needs once it is cut at the lunch break. */
  newBlockId: () => string;
  /** `created_at` / `updated_at` for a row the segmentation has to create. */
  now: string;
}

/**
 * A transfer inside the job, with the job's last block as the
 * counterparty. It only ever sizes a row the engine does not lay out; `durationMinutes` is NET
 * working minutes over the day's MANUAL WINDOWS, so the gesture crosses the lunch break, and
 * `stretchFrom` decides which of the job's own rows it rewrites.
 */
export function resizeBlock(blocks: readonly Block[], resize: BlockResize): EditResult {
  const draft = blocks.map(cloneBlock);
  const target = draft.find((block) => block.id === resize.blockId);
  if (target === undefined) return failedEdit('unknown-block', { blockId: resize.blockId });

  // THE ONE PRECONDITION: the engine must not be laying this row out. Refused here rather than in
  // the operation so the pure engine states its own rule and the UI can mirror it.
  if (isMovable(target, resize.today)) {
    return failedEdit('resize-needs-padlock', { blockId: target.id, projectId: target.projectId });
  }

  const next = Math.round(resize.durationMinutes);
  if (!Number.isFinite(next) || next <= 0) {
    return failedEdit('invalid-duration', { blockId: resize.blockId, projectId: target.projectId });
  }

  // The rows the stretch will be stored as, decided before anything is absorbed: the absorption
  // depends on where these reach and not the other way round.
  const segments = segmentDroppedRow(resize.day.manualWindows, {
    startMinutes: target.startMinutes,
    durationMinutes: next,
  });
  const lastSegment = segments[segments.length - 1];
  const reachMinutes = lastSegment.startMinutes + lastSegment.durationMinutes;

  const own = sortedByQueueRank(draft.filter((block) => block.projectId === target.projectId));
  const stretch = stretchFrom(own, target, resize.day.manualWindows, reachMinutes, resize.today);
  const stretchMinutes = stretch.reduce((total, row) => total + row.durationMinutes, 0);
  const delta = next - stretchMinutes;
  const counterparties = own.filter((row) => !stretch.includes(row));
  const isLast = counterparties.length === 0 || stretch.includes(own[own.length - 1]);

  const deletedBlockIds: string[] = [];
  let totalMinutesDelta = 0;
  let touchedLockedBlockIds: string[] = [];

  if (delta > 0 && isLast) {
    // Nothing farther to draw from, so the estimate grows.
    totalMinutesDelta = delta;
  } else if (delta > 0) {
    const taken = takeMinutes(counterparties, delta);
    if (!taken.ok) {
      return failedEdit('transfer-exceeds-job', { blockId: target.id, projectId: target.projectId });
    }
    deletedBlockIds.push(...taken.deletedBlockIds);
    touchedLockedBlockIds = taken.touchedLockedBlockIds;
  } else if (delta < 0) {
    // THE FREED HOURS GO TO THE JOB'S LAST BLOCK, SKIPPING THE ONES THAT CANNOT TAKE THEM.
    // `lastAutomatic` is that cascade. Hours handed to a row outside the pool are written straight
    // onto the clock and nothing ever settles them.
    const freedMinutes = -delta;
    // The job's LAST row is a dead end by itself, whatever sits in front of it: there is nothing
    // later to hand hours to, and pushing them BACKWARDS would answer "this row is shorter" with
    // "so the week before it is longer". `isLast` covers a stretch that swallowed the last row too.
    const receiver = isLast ? undefined : lastAutomatic(counterparties, resize.today);

    if (receiver !== undefined) {
      receiver.durationMinutes += freedMinutes;
    } else {
      // THE DEAD END, AND IT ASKS RATHER THAN REFUSING. The answer is applied here and nowhere
      // else, so cancelling is simply never sending it.
      const choices = freedHoursChoices(freedMinutes);
      const answer = resize.freedHours;
      if (answer === undefined || !choices.includes(answer)) {
        return failedEdit('shrink-needs-choice', {
          blockId: target.id,
          projectId: target.projectId,
          freedMinutes,
          choices,
        });
      }
      if (answer === 'reduce-total') {
        // `delta` is already negative and the caller adds it to the total, so the invariant holds.
        totalMinutesDelta = delta;
      } else {
        // A row of their own, ranked after the job's last; `compose` places it.
        draft.push(
          createdRowAfter(own[own.length - 1], draft, freedMinutes, {
            projectId: target.projectId,
            deltaMinutes: freedMinutes,
            today: resize.today,
            newBlockId: resize.newBlockId(),
            now: resize.now,
          }),
        );
      }
    }
  }

  // A LOCKED ROW THE STRETCH REWRITES IS NAMED. `stretchFrom` takes in a continuation whatever its
  // marks, so growing the morning half of a unit lengthens a locked afternoon half. Whether it
  // should be excluded from the stretch altogether is the owner's decision; being told is not.
  for (const row of stretch.slice(1)) {
    if (row.locked && !touchedLockedBlockIds.includes(row.id)) touchedLockedBlockIds.push(row.id);
  }

  // The stretch is written over its rows in order: one row for a length that stays inside its
  // window, two once it crosses the break. THE WHOLE STRETCH COMES OUT AS FIXED AS ITS TARGET —
  // half a stretch left to the engine came apart on the very next pass. `touchedLockedBlockIds`
  // was computed above so this never reports the padlock it has just applied.
  segments.forEach((segment, index) => {
    const row = stretch[index];
    if (row === undefined) {
      draft.push({
        ...target,
        id: resize.newBlockId(),
        startMinutes: segment.startMinutes,
        durationMinutes: segment.durationMinutes,
        createdAt: resize.now,
        updatedAt: resize.now,
      });
      return;
    }
    row.startMinutes = segment.startMinutes;
    row.durationMinutes = segment.durationMinutes;
    row.locked = row.locked || target.locked;
  });

  // Shrunk back across the break: the rows the stretch no longer needs are gone. Their
  // hours were handed to the counterparty above, so nothing is lost.
  for (const row of stretch.slice(segments.length)) {
    row.durationMinutes = 0;
    deletedBlockIds.push(row.id);
  }

  return settledEdit(
    draft.filter((row) => row.durationMinutes > 0),
    deletedBlockIds,
    totalMinutesDelta,
    touchedLockedBlockIds,
  );
}

/** The answers that really exist, so the dialog the caller builds cannot disagree with this. */
function freedHoursChoices(minutes: number): FreedHoursChoice[] {
  return minutes >= MIN_ROW_MINUTES ? ['reduce-total', 'new-block'] : ['reduce-total'];
}

/**
 * The rows a bottom-edge drag rewrites. `adjacentInWindows`
 * is the same predicate the grid groups a unit with, so a unit on screen and a stretch here can
 * never disagree about where one ends, and only rows AFTER the target are taken, since the gesture
 * is anchored at the edge the owner grabbed.
 */
function stretchFrom(
  own: readonly Block[],
  target: Block,
  manualWindows: readonly WorkPeriod[],
  reachMinutes: number,
  today: string,
): Block[] {
  const stretch = [target];
  let endMinutes = target.startMinutes + target.durationMinutes;

  for (const row of own.slice(own.indexOf(target) + 1)) {
    if (row.date !== target.date) break;
    if (!adjacentInWindows(manualWindows, endMinutes, row.startMinutes)) break;
    if (isMovable(row, today) && row.startMinutes >= reachMinutes) break;
    stretch.push(row);
    endMinutes = row.startMinutes + row.durationMinutes;
  }

  return stretch;
}

// ---------------------------------------------------------------------------
// Saving a gap on top of existing work
// ---------------------------------------------------------------------------

/** A block a gap would land on top of, and the reason the engine cannot move it. */
export interface GapConflict {
  blockId: string;
  projectId: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** Why the engine may not move it. Exactly the three ways `isMovable` says no. */
  reason: 'locked' | 'past' | 'weekend';
}

/**
 * The implementer default for a gap on top of existing work: unlocked weekday work is pushed forward
 * by the recomposition, so the only real conflicts are the blocks the engine may not move. `compose`
 * cannot repair an overlap it is forbidden to touch, so the caller refuses the save and names them.
 */
export function findGapConflicts(
  blocks: readonly Block[],
  gap: Pick<Gap, 'date' | 'startMinutes' | 'durationMinutes'>,
  today: string,
): GapConflict[] {
  const start = gap.startMinutes;
  const end = gap.startMinutes + gap.durationMinutes;
  const conflicts: GapConflict[] = [];

  for (const block of sortedByQueueRank(blocks)) {
    if (block.date !== gap.date) continue;
    if (isMovable(block, today)) continue;
    if (Math.min(end, block.startMinutes + block.durationMinutes) <= Math.max(start, block.startMinutes)) {
      continue;
    }
    conflicts.push({
      blockId: block.id,
      projectId: block.projectId,
      date: block.date,
      startMinutes: block.startMinutes,
      durationMinutes: block.durationMinutes,
      // The reason is what the sentence names, so it is the block's OWN state first: a padlocked
      // row on a weekday is neither past nor weekend.
      reason: block.locked
        ? 'locked'
        : isWeekend(block.date)
          ? 'weekend'
          : 'past',
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Manual placement — the overlap a drop creates
// ---------------------------------------------------------------------------
//
// Two mechanisms are needed because the reflow reaches some rows and not others:
// on the FIXED side (weekend, frozen past, locked) an overlap is permanent unless it is resolved
// here, so the rows are merged or cut and the tails PLACED; on the REFLOWED side only queue RANKS
// are written, since `date, start_time` order is what makes the reflow produce `A, B, A` by itself.
//
// This is NOT `mergeTouchingRows`: collapsing the two would reintroduce the weekend tidying the
// engine avoids.

export type ManualPlacementErrorCode =
  | 'unknown-block'
  | 'overlaps-locked-block'
  | 'overlaps-gap'
  | 'merge-exceeds-day'
  | 'displaced-hours-unplaceable';

export const MANUAL_PLACEMENT_MESSAGE_KEYS: Record<ManualPlacementErrorCode, string> = {
  'unknown-block': 'errors.unknownBlock',
  'overlaps-locked-block': 'errors.dropOverLockedBlock',
  'overlaps-gap': 'errors.dropOverGap',
  'merge-exceeds-day': 'errors.mergeExceedsDay',
  'displaced-hours-unplaceable': 'errors.displacedHoursUnplaceable',
};

export interface ManualPlacementError {
  code: ManualPlacementErrorCode;
  /** i18n key, never a translated sentence. */
  messageKey: string;
  /** The row the drop collided with, when the refusal is about one. */
  blockId?: string;
  projectId?: string;
  date?: string;
  startMinutes?: number;
  durationMinutes?: number;
  /** A GAP's reason, when the thing in the way is a gap rather than a row. */
  reason?: string;
}

export interface ManualPlacementSuccess {
  ok: true;
  /** The calendar with the overlap resolved, ready to hand straight to `compose`. */
  blocks: Block[];
  /**
   * The id the dropped hours ended up on — the id passed in, EXCEPT after a merge, where the earlier
   * row survives. Resolving the same drop again is a no-op, which is what says no overlap was left.
   */
  placedBlockId: string;
  /**
   * Rows of the SAME job the dropped row absorbed. Gone from `blocks`, so the caller must DELETE
   * them; the survivor is the earlier row, so a merge is an UPDATE plus a DELETE.
   */
  mergedBlockIds: string[];
  /**
   * Jobs whose row was cut in two so the dropped row could keep the slot. Their totals are
   * untouched — the tail carries exactly the hours the head lost — but the owner is told.
   */
  displacedProjectIds: string[];
}

export interface ManualPlacementFailure {
  ok: false;
  error: ManualPlacementError;
}

export type ManualPlacementResult = ManualPlacementSuccess | ManualPlacementFailure;

export interface ManualPlacement {
  /** The row the human just dropped. Must already be present in `input.blocks`. */
  blockId: string;
  /** `created_at` / `updated_at` for a row the resolution has to create. */
  now: string;
  /** Ids for the rows a displaced tail needs. Called once per row created. */
  newBlockId: () => string;
}

/**
 * Resolves the overlap a hand drop created, leaving a calendar `compose` can take. Which half runs
 * depends on whether the reflow can reach the rows; see the note above the refusal codes. Both
 * halves store the drop in SEGMENTS, and every branch conserves hours, so the hours invariant holds
 * by construction rather than by inspection.
 */
export function resolveManualPlacement(
  input: ComposeInput,
  placement: ManualPlacement,
): ManualPlacementResult {
  const draft = input.blocks.map(cloneBlock);
  const placed = draft.find((block) => block.id === placement.blockId);
  if (placed === undefined) {
    return manualFailure('unknown-block', { blockId: placement.blockId });
  }

  // May the drop keep its DAY and give up its exact MINUTE? Only where the engine lays the day
  // out; everywhere else the minute is the whole promise.
  const maySlide = dayReflows(input.getDayConfig(placed.date), placed.date, input.today);
  return resolveDrop(input, placement, draft, placed, maySlide);
}

function resolveDrop(
  input: ComposeInput,
  placement: ManualPlacement,
  draft: Block[],
  dropped: Block,
  maySlide: boolean,
): ManualPlacementResult {
  let placed = dropped;
  const reflowed = isMovable(placed, input.today);
  // A drop is a HAND action, so it is cut over the day's MANUAL WINDOWS. The lunch break is still
  // the only cut, because that is the only hole a manual window leaves.
  const periods = input.getDayConfig(placed.date).manualWindows;

  // 0. The drop keeps its day and gives up its exact minute rather than being refused for landing
  //    on the one thing nothing will move. Forward only, and a no-op when the slot is already
  //    clear. A day with no clear slot leaves the start alone and the steps below refuse.
  if (!reflowed && maySlide) {
    const clear = firstClearStart({
      windows: periods,
      immovable: immovableOn(input, draft, placed),
      startMinutes: placed.startMinutes,
      durationMinutes: placed.durationMinutes,
    });
    if (clear !== null) placed.startMinutes = clear;
  }

  /** Ids the merge freed. Reused by the segmentation below before any id is minted. */
  const absorbedIds: string[] = [];
  const displacedProjectIds: string[] = [];

  // 1. Same job: fold every overlapping row into one, re-checked after each fold because the
  //    survivor is longer than either row was. Only where the reflow will not separate them — two
  //    movable rows of one job are already going to be laid out contiguously and auto-merged, so
  //    folding them here would be tidying. A padlock on either side does not refuse it.
  while (!reflowed) {
    const other = sameJobOverlaps(draft, placed, segmentDroppedRow(periods, placed), input.today)[0];
    if (other === undefined) break;

    // SUM, NOT UNION: the union of the two intervals would silently drop the hour they share.
    // The segmentation below then lays the sum out, so a merge across lunch comes back as two rows.
    const startMinutes = Math.min(other.startMinutes, placed.startMinutes);
    const durationMinutes = other.durationMinutes + placed.durationMinutes;
    if (clockEndOf(periods, startMinutes, durationMinutes) > dayEndMinutes(periods)) {
      // The merged row is one job's hours on ONE day, and the day has an end. Drawn at midnight
      // instead, repeated drops compounded past it with hours conserved, so nothing warned.
      return manualFailure('merge-exceeds-day', placed);
    }

    // The earlier row survives, so the write is an UPDATE rather than a DELETE and an INSERT.
    const [survivor, absorbed] = sortedByQueueRank([other, placed]);
    survivor.startMinutes = startMinutes;
    survivor.durationMinutes = durationMinutes;
    // A fold may never free hours the owner had fixed: if either row was padlocked, the
    // one row they become is.
    survivor.locked = survivor.locked || absorbed.locked;
    draft.splice(draft.indexOf(absorbed), 1);
    absorbedIds.push(absorbed.id);
    placed = survivor;
  }

  // 2. The drop is stored in segments, before the cuts below so the rows it lands across are
  //    measured against the time it REALLY occupies: 6 h dropped at 10:00 runs to 17:30, not 16:00.
  //    THE START IS READ BACK, not only the duration — it matters for a row a MERGE just moved
  //    backwards onto an earlier start, which may be one a settings change left inside the break.
  const dropRows = segmentDroppedRow(periods, placed);
  placed.startMinutes = dropRows[0].startMinutes;
  placed.durationMinutes = dropRows[0].durationMinutes;
  for (const extra of dropRows.slice(1)) {
    draft.push({
      ...placed,
      // An id the merge freed rather than a new one, so a merge that segments is two UPDATEs.
      id: absorbedIds.shift() ?? placement.newBlockId(),
      startMinutes: extra.startMinutes,
      durationMinutes: extra.durationMinutes,
      createdAt: placement.now,
      updatedAt: placement.now,
    });
  }

  // 3. A GAP the drop lands on, where the reflow will not separate them: refused, naming it. Gaps
  //    and blocks are ONE occupancy set, and the mirror gesture (a gap over a padlocked row) is
  //    already a 409. Only on the fixed side: on Mon-Thu the reflow keeps auto work off a gap.
  if (!reflowed) {
    const covered = input.gaps.find(
      (candidate) =>
        candidate.date === placed.date &&
        overlapsSegments(dropRows, candidate.startMinutes, candidate.durationMinutes),
    );
    if (covered !== undefined) {
      return {
        ok: false,
        error: {
          code: 'overlaps-gap',
          messageKey: MANUAL_PLACEMENT_MESSAGE_KEYS['overlaps-gap'],
          date: covered.date,
          startMinutes: covered.startMinutes,
          durationMinutes: covered.durationMinutes,
          reason: covered.reason,
        },
      };
    }
  }

  // 4. A ROW THE DROP LANDED EXACTLY ON THE START OF STAYS WHOLE AND FOLLOWS. On the reflowed
  //    side the drop is a rank, and a rank that TIES is decided by `created_at` — so the drop lost
  //    the tie whenever the row it aimed at was older, and the drag looked ignored. Nothing is cut
  //    and no hours move. The fixed side already answers this way by construction (step 5).
  const dropEnd = dropRows[dropRows.length - 1];
  const behindDrop = Math.min(dropEnd.startMinutes + dropEnd.durationMinutes, MAX_RANK_MINUTES);
  if (reflowed) {
    for (const row of draft) {
      if (row.id === placed.id || row.projectId === placed.projectId) continue;
      if (row.date !== placed.date || row.startMinutes !== placed.startMinutes) continue;
      if (!isMovable(row, input.today)) continue;
      row.startMinutes = behindDrop;
    }
  }

  // 5. Another job: cut every row the drop lands in, then re-lay their tails after it, in the
  //    order they were cut. Two passes, so the space the cuts free is available to all of them:
  //    one at a time would interleave the jobs on the clock.
  const victims = otherJobOverlaps(draft, placed, dropRows, input.today, reflowed);
  const locked = victims.find((victim) => victim.locked);
  if (locked !== undefined) return manualFailure('overlaps-locked-block', locked);

  const tails: Array<{ victim: Block; minutes: number; spareIds: string[] }> = [];
  for (const victim of victims) {
    const headMinutes = Math.max(0, placed.startMinutes - victim.startMinutes);
    const minutes = victim.durationMinutes - headMinutes;
    const spareIds: string[] = [];
    if (headMinutes > 0) {
      victim.durationMinutes = headMinutes;
    } else {
      // The drop covers the row from its very start, so its id is free for the first row of its
      // tail. (A movable victim never gets here — it would already rank after the drop.)
      draft.splice(draft.indexOf(victim), 1);
      spareIds.push(victim.id);
    }
    tails.push({ victim, minutes, spareIds });
  }

  const afterClock = dropEnd.startMinutes + dropEnd.durationMinutes;
  for (const tail of tails) {
    // A rank behind the drop is all a reflowed tail needs; a fixed one has to be
    // given real free time, because nothing will move it afterwards.
    const pushed = reflowed
      ? [{ date: tail.victim.date, startMinutes: behindDrop, durationMinutes: tail.minutes }]
      : pushDisplacedMinutes(input, draft, { date: tail.victim.date, afterClock, minutes: tail.minutes });
    if (pushed === null) return manualFailure('displaced-hours-unplaceable', tail.victim);

    for (const segment of pushed) {
      draft.push({
        id: tail.spareIds.pop() ?? placement.newBlockId(),
        projectId: tail.victim.projectId,
        date: segment.date,
        startMinutes: segment.startMinutes,
        durationMinutes: segment.durationMinutes,
        // Never locked: a locked victim was refused above, and the victim was fixed by its DAY,
        // which its tail keeps, so nothing the owner pinned is being freed.
        locked: false,
        createdAt: placement.now,
        updatedAt: placement.now,
      });
    }
    if (!displacedProjectIds.includes(tail.victim.projectId)) {
      displacedProjectIds.push(tail.victim.projectId);
    }
  }

  // Whatever the segmentation did not reuse really is gone.
  return { ok: true, blocks: draft, placedBlockId: placed.id, mergedBlockIds: absorbedIds, displacedProjectIds };
}

// ---------------------------------------------------------------------------
// Internals — manual placement
// ---------------------------------------------------------------------------

/**
 * True when `row` shares clock minutes with any part of the drop's footprint. The footprint lives in
 * src/lib/dropSegments.ts because THE DRAG GHOST NEEDS THE SAME ANSWER.
 */
function overlapsDrop(row: Block, dropRows: readonly DropSegment[]): boolean {
  return overlapsSegments(dropRows, row.startMinutes, row.durationMinutes);
}

/**
 * The things on `date` nothing will ever move out of a drop's way: the gaps and the locked rows.
 * Handed to `firstClearStart`, which is shared with the drag ghost — see src/lib/dropSlide.ts.
 */
function immovableOn(
  input: ComposeInput,
  draft: readonly Block[],
  placed: Block,
): DropSegment[] {
  return [
    ...input.gaps.filter((gap) => gap.date === placed.date),
    ...draft.filter((row) => row.locked && row.date === placed.date && row.id !== placed.id),
  ].map((row) => ({ startMinutes: row.startMinutes, durationMinutes: row.durationMinutes }));
}

/**
 * Rows of the DROP'S OWN job, in queue order, that overlap it and that `compose` will not repair.
 * Movable rows are ignored on purpose: the reflow lays them out contiguously and auto-merge joins
 * them, so folding one here would be tidying.
 */
function sameJobOverlaps(
  draft: readonly Block[],
  placed: Block,
  dropRows: readonly DropSegment[],
  today: string,
): Block[] {
  return sortedByQueueRank(draft).filter(
    (row) =>
      row.id !== placed.id &&
      row.projectId === placed.projectId &&
      row.date === placed.date &&
      !isMovable(row, today) &&
      overlapsDrop(row, dropRows),
  );
}

/**
 * Rows of ANOTHER job the drop lands in and must therefore cut. `reflowed` picks the side: a fixed
 * drop collides with the other fixed rows, a reflowed drop with the other movable ones, ignoring
 * fixed rows entirely and cutting only a row that STARTS BEFORE it. Measured against the drop's
 * SEGMENTS, so a stretch across the lunch break counts the time it really occupies.
 */
function otherJobOverlaps(
  draft: readonly Block[],
  placed: Block,
  dropRows: readonly DropSegment[],
  today: string,
  reflowed: boolean,
): Block[] {
  return sortedByQueueRank(draft).filter(
    (row) =>
      row.projectId !== placed.projectId &&
      row.date === placed.date &&
      isMovable(row, today) === reflowed &&
      overlapsDrop(row, dropRows) &&
      (!reflowed || row.startMinutes < placed.startMinutes),
  );
}

/**
 * One day as MANUAL placement sees it. `buildDayPlan` answers "what may the engine fill here" and
 * says zero for a weekend; this answers "where could these hours physically go".
 */
interface ManualDayPlan extends ClockRuler {
  workingMinutes: number;
  freeRuns: IndexRange[];
}

function buildManualDayPlan(input: ComposeInput, date: string, blocks: readonly Block[]): ManualDayPlan {
  const config = input.getDayConfig(date);
  const { spans, workingMinutes } = buildPeriodSpans(config.periods);
  if (config.isClosed) return { date, spans, workingMinutes, freeRuns: [] };

  // Every row on the day counts, movable or not: displaced hours must not land on top of what the
  // owner can currently see.
  const obstacles: IndexRange[] = [];
  for (const gap of input.gaps) {
    if (gap.date !== date) continue;
    obstacles.push(...toIndexRanges(spans, gap.startMinutes, gap.startMinutes + gap.durationMinutes));
  }
  for (const block of blocks) {
    if (block.date !== date) continue;
    obstacles.push(...toIndexRanges(spans, block.startMinutes, block.startMinutes + block.durationMinutes));
  }

  return { date, spans, workingMinutes, freeRuns: freeRangesOf(mergeRanges(obstacles), workingMinutes) };
}

/** The first working minute at or after `clock`, as an index. Snaps over lunch and the margins. */
function indexAtOrAfter(plan: ManualDayPlan, clock: number): number {
  for (const span of plan.spans) {
    if (clock <= span.startClock) return span.startIndex;
    const spanEndClock = span.startClock + (span.endIndex - span.startIndex);
    if (clock < spanEndClock) return span.startIndex + (clock - span.startClock);
  }
  return plan.workingMinutes;
}

interface DisplacedHours {
  date: string;
  /** The clock minute the tail must start at or after — the end of the dropped row. */
  afterClock: number;
  minutes: number;
}

/**
 * Places the tail of a cut row: from the drop's end, forward only, in the day's free working time,
 * then chaining into following days exactly as overflow does. `null` when the hours do not fit before
 * the horizon. `toClockSegments` keeps neither head nor tail straddling a non-working interval.
 */
function pushDisplacedMinutes(
  input: ComposeInput,
  draft: readonly Block[],
  displaced: DisplacedHours,
): Segment[] | null {
  const horizon = horizonEndDate(input.today, input.planningHorizonWeeks);
  const onWeekend = isWeekend(displaced.date);
  const segments: Segment[] = [];
  let remaining = displaced.minutes;
  let date = displaced.date;
  let first = true;

  while (remaining > 0) {
    if (!first && compareDates(date, horizon) > 0) return null;
    const plan = buildManualDayPlan(input, date, draft);
    const from = first ? indexAtOrAfter(plan, displaced.afterClock) : 0;
    for (const run of plan.freeRuns) {
      if (remaining <= 0) break;
      const start = Math.max(run.start, from);
      const available = run.end - start;
      if (available <= 0) continue;
      const chunk = Math.min(available, remaining);
      segments.push(...toClockSegments(plan, start, chunk));
      remaining -= chunk;
    }
    if (remaining <= 0) break;
    date = nextManualDate(date, onWeekend);
    first = false;
  }

  return mergeTouchingSegments(segments);
}

/**
 * The next day displaced hours may use. A WEEKEND TAIL STAYS ON THE WEEKEND: carrying Saturday's
 * remainder onto Monday would be the engine deciding the shop does not work Saturdays. Everything
 * else walks the weekdays, skipping the weekend and the buffer — a displaced row is not growth.
 */
function nextManualDate(date: string, onWeekend: boolean): string {
  let next = addDays(date, 1);
  while (onWeekend ? !isWeekend(next) : isWeekend(next) || weekdayOf(next) === FRIDAY) {
    next = addDays(next, 1);
  }
  return next;
}

function manualFailure(
  code: ManualPlacementErrorCode,
  about: Block | { blockId: string },
): ManualPlacementFailure {
  const details =
    'blockId' in about
      ? { blockId: about.blockId }
      : {
          blockId: about.id,
          projectId: about.projectId,
          date: about.date,
          startMinutes: about.startMinutes,
          durationMinutes: about.durationMinutes,
        };
  return { ok: false, error: { code, messageKey: MANUAL_PLACEMENT_MESSAGE_KEYS[code], ...details } };
}

// ---------------------------------------------------------------------------
// The summary strip's arithmetic
// ---------------------------------------------------------------------------

/** What the amber strip states, as numbers only — the wording and formatting belong to the UI. */
export interface ScheduleSummary {
  /** The last date carrying work from today onwards, or `null` for a clear calendar. */
  lastOccupiedDate: string | null;
  /** Minutes still on the calendar from today onwards. */
  queuedMinutes: number;
  /** The Friday whose state `bufferClear` describes. */
  bufferDate: string;
  /** True while that Friday carries no work, so the buffer is still available. */
  bufferClear: boolean;
}

/** One endpoint serves the strip. Hours already worked are not queued, so only today on counts. */
export function summarizeSchedule(blocks: readonly Block[], today: string): ScheduleSummary {
  let lastOccupiedDate: string | null = null;
  let queuedMinutes = 0;

  for (const block of blocks) {
    if (compareDates(block.date, today) < 0) continue;
    queuedMinutes += block.durationMinutes;
    if (lastOccupiedDate === null || compareDates(block.date, lastOccupiedDate) > 0) {
      lastOccupiedDate = block.date;
    }
  }

  // The buffer the owner cares about is the next Friday still ahead, so on a
  // Saturday the strip already talks about next week's.
  const weekday = weekdayOf(today);
  const bufferDate = addDays(today, weekday <= FRIDAY ? FRIDAY - weekday : DAYS_PER_WEEK + FRIDAY - weekday);
  const bufferClear = !blocks.some((block) => block.date === bufferDate);

  return { lastOccupiedDate, queuedMinutes, bufferDate, bufferClear };
}

// ---------------------------------------------------------------------------
// Internals — moving hours between the rows of one job
// ---------------------------------------------------------------------------

interface TakeOutcome {
  ok: boolean;
  deletedBlockIds: string[];
  touchedLockedBlockIds: string[];
}

/**
 * Takes `minutes` off `ordered` from the far end backwards, unlocked rows first and locked ones only
 * when the job has nothing else left. Mutates the `draft` members it is given.
 */
function takeMinutes(ordered: readonly Block[], minutes: number): TakeOutcome {
  const deletedBlockIds: string[] = [];
  const touchedLockedBlockIds: string[] = [];
  let remaining = minutes;

  for (const lockedPass of [false, true]) {
    for (let index = ordered.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const block = ordered[index];
      if (block.locked !== lockedPass) continue;
      const take = Math.min(block.durationMinutes, remaining);
      if (take <= 0) continue;
      block.durationMinutes -= take;
      remaining -= take;
      if (lockedPass) touchedLockedBlockIds.push(block.id);
      if (block.durationMinutes === 0) deletedBlockIds.push(block.id);
    }
  }

  return { ok: remaining === 0, deletedBlockIds, touchedLockedBlockIds };
}

/**
 * The job's last row THE ENGINE STILL LAYS OUT — the counterparty every transfer that ADDS hours
 * uses. It is `isMovable` and nothing narrower, because hours added to a row the reflow cannot touch
 * are written straight onto the clock, where they can run over other work, through the lunch break
 * or past the end of the day with nothing to settle them. Taking hours AWAY is not symmetrical and
 * still reaches every row: shrinking frees space rather than claiming it — see `takeMinutes`.
 */
function lastAutomatic(ordered: readonly Block[], today: string): Block | undefined {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (isMovable(ordered[index], today)) return ordered[index];
  }
  return undefined;
}

/**
 * A row for hours that have nowhere to go, ranked immediately after `anchor`. Its date is pulled
 * forward into the movable pool: a row parked on a weekend or in the past would be an obstacle the
 * engine could never place.
 */
function createdRowAfter(
  anchor: Block | undefined,
  draft: readonly Block[],
  minutes: number,
  change: HoursChange,
): Block {
  const queue = sortedByQueueRank(draft);
  const reference = anchor ?? queue[queue.length - 1];
  let date = change.today;
  let startMinutes = 0;

  if (reference !== undefined) {
    date = compareDates(reference.date, change.today) > 0 ? reference.date : change.today;
    if (date === reference.date) {
      startMinutes = Math.min(reference.startMinutes + reference.durationMinutes, MAX_RANK_MINUTES);
    }
  }
  while (isWeekend(date)) {
    date = addDays(date, 1);
    startMinutes = 0;
  }

  return {
    id: change.newBlockId,
    projectId: change.projectId,
    date,
    startMinutes,
    durationMinutes: minutes,
    // Hours the engine invented, on a day nobody chose: the reflow owns them.
    locked: false,
    createdAt: change.now,
    updatedAt: change.now,
  };
}

function cloneBlock(block: Block): Block {
  return { ...block };
}

function settledEdit(
  blocks: Block[],
  deletedBlockIds: string[],
  totalMinutesDelta: number,
  touchedLockedBlockIds: string[],
): EditSuccess {
  return { ok: true, blocks, deletedBlockIds, totalMinutesDelta, touchedLockedBlockIds };
}

function failedEdit(
  code: EditErrorCode,
  about: {
    blockId?: string;
    projectId?: string;
    freedMinutes?: number;
    choices?: FreedHoursChoice[];
  },
): EditFailure {
  return { ok: false, error: { code, messageKey: EDIT_MESSAGE_KEYS[code], ...about } };
}
