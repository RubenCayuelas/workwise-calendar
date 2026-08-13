/**
 * The composition engine.
 *
 * `src/lib/composition.test.ts` is the specification; every rule below names the
 * section of CLAUDE.md it comes from.
 *
 * The engine is a PURE FUNCTION OVER A SNAPSHOT: schedule state in, new
 * placement out. It never touches the database, never reads the clock (`today`
 * is an explicit input) and never returns user-facing text (only i18n keys —
 * translations live in public/locales/{lang}/common.json). That is what makes
 * every rule in CLAUDE.md's "Composition Engine Business Rules" testable, and
 * it is why this module must not import src/lib/db.ts.
 *
 * Every time is an INTEGER NUMBER OF MINUTES FROM MIDNIGHT. Decimal hours exist
 * only at the database boundary and in what the owner reads.
 *
 * THE ONE IDEA WORTH READING BEFORE THE CODE — a day is handled twice over:
 *
 * - On the CLOCK, where a row is drawn: `08:00-14:00`, lunch, `15:30-19:30`.
 * - On the WORKING TIMELINE, an index space in which the day is a single ruler
 *   of `shiftMinutes` minutes with the lunch break cut out. Index 0 is
 *   `period1Start`; index 360 is both `14:00` and `15:30`.
 *
 * Placement happens entirely in index space, which is what makes "a job flows
 * across lunch" and "a job never straddles a non-working interval" the same
 * statement: the job occupies one contiguous index range, and `toClockSegments`
 * cuts that range at the period boundaries when it turns it back into rows.
 * Obstacles (gaps, locked blocks, the frozen past, the weekend) are projected
 * into the same index space, so "plannable minutes" and "does this fit" are
 * plain integer arithmetic on one ruler.
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
import {
  adjacentInWindows,
  clockEndOf,
  dayEndMinutes,
  usesManualOnlyTime,
  type DayWindows,
} from './manualWindow';
import { MIN_ROW_MINUTES } from './validation';

/** The i18n key `compose` reports when the hours run past the planning horizon. */
export const HORIZON_EXCEEDED_KEY = 'errors.horizonExceeded';

const DAYS_PER_WEEK = 7;

/** A provisional row's rank must stay a valid time of day. */
const MAX_RANK_MINUTES = 1439;

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

/**
 * How the engine is allowed to treat one calendar day.
 *
 * - `auto`   Monday-Thursday: filled sequentially with the movable pool.
 * - `buffer` Friday: the colchón. Absorbs work that grew beyond its estimate,
 *            never a new job (see `ComposeInput.newProjectIds`). It IS in the
 *            movable pool, so the buffer self-cleans when Mon-Thu frees up.
 * - `manual` Saturday and Sunday: outside the engine. Never auto-placed and
 *            never auto-recovered — work is only ever there because a human put
 *            it there, so the engine must not undo that decision.
 */
export type DayRole = 'auto' | 'buffer' | 'manual';

/**
 * One day as the engine reads it: `getDayConfig(date)` is its only source.
 *
 * It carries BOTH views of the day (`DayWindows`), and which one a rule reads is the
 * rule: everything auto-fill does is stated over `periods`, everything a HAND action
 * does over `manualWindows`. See src/lib/manualWindow.ts.
 */
export interface DayConfig extends DayWindows {
  /** Working periods, chronological and non-overlapping (morning, afternoon). */
  periods: readonly WorkPeriod[];
  /**
   * The periods plus the visual margins, fused where they touch. A drop, a resize and the
   * scissors may use this whole stretch; auto-fill may not, and never sees it.
   */
  manualWindows: readonly WorkPeriod[];
  /** The auto-fill stop line for this day, in minutes. Never a limit on manual placement. */
  capacityMinutes: number;
  role: DayRole;
  /** A holiday or a closed week: no plannable time at all, whatever `role` says. */
  isClosed: boolean;
}

/**
 * The standard resolver: global settings, then the weekday rule
 * (Mon-Thu `auto`, Fri `buffer`, Sat/Sun `manual`), then `day_overrides`.
 * Pure — hand it the `DayShape` from `dayShapeFromSettings()` and the override
 * rows for the window being composed.
 *
 * An override's `capacityHours` replaces the global stop line but is still
 * capped at the shift: capacity exists to stop auto-fill early, never to book
 * hours the periods do not cover.
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
   * The calendar as it stands, in any order. Pass every block from the window
   * the caller intends to rewrite (at minimum today through the horizon);
   * whatever is passed comes back in the result.
   *
   * A block's `date`/`startMinutes` are its QUEUE RANK as much as its position:
   * the queue order is `ORDER BY date, start_time` (see `buildQueue`). To insert
   * work at a given point in the queue — a drop, or a brand-new job appended at
   * the end — the caller writes a provisional block whose start sorts where the
   * user aimed. The provisional block may carry the job's whole duration; the
   * engine re-segments the movable pool anyway.
   */
  blocks: readonly Block[];

  /** Fixed occupancy. Gaps consume plannable minutes and are never modified. */
  gaps: readonly Gap[];

  getDayConfig: (date: string) => DayConfig;

  /** Auto-placement never creates a block beyond this many weeks from `today`. */
  planningHorizonWeeks: number;

  /**
   * Projects created in this same operation. Their work never targets the Friday
   * buffer: if it does not fit Mon-Thu it skips Friday and lands on next week's
   * Monday — wherever the caller happened to park the provisional row, including
   * on a Friday itself.
   */
  newProjectIds?: readonly string[];

  /**
   * Projects whose hours THIS operation raised — the job's estimate went up, or a
   * block was enlarged. CLAUDE.md: "Friday receives only overflow generated by the
   * growth of already-placed work", so this is the ONLY way new hours reach the
   * buffer. Leave it empty for a deletion, a drag, a gap, a capacity change or a
   * rename: those must not eat the colchón.
   *
   * Work that is ALREADY on a Friday is not pushed off it by an unrelated save
   * (see `QueueItem.originalDates`); it is only ever pulled back into Mon-Thu when
   * room appears there, which is the "self-cleaning" half of the rule.
   */
  grownProjectIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One row of the recomposed calendar. */
export interface PlacedBlock {
  /**
   * The row this segment reuses, or `null` when the caller must INSERT it.
   * An item's segments reuse the ids of the blocks it was built from, in order;
   * ids left over appear in `deletedBlockIds`.
   */
  id: string | null;
  projectId: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  locked: boolean;
  /**
   * Carried through untouched for a fixed row, and copied from the queue item for a
   * reflowed one — every row an item with a hand-set duration produces keeps the
   * mark, so a stretch the owner sized by hand that had to be cut at the lunch break
   * is still one hand-set stretch on the next pass.
   */
  manualDuration: boolean;
  /**
   * Carried through untouched. Every row that carries it is outside the movable pool,
   * so it can only ever come from a fixed row handed straight back — the engine never
   * sets it and never clears it.
   */
  handPlaced: boolean;
}

export type ComposeErrorCode = 'horizon-exceeded';

/**
 * The only way composition fails. A locked block can never cause a failure:
 * overflow always chains forward into following days and weeks.
 */
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
  /**
   * The complete calendar after recomposition — including the locked, past and
   * weekend blocks, unchanged. Sorted by `date`, then `startMinutes`.
   */
  blocks: PlacedBlock[];
  /** Input ids absent from `blocks`: rows the caller must DELETE. */
  deletedBlockIds: string[];
}

export interface ComposeFailure {
  ok: false;
  error: ComposeError;
}

/**
 * Success carries a placement and failure carries none — there is no partial
 * placement to roll back by hand.
 */
export type ComposeResult = ComposeSuccess | ComposeFailure;

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * One unit of work the engine places as a single indivisible piece: a run of
 * consecutive movable blocks of the same project, with no OTHER MOVABLE project
 * between them in queue order. Two runs of the same project separated by a
 * movable block of another project are two items — that is how `B, A, C, A`
 * stays four items.
 *
 * A fixed block (locked, past, weekend) does NOT break a run, and that is load
 * bearing rather than incidental. Grouping has to be a function of something the
 * reflow preserves, because the reflow is derived from the grouping: if a fixed
 * block split a run, then moving the run to the other side of that block — which
 * the reflow does all the time — would regroup the queue and lay the same hours
 * out differently on the NEXT recomposition. The calendar would visibly reshape
 * itself on an unrelated save. Movable order is preserved by the reflow (strict
 * order, forward-only cursor), so grouping on it alone makes `compose` a fixed
 * point; see the regression test "recomposing twice is not a second reflow".
 *
 * The cost, worth knowing: a job the owner split by hand around a locked block on
 * the same day is rejoined into one item, so it may hop the lock whole and leave
 * the hole in front of it empty (rules 7 and 8 applied to the whole job). The
 * documented way to nail hours down is `locked`, on the half being kept.
 *
 * THE ONE THING THAT DOES BREAK A RUN — a HAND-SET DURATION (`Block.manualDuration`).
 * A row the owner sized with the bottom-edge drag is its own item, and the job's
 * remaining hours are the item after it. Read against the paragraph above, this is
 * the case that looks dangerous and is not, so the distinction is worth stating
 * exactly:
 *
 *   The earlier defect broke a run at a FIXED block — a property of the LAYOUT
 *   (`locked`, or the date being past or a weekend, which the reflow itself moves
 *   rows across). Grouping was therefore a function of the placement while the
 *   placement was a function of the grouping, so an unrelated save re-cut the queue
 *   and resized somebody's blocks. `manualDuration` is a COLUMN. It is written only
 *   by the gesture that sets it and cleared only by the gestures that overwrite the
 *   duration it stands for (see *A Hand-Set Duration* in CLAUDE.md); no reflow ever
 *   sets or clears it, and moving a row across days does not change it. Grouping
 *   therefore stays a function of (stored flags x movable order), both of which the
 *   reflow preserves, and `compose` stays a fixed point — the property the
 *   "recomposing twice is not a second reflow" test and the 2000-seed harness pin
 *   down.
 *
 * Consecutive hand-set rows of one job ON ONE DAY are one item, because that is the
 * shape a hand-set stretch comes back as when it had to be cut at the lunch break:
 * regrouping them keeps the second pass looking at the same 7 h the owner drew,
 * rather than at a 2 h item and a 5 h item.
 */
export interface QueueItem {
  projectId: string;
  /** The blocks this item was built from, in queue order. */
  blockIds: string[];
  durationMinutes: number;
  /** True when the project is listed in `ComposeInput.newProjectIds`. */
  isNew: boolean;
  /** True when the project is listed in `ComposeInput.grownProjectIds`. */
  grown: boolean;
  /**
   * The owner set this stretch's length by hand. The engine keeps it, ends the job's
   * run here, and lets no more of that job onto the day it lands on — see
   * `compose`'s "a hand-set stretch closes its job's day".
   */
  manualDuration: boolean;
  /**
   * This item is NOT its job's first item in the queue, so its hours are the REST of
   * work already under way — the tail a drop cut off, or the hours a hand-set length
   * pushed out of its day. See `compose`'s "a continuation fills forward".
   *
   * Derived from the queue rather than stored, and safe for the same reason the
   * grouping above is: the reflow preserves movable order, so "is there an earlier item
   * of this job" gives the same answer on the next pass.
   */
  continuation: boolean;
  /**
   * The dates this item's rows already sit on. Only consulted for the Friday
   * buffer, where it is what keeps an unrelated save from pushing absorbed
   * overflow off Friday and into next week.
   */
  originalDates: string[];
}

/**
 * THE ROWS DRAWN AS ONE UNIT WITH `target` — the thing the owner actually grabs.
 *
 * A unit is a run of rows of ONE job on one day with nothing WORKABLE between them: the two
 * halves around the lunch break, or rows that simply touch. It has one drag handle on
 * screen, so a body drag is a statement about all of it, and the server needs the same
 * answer the grid drew: a move that re-ranked the rows ONE REQUEST AT A TIME, with a full
 * reflow between them, left part of the unit behind — the reflow re-laid the job's remaining
 * hours onto DIFFERENT ids, so the second request moved whatever row now carried the id the
 * drag had captured, and the toast said no hour was lost (true) while an hour of the unit had
 * not moved (invariant 8).
 *
 * The predicate is `adjacentInWindows`, the same one `groupBlocks` groups the grid with and
 * `stretchFrom` sizes a stretch with, so a unit on screen and a unit here cannot disagree.
 * Rows of ANOTHER job break the run, exactly as they break it on screen.
 */
export function unitOf(
  blocks: readonly Block[],
  target: Block,
  manualWindows: readonly WorkPeriod[],
): Block[] {
  const day = sortedByQueueRank(blocks.filter((row) => row.date === target.date));
  let unit: Block[] = [];

  for (const row of day) {
    const last = unit[unit.length - 1];
    const joins =
      last !== undefined &&
      last.projectId === row.projectId &&
      adjacentInWindows(manualWindows, last.startMinutes + last.durationMinutes, row.startMinutes);
    if (joins) {
      unit.push(row);
      continue;
    }
    if (unit.some((row) => row.id === target.id)) return unit;
    unit = [row];
  }

  return unit.some((row) => row.id === target.id) ? unit : [target];
}

/**
 * The movable pool in visual order: `ORDER BY date, start_time`, ties broken by
 * `createdAt` then `id` so the ordering is total and the engine deterministic.
 * Fixed blocks (locked, past, weekend) are obstacles, not queue items, and they
 * are skipped without breaking the run around them — see `QueueItem` for why the
 * grouping has to ignore them, and for why a hand-set duration may break one.
 */
export function buildQueue(input: ComposeInput): QueueItem[] {
  const newProjects = new Set(input.newProjectIds ?? []);
  const grownProjects = new Set(input.grownProjectIds ?? []);
  const items: QueueItem[] = [];
  const started = new Set<string>();
  let open: QueueItem | null = null;
  let openDate = '';

  for (const block of sortedByQueueRank(input.blocks)) {
    if (!isMovable(block, input.today)) continue;
    // An automatic run absorbs the next automatic block of the same job; a hand-set
    // stretch absorbs only another hand-set row of the same job on the same day (the
    // two halves of one stretch around lunch). The two kinds never join, which is
    // what makes the hand-set length survive the reflow.
    const joins =
      open !== null &&
      open.projectId === block.projectId &&
      open.manualDuration === block.manualDuration &&
      (!block.manualDuration || openDate === block.date);

    if (open !== null && joins) {
      open.blockIds.push(block.id);
      open.durationMinutes += block.durationMinutes;
      if (!open.originalDates.includes(block.date)) open.originalDates.push(block.date);
      openDate = block.date;
      continue;
    }
    open = {
      projectId: block.projectId,
      blockIds: [block.id],
      durationMinutes: block.durationMinutes,
      isNew: newProjects.has(block.projectId),
      grown: grownProjects.has(block.projectId),
      manualDuration: block.manualDuration,
      continuation: started.has(block.projectId),
      originalDates: [block.date],
    };
    openDate = block.date;
    started.add(block.projectId);
    items.push(open);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Predicates and arithmetic
// ---------------------------------------------------------------------------

/**
 * The movable pool. A block is moved by the engine iff it is unlocked, NOT
 * hand-placed, dated today or later, and not on a Saturday or Sunday. An
 * engine-placed Friday row is movable — that is the buffer self-cleaning.
 *
 * `handPlaced` is the flag that makes the Friday buffer work in both directions.
 * Friday is in the pool so the engine can put growth overflow there AND take it back
 * when Mon-Thu frees up; the cost was that a HAND drop onto Friday was pulled straight
 * back, so the request answered 200 and changed nothing and there was no way at all to
 * put work on a Friday by hand. Nothing on the row said who had put it there. Now
 * something does, and the answer is the one the weekend has always given: work a human
 * placed is a fixed obstacle, and the engine flows around it.
 *
 * Written only by a drop onto a day the engine would otherwise recover from (see
 * `operations/blocks.ts`), but read here uniformly — the ENGINE's rule is "a
 * hand-placed row does not move", and which days earn the mark is the caller's policy.
 */
export function isMovable(block: Block, today: string): boolean {
  if (block.locked || block.handPlaced) return false;
  if (compareDates(block.date, today) < 0) return false;
  return !isWeekend(block.date);
}

/**
 * The minutes the engine may fill on `date`:
 * `min(capacityMinutes, period minutes − minutes taken by gaps and locked blocks)`,
 * the occupied part computed as a UNION OF INTERVALS clipped to the periods, so
 * an overlapping gap and locked block are never counted twice.
 *
 * Zero for a closed day, for a `manual` day and for any date before `today`.
 */
export function plannableMinutes(input: ComposeInput, date: string): number {
  return buildDayPlan(input, date).plannableMinutes;
}

/** The last date auto-placement may use: `today + planningHorizonWeeks * 7 − 1` days. */
export function horizonEndDate(today: string, planningHorizonWeeks: number): string {
  // A horizon below one week would leave the engine with nowhere to write at
  // all; `writeSettings` already floors it, and this keeps a hand-built input
  // from turning into "nothing fits anywhere".
  const weeks = Math.max(1, Math.trunc(planningHorizonWeeks));
  return addDays(today, weeks * DAYS_PER_WEEK - 1);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Reflows the movable pool in queue order, from `today` forward.
 *
 * Placement, in one paragraph: a cursor walks forward and never goes back, so a
 * hole left in front of an obstacle stays empty (never backfill) and once an
 * item overflows, the rest of the queue follows it (strict order). An item is
 * placed whole wherever it fits — the space left in a day being
 * `min(the free run from the cursor, the day's remaining plannable minutes)` —
 * and is split across days only when no single day within the horizon could hold
 * it whole. Inside a day, work that crosses a non-working interval is emitted as
 * separate segments of the same project, since a stored block is always a solid
 * rectangle on the clock; touching segments of the same project inside the same
 * period are merged back into one row.
 *
 * A HAND-SET STRETCH CLOSES ITS JOB'S DAY, and this is the one place strict order
 * is deliberately broken (decided with the owner, 2026-08-12). A row whose length
 * the owner drew keeps that length, so the job's remaining hours cannot simply
 * continue after it — they would flow straight back into the hours just given up
 * and auto-merge would undo the gesture. Two rules do it:
 *
 *  - once a hand-set stretch of job X lands on day D, no more of X may be placed
 *    on D. Stated over the DAY rather than over "the next item", so it holds again
 *    on the following pass, when the remainder is no longer the next item;
 *  - the remainder is DEFERRED while the jobs behind it fill the hours the stretch
 *    freed on D, and placed as soon as one of them would have to leave D. So the
 *    remainder starts on the next auto-fill day and the day is not left with a hole.
 *
 * The deferral only ever fires on the pass that follows the resize: afterwards the
 * remainder is no longer adjacent to the stretch in the queue and lands in exactly
 * the same place by ordinary forward fill, which is what keeps this a fixed point.
 *
 * A CONTINUATION FILLS FORWARD, and this is where "never split a job to make it fit"
 * stops (decided with the owner, 2026-08-12). That rule is about PLACING a job. Applied
 * to a tail that is already a continuation of work under way it produced the defect the
 * owner reported: drop a 2 h job into the middle of a full Thursday and the 10 h that
 * had to move went WHOLE to the following Monday, leaving Thursday empty from noon.
 *
 * So an item that is not its job's first in the queue — `QueueItem.continuation` — is
 * placed by the same path as a job longer than a day: it takes the hours left in the
 * day it was cut on and continues on the next auto-fill day. Everything else is
 * unchanged, and deliberately so:
 *
 *  - a job's FIRST item still moves whole or not at all, so a new job never leaves a
 *    stub behind (rule 8) — get this backwards and the rule is gone;
 *  - the continuation is still placed IN ITS QUEUE POSITION, so strict order holds and
 *    nothing is brought forward into the space it left;
 *  - it is still not growth, so it skips the Friday buffer like any displaced work.
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

  // Everything outside the movable pool comes back exactly as it went in. Those
  // rows are also never auto-merged: tidying two touching weekend rows would
  // rewrite a decision the engine did not make, and merging a locked row would
  // move it.
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
      manualDuration: block.manualDuration,
      handPlaced: block.handPlaced,
    });
  }

  const deletedBlockIds: string[] = [];
  const reflowed: PlacedBlock[] = [];

  /**
   * `date|projectId` pairs a hand-set stretch has closed for the rest of the day.
   *
   * Seeded from the QUEUE, so a hand-set row that has left the pool — locked, hand-placed,
   * on a weekend, in the frozen past — does not close its day. That asymmetry is real and
   * visible: padlocking a hand-set row re-opens the day the ruler had closed and pulls the
   * same job back onto it, which is *back to automatic* performed by the strictest of the
   * three marks. It is left as it is deliberately, because closing the day instead is what
   * empties it and parks the work later — the shape of the owner's own «redimensiona mal
   * empujando de forma errónea otros bloques», an Open Decision in CLAUDE.md. Whichever way
   * it goes, it goes the same way for all three marks and for the padlock at once.
   */
  const closedDays = new Set<string>();

  // The forward-only cursor: a date, plus how far into that date we have got.
  let cursorDate = input.today;
  let cursor = openDay(planFor(cursorDate));
  /** The day the hand-set stretch just placed ended on — the day its remainder must leave. */
  let handSetDate = '';

  /**
   * The first day from the cursor onwards that can hold the item WHOLE (never split
   * to make it fit). Days in between are abandoned: the rest of the queue follows
   * the item, it is never brought forward.
   *
   * `null` for a CONTINUATION, which is what sends it down the fill-forward path
   * instead — see `compose`'s "a continuation fills forward".
   */
  const targetFor = (item: QueueItem): ItemTarget | null => {
    if (item.continuation) return null;
    for (let date = cursorDate; compareDates(date, horizon) <= 0; date = addDays(date, 1)) {
      const day = date === cursorDate ? cursor : openDay(planFor(date));
      if (!acceptsItem(day.plan, item, closedDays)) continue;
      const spot = findWholeFit(day, item.durationMinutes);
      if (spot !== null) return { date, day, ...spot };
    }
    return null;
  };

  /** True when the item would start on `date` — used to know when the cursor is about to leave it. */
  const startsOn = (item: QueueItem, date: string): boolean => {
    // An empty item is dropped rather than placed, so it leaves no day.
    if (item.durationMinutes <= 0) return true;
    if (cursorDate !== date) return false;
    const target = targetFor(item);
    if (target !== null) return target.date === date;
    // The split path: an item no single day can hold starts wherever the cursor
    // stands, as long as this day can still take something of it.
    return acceptsItem(cursor.plan, item, closedDays) && remainingRoom(cursor) > 0;
  };

  /** Places one item, or reports the engine's single failure without writing anything. */
  const placeItem = (item: QueueItem): ComposeError | null => {
    if (item.durationMinutes <= 0) {
      // Defensive: a zero-length row is not valid data (the schema forbids it)
      // and has no place on the calendar.
      deletedBlockIds.push(...item.blockIds);
      return null;
    }

    const segments: Segment[] = [];
    const target = targetFor(item);

    if (target !== null) {
      cursorDate = target.date;
      cursor = target.day;
      cursor.runIndex = target.runIndex;
      cursor.positionIndex = target.startIndex;
      segments.push(...takeExactly(cursor, item.durationMinutes));
    } else {
      // Either no single day within the horizon could hold it whole — this job is
      // longer than a day — or it is a CONTINUATION, which fills forward by the same
      // machinery. It takes the hours left in the day the cursor is already on and the
      // remainder continues on the next fillable day.
      let remaining = item.durationMinutes;
      for (let date = cursorDate; remaining > 0 && compareDates(date, horizon) <= 0; date = addDays(date, 1)) {
        const day = date === cursorDate ? cursor : openDay(planFor(date));
        if (!acceptsItem(day.plan, item, closedDays)) continue;
        const taken = takeUpTo(day, wantedFrom(day, remaining));
        if (taken.length === 0) continue;
        for (const segment of taken) remaining -= segment.durationMinutes;
        cursorDate = date;
        cursor = day;
        segments.push(...taken);
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
    }

    if (item.manualDuration) {
      for (const segment of segments) closedDays.add(dayKey(segment.date, item.projectId));
      handSetDate = segments[segments.length - 1].date;
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
        locked: false,
        manualDuration: item.manualDuration,
        // A queue item is by definition movable, so nothing the reflow places is
        // hand-placed. The mark only ever travels on the fixed rows above.
        handPlaced: false,
      });
    });
    deletedBlockIds.push(...item.blockIds.slice(rows.length));
    return null;
  };

  // Remainders of hand-set stretches, held back while the jobs behind them take the
  // hours those stretches freed, and let go the moment an item would have to leave
  // the day. One per stretch, in queue order, so a week with two hand-set rows on
  // different jobs drains them in the order the queue had them.
  const deferred: QueueItem[] = [];
  let deferralDate: string | null = null;
  let remainderOf: string | null = null;

  const drain = (): ComposeError | null => {
    const waiting = deferred.splice(0);
    deferralDate = null;
    for (const item of waiting) {
      const failure = placeItem(item);
      if (failure !== null) return failure;
    }
    return null;
  };

  const queue = buildQueue(input);
  // Where each job's LAST item sits. The deferral is allowed to overtake other jobs
  // and nothing else: reordering two items of ONE job would leave them adjacent on
  // the calendar with no item of another job between them, the next pass would group
  // them into one, and the same hours would come out laid out differently. That is
  // the grouping drift this engine is built to avoid, so a remainder with more of its
  // own job behind it in the queue is simply placed in turn.
  const lastItemOfProject = new Map<string, number>();
  queue.forEach((item, index) => lastItemOfProject.set(item.projectId, index));

  for (const [index, item] of queue.entries()) {
    if (remainderOf === item.projectId && lastItemOfProject.get(item.projectId) === index) {
      deferred.push(item);
      if (deferralDate === null) deferralDate = handSetDate;
      continue;
    }
    if (deferralDate !== null && !startsOn(item, deferralDate)) {
      const drained = drain();
      if (drained !== null) return { ok: false, error: drained };
    }
    remainderOf = null;
    const failure = placeItem(item);
    if (failure !== null) return { ok: false, error: failure };
    if (item.manualDuration) remainderOf = item.projectId;
  }

  const drained = drain();
  if (drained !== null) return { ok: false, error: drained };

  // Auto-merge is about what ends up touching on the calendar, not about what the
  // queue thought, so the last word on it is taken over the whole reflowed set.
  reflowed.sort(byCalendarPosition);
  const blocks = [...fixed, ...mergeTouchingRows(reflowed, deletedBlockIds)].sort(byCalendarPosition);
  return { ok: true, blocks, deletedBlockIds };
}

// ---------------------------------------------------------------------------
// Internals — the working timeline
// ---------------------------------------------------------------------------

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
 * A day's index ruler, plus the date its clock times belong to — everything
 * `toClockSegments` needs. Both `DayPlan` (auto-fill) and `ManualDayPlan` (a hand
 * drop displacing somebody else's row) are one.
 */
interface ClockRuler {
  date: string;
  spans: PeriodSpan[];
}

/** Everything the engine needs to know about one day, derived once and cached. */
interface DayPlan extends ClockRuler {
  role: DayRole;
  workingMinutes: number;
  /** Unoccupied stretches of the index ruler. Two stretches are one run iff no obstacle separates them. */
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

/** Where an item is about to be placed whole: the day, and the spot inside it. */
interface ItemTarget {
  date: string;
  day: DayCursor;
  runIndex: number;
  startIndex: number;
}

/** The key of "job X may take no more of day D". The date is fixed width, so it never aliases. */
function dayKey(date: string, projectId: string): string {
  return `${date}|${projectId}`;
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
 * Projects a clock interval onto the index ruler, dropping whatever falls
 * outside the working periods — an obstacle over the lunch break costs the day
 * nothing. This is what makes gaps and locked blocks ONE occupancy set.
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
    freeRuns: usable ? freeRangesOf(occupied, workingMinutes) : [],
    plannableMinutes: plannable,
    fillable: usable && plannable > 0,
  };
}

function openDay(plan: DayPlan): DayCursor {
  return { plan, budgetMinutes: plan.plannableMinutes, runIndex: 0, positionIndex: 0 };
}

/**
 * Rule 5, the Friday buffer — the one asymmetry in the engine.
 *
 * An `auto` day takes anything. A `buffer` day takes work only when one of two
 * things is true, and it is worth being precise about why both are needed:
 *
 * - the operation GREW that job, which is the only thing CLAUDE.md lets the
 *   colchón absorb ("Friday receives only overflow generated by the growth of
 *   already-placed work"); or
 * - the item is ALREADY on that Friday, so an unrelated save does not shove
 *   absorbed overflow into next week. Friday still self-cleans, because the
 *   cursor reaches Mon-Thu first and puts the hours there the moment they fit.
 *
 * A brand-new job is refused either way: the caller parks its provisional row
 * wherever the drop happened, and landing on a Friday is not evidence that the
 * job belongs on the buffer.
 *
 * Testing membership by DATE rather than by weekday is what makes the rule a
 * fixed point — the item's own rows are the evidence, and they are exactly what
 * the previous pass wrote.
 *
 * `closedDays` is the other refusal: a day a hand-set stretch of this same job has
 * already taken. Stated over the day so it survives into the next pass, when the
 * remainder is no longer the item right behind the stretch.
 */
function acceptsItem(plan: DayPlan, item: QueueItem, closedDays: ReadonlySet<string>): boolean {
  if (!plan.fillable) return false;
  if (closedDays.has(dayKey(plan.date, item.projectId))) return false;
  if (plan.role !== 'buffer') return true;
  if (item.isNew) return false;
  return item.grown || item.originalDates.includes(plan.date);
}

/** What `takeUpTo` could still take from this day: the free runs ahead of the cursor, capped by the budget. */
function remainingRoom(day: DayCursor): number {
  let free = 0;
  for (let index = day.runIndex; index < day.plan.freeRuns.length; index += 1) {
    const run = day.plan.freeRuns[index];
    const start = index === day.runIndex ? Math.max(day.positionIndex, run.start) : run.start;
    free += Math.max(0, run.end - start);
  }
  return Math.min(free, day.budgetMinutes);
}

/**
 * The first place from the cursor onwards where `minutes` fit WHOLE, the space
 * in a run being `min(what is left of the run, the day's remaining plannable
 * minutes)`. Runs before the cursor are never considered — that is the
 * no-backfill rule.
 */
function findWholeFit(day: DayCursor, minutes: number): { runIndex: number; startIndex: number } | null {
  if (day.budgetMinutes < minutes) return null;
  for (let index = day.runIndex; index < day.plan.freeRuns.length; index += 1) {
    const run = day.plan.freeRuns[index];
    const start = index === day.runIndex ? Math.max(day.positionIndex, run.start) : run.start;
    if (run.end - start >= minutes) return { runIndex: index, startIndex: start };
  }
  return null;
}

/** Places exactly `minutes` at the cursor. The caller has already checked it fits. */
function takeExactly(day: DayCursor, minutes: number): Segment[] {
  const run = day.plan.freeRuns[day.runIndex];
  const start = Math.max(day.positionIndex, run.start);
  const segments = toClockSegments(day.plan, start, minutes);
  day.positionIndex = start + minutes;
  day.budgetMinutes -= minutes;
  return segments;
}

/**
 * How much of `remaining` to ask a day for, so the split never leaves a row shorter than
 * a quarter of an hour — invariant 4.
 *
 * With every quantity on the quarter hour this is always `remaining` and the function does
 * nothing. It earns its place once an off-grid quantity gets into the calendar (an hour
 * total that lost a minute, a gap that does not sit on the quarter), because then the
 * arithmetic can leave 1-14 minutes over: a job of 19 h 59 min on days holding 600 and 590
 * placed `360 + 230` and then a NINE-MINUTE row on a day no gesture had touched — a
 * nameless two-pixel stripe, since a row that short cannot show its own hours.
 *
 * Two answers, and both keep every row a real row: leave exactly one quarter of an hour for
 * the tail, or — when that would make THIS day's row the sliver instead — take nothing here
 * and let the whole remainder go to the next day.
 */
function wantedFrom(day: DayCursor, remaining: number): number {
  const room = remainingRoom(day);
  if (room >= remaining) return remaining;
  if (remaining - room >= MIN_ROW_MINUTES) return remaining;
  // Fewer than two real rows' worth left: there is no split of it that avoids a short row,
  // and refusing to place it would be far worse than drawing it — an item the cursor keeps
  // skipping ends in `horizon-exceeded`, which rolls the whole save back.
  if (remaining < 2 * MIN_ROW_MINUTES) return remaining;
  return remaining - MIN_ROW_MINUTES;
}

/**
 * Fills the day from the cursor with up to `wanted` minutes, run by run — the
 * split path, used only for a job longer than any single day could hold. Still
 * forward-only, so it never reaches back over an obstacle it has passed.
 */
function takeUpTo(day: DayCursor, wanted: number): Segment[] {
  const segments: Segment[] = [];
  let remaining = Math.min(wanted, day.budgetMinutes);

  while (remaining > 0 && day.runIndex < day.plan.freeRuns.length) {
    const run = day.plan.freeRuns[day.runIndex];
    const start = Math.max(day.positionIndex, run.start);
    const available = run.end - start;
    if (available <= 0) {
      day.runIndex += 1;
      day.positionIndex = 0;
      continue;
    }
    const chunk = Math.min(available, remaining);
    segments.push(...toClockSegments(day.plan, start, chunk));
    day.positionIndex = start + chunk;
    day.budgetMinutes -= chunk;
    remaining -= chunk;
    if (chunk === available) {
      day.runIndex += 1;
      day.positionIndex = 0;
    }
  }

  return segments;
}

/**
 * Turns one contiguous index range back into rows, cutting it at every period
 * boundary: a stored block is always a solid rectangle on the clock, so the two
 * halves around lunch are two rows of the same job.
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
 * Auto-merge, rule 12, on the segments of one item: two that touch inside one
 * period are one row. The halves around lunch touch on the index ruler but not
 * on the clock, so they stay two rows — while a shift configured with no lunch
 * break (`period2Start === period1End`) has nothing to cut a row at and comes
 * back out as one solid rectangle.
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
 * The same rule one level up, across items: rows of the SAME job that touch on
 * the same day become one row. Only ever called with reflowed rows, so it can
 * never merge across jobs, never touch a locked row and never tidy the weekend
 * or the past.
 *
 * Two items of one job are normally kept apart by a movable item between them, so
 * this is the backstop rather than the common path — it fires when that separator
 * carried no hours at all and was dropped. It stays because it is the single place
 * that guarantees the calendar never shows two touching rows of one job.
 *
 * The surviving row keeps the first real id of the group so the caller writes an
 * UPDATE rather than a DELETE plus an INSERT; the ids it absorbed are the rows to
 * delete. `rows` must already be in calendar order.
 *
 * A row with a HAND-SET duration is never joined to anything, in either direction:
 * merging is what would quietly hand those hours back and undo the gesture. The two
 * halves of one hand-set stretch around lunch are already one row each by the time
 * they get here, since `mergeTouchingSegments` settled them inside the item.
 *
 * A hand-placed row cannot reach this function at all — it is not in the pool — but the
 * guard is stated anyway, because the merged row keeps ONE row's flags and silently
 * spreading or dropping that mark is exactly the class of bug this file is careful about.
 */
function mergeTouchingRows(rows: PlacedBlock[], deletedBlockIds: string[]): PlacedBlock[] {
  const merged: PlacedBlock[] = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      !last.manualDuration &&
      !row.manualDuration &&
      !last.handPlaced &&
      !row.handPlaced &&
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
// CLAUDE.md's engine rules cover two things: WHERE hours sit (everything above)
// and HOW MANY hours each row carries (everything below). The two are separate
// passes on purpose. These functions only move hours between the rows of ONE job;
// they never place anything. The caller applies one of them, then hands the
// result to `compose` in the same transaction:
//
//     const edit = resizeBlock(blocks, { blockId, durationMinutes, today });
//     if (!edit.ok) return edit.error;                  // nothing written
//     const placement = compose({ ...input, blocks: edit.blocks });
//
// `totalMinutesDelta` is what the caller must add to `projects.total_hours` to
// keep the invariant `SUM(blocks.duration) == projects.total_hours` true. It is
// zero for every pure transfer.

export type EditErrorCode =
  | 'unknown-block'
  | 'invalid-duration'
  | 'shrink-last-block'
  | 'transfer-exceeds-job'
  | 'reduction-exceeds-job'
  | 'receiver-cannot-hold-hours';

/** i18n keys for the edit failures. Translations live in public/locales. */
export const EDIT_MESSAGE_KEYS: Record<EditErrorCode, string> = {
  'unknown-block': 'errors.unknownBlock',
  'invalid-duration': 'errors.invalidDuration',
  'shrink-last-block': 'errors.shrinkLastBlock',
  'transfer-exceeds-job': 'errors.transferExceedsJob',
  'reduction-exceeds-job': 'errors.reductionExceedsJob',
  'receiver-cannot-hold-hours': 'errors.receiverCannotHoldHours',
};

export interface EditError {
  code: EditErrorCode;
  /** i18n key, never a translated sentence. */
  messageKey: string;
  blockId?: string;
  projectId?: string;
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
   * Locked rows the transfer had to touch because the job had no unlocked hours
   * left. "A locked block is never grown or shrunk silently" — so it is reported
   * here and the UI is expected to say so rather than swallow it.
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
 * Rule "Job Editing: Adding/Removing Hours (LIFO)".
 *
 * Adding appends to the job's LAST block; removing decrements from it, deleting
 * any row that reaches zero and carrying on into the row before it. Per the
 * implementer default in CLAUDE.md the engine works on the last UNLOCKED block,
 * and when the job has none it creates one ranked immediately after the job's
 * last row — a locked row is only ever touched as a last resort, and reported.
 */
export function changeProjectMinutes(blocks: readonly Block[], change: HoursChange): EditResult {
  const delta = Math.round(change.deltaMinutes);
  const draft = blocks.map(cloneBlock);
  if (delta === 0) return settledEdit(draft, [], 0, []);

  const own = sortedByQueueRank(draft.filter((block) => block.projectId === change.projectId));

  if (delta > 0) {
    const target = lastAutomatic(own, change.today);
    if (target !== undefined) {
      setDuration(target, target.durationMinutes + delta);
      return settledEdit(draft, [], delta, []);
    }
    // Every row of the job is outside the pool — locked, hand-placed, on a weekend or in
    // the frozen past — or it has none at all: give the hours a row of their own rather
    // than growing one the reflow cannot settle afterwards. `compose` places it.
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
   * The new NET WORKING MINUTES of the stretch that begins at that row's start.
   *
   * Net, so the lunch break contributes nothing: a row starting at 10:00 dragged to 17:30
   * is 6 h — `10:00-14:00` plus `15:30-17:30` — and never 7.5 h. The stretch, because the
   * row may already continue after the break; see `stretchFrom`.
   */
  durationMinutes: number;
  /**
   * Local `YYYY-MM-DD`. Needed for the same reason `HoursChange` needs it: the row the
   * freed hours are handed to must be one the reflow can settle, and "is this row in the
   * movable pool" is not answerable without today. Not having it here is what let the
   * frozen past absorb growth — see `lastAutomatic`.
   */
  today: string;
  /**
   * The day the row sits on, in BOTH views. A resize is a hand action, so it is measured
   * and cut over `manualWindows` — the margins included — while `periods` is what says
   * whether the result has left auto-fill's reach and must therefore be pinned.
   */
  day: DayWindows;
  /**
   * Any other day, for the one row of a transfer that need not be on the target's: the
   * COUNTERPARTY the freed hours are handed to, which may sit on a Saturday or in the past.
   * Defaults to `day`, which is right for every shape the settings can produce today (the
   * period times are global), and is here so a future per-day shift cannot make the receiver
   * be laid out against the wrong window.
   */
  dayOf?: (date: string) => DayWindows;
  /** An id per extra row the stretch needs once it is cut at the lunch break. */
  newBlockId: () => string;
  /** `created_at` / `updated_at` for a row the segmentation has to create. */
  now: string;
}

/**
 * Rule "Block Resize (drag the bottom edge)" — a transfer inside the job, with
 * the job's last block as the counterparty:
 *
 * | Action                        | Effect                                   | total |
 * |-------------------------------|------------------------------------------|-------|
 * | enlarge a block, not the last | take the hours off the last block (LIFO) | same  |
 * | shrink a block, not the last  | give the hours to the last block         | same  |
 * | enlarge the last block        | nothing farther to draw from             | grows |
 * | shrink the last block         | refused — the blocks would undershoot    | same  |
 *
 * This is how "yesterday took longer than I noted" is recorded: yesterday is
 * frozen, so enlarging its row keeps the new duration and the hours come off the
 * job's furthest future row, leaving the estimate intact.
 *
 * THE ROW IS MARKED `manualDuration` on every success, including a resize to the
 * length it already had. Without the mark the transfer above is undone on the very
 * next recomposition — `compose` re-derives the job's segmentation from its total —
 * which is what made the gesture a silent no-op on an unlocked weekday row. With
 * it, the length survives, the job's run ends at that row, and the day it freed goes
 * to the jobs behind it. Marking a no-delta resize too keeps the gesture total: the
 * same request twice leaves the same state, and dropping the edge where it already
 * was is still the owner saying "this row is this long".
 *
 * IT SIZES A STRETCH, NOT A RECTANGLE (2026-08-13). `durationMinutes` is NET working
 * minutes counted from the row's start over the day's MANUAL WINDOWS, so the gesture
 * crosses the lunch break: the owner's own example — a row starting at 10:00 dragged to
 * 17:30 — is 6 h, stored as `10:00-14:00` plus `15:30-17:30`, never 7.5 h. Two
 * consequences, and both are what make the gesture reversible:
 *
 * - the result is stored in SEGMENTS by `segmentDroppedRow`, the same splitter a drop
 *   uses, so no stored row can straddle the break whatever the drag did;
 * - the row's own continuation is part of what is being sized (`stretchFrom`). Sizing the
 *   target alone would hand the freed hours to the continuation sitting right below it
 *   and the next pass would read the pair back as the SAME stretch — a resize that
 *   answered 200 and changed nothing, which is precisely the defect `manualDuration` was
 *   introduced to kill.
 *
 * A RESIZE THAT REACHES INTO MANUAL-ONLY TIME PINS THE ROW (`handPlaced`). The margins
 * are hand time: they do not exist in the engine's index space, so a row the reflow still
 * owns would be pulled back inside the periods — or thrown onto the next day when the
 * hours no longer fit there — and the owner's drag would visibly do nothing. Pinning is
 * only applied where the engine would otherwise have undone it (`isMovable`), it is the
 * same mark a drop onto the buffer earns, and *back to automatic* releases it.
 */
export function resizeBlock(blocks: readonly Block[], resize: BlockResize): EditResult {
  const draft = blocks.map(cloneBlock);
  const target = draft.find((block) => block.id === resize.blockId);
  if (target === undefined) return failedEdit('unknown-block', { blockId: resize.blockId });

  const next = Math.round(resize.durationMinutes);
  if (!Number.isFinite(next) || next <= 0) {
    return failedEdit('invalid-duration', { blockId: resize.blockId, projectId: target.projectId });
  }

  // The rows the stretch will be stored as, decided from the row's own start and the net
  // minutes asked for — before anything is absorbed, because the absorption depends on
  // where these reach and not the other way round.
  const segments = segmentDroppedRow(resize.day.manualWindows, {
    startMinutes: target.startMinutes,
    durationMinutes: next,
  });
  const lastSegment = segments[segments.length - 1];
  const reachMinutes = lastSegment.startMinutes + lastSegment.durationMinutes;

  const own = sortedByQueueRank(draft.filter((block) => block.projectId === target.projectId));
  const stretch = stretchFrom(own, target, resize.day.manualWindows, reachMinutes);
  const stretchMinutes = stretch.reduce((total, row) => total + row.durationMinutes, 0);
  const delta = next - stretchMinutes;
  const counterparties = own.filter((row) => !stretch.includes(row));
  const isLast = counterparties.length === 0 || stretch.includes(own[own.length - 1]);

  // Refusals first, so a rejected resize marks nothing: the blocks would end up
  // summing to less than the job's total, and the job form is where hours are
  // removed.
  if (delta < 0 && isLast) {
    return failedEdit('shrink-last-block', { blockId: target.id, projectId: target.projectId });
  }

  const deletedBlockIds: string[] = [];
  let totalMinutesDelta = 0;
  let touchedLockedBlockIds: string[] = [];

  if (delta > 0 && isLast) {
    // Enlarging the last (or only) block: nothing farther to draw from, so the
    // estimate grows.
    totalMinutesDelta = delta;
  } else if (delta > 0) {
    const taken = takeMinutes(counterparties, delta);
    if (!taken.ok) {
      return failedEdit('transfer-exceeds-job', { blockId: target.id, projectId: target.projectId });
    }
    deletedBlockIds.push(...taken.deletedBlockIds);
    touchedLockedBlockIds = taken.touchedLockedBlockIds;
  } else if (delta < 0) {
    // Shrinking a block that is not the last hands its hours to the last one — the last
    // one the ENGINE lays out, for the reason in `lastAutomatic`. The fallback is the
    // difference from the job form's LIFO: a transfer has no row to create, so when the
    // job has nothing in the pool at all the hours still have to land somewhere. Whether
    // that case should instead be refused is an Open Decision in CLAUDE.md ("a resize
    // that overlaps another job in the frozen past"), so it is left exactly as it was.
    const receiver = lastAutomatic(counterparties, resize.today) ?? counterparties[counterparties.length - 1];
    const grown = receiver.durationMinutes + -delta;

    if (isMovable(receiver, resize.today)) {
      // The reflow will settle these hours: hand it the number and nothing else.
      setDuration(receiver, grown);
    } else {
      // THE RECEIVER IS OUTSIDE THE POOL — locked, hand-placed, on a weekend, in the frozen
      // past. Nothing will ever re-lay it out, so a raw `duration` is written straight onto
      // the clock and stays there: a 1 h Saturday row handed 4 h became `12:00-17:00`,
      // holding minutes on both sides of the lunch break, and a 15:30 one became
      // `15:30-21:30`, an hour past the end of the day. Both are permanent by construction.
      // So the hours are laid out HERE, by the same splitter the target's own segments go
      // through, and refused when the day cannot hold them.
      if (!layOutFixedRow(draft, receiver, grown, resize)) {
        return failedEdit('receiver-cannot-hold-hours', {
          blockId: receiver.id,
          projectId: receiver.projectId,
        });
      }
    }
    touchedLockedBlockIds = receiver.locked ? [receiver.id] : [];
  }

  // A LOCKED ROW THE STRETCH REWRITES IS NAMED. `stretchFrom` takes in a continuation
  // whatever its marks, so growing the morning half of a unit lengthens a locked afternoon
  // half — which is exactly what "a locked block is never grown silently" and
  // `BlockMutation.touchedLockedBlockIds` ("Never silent") forbid doing quietly. Whether it
  // should be excluded from the stretch altogether is a decision, and is the owner's; being
  // told is not.
  for (const row of stretch.slice(1)) {
    if (row.locked && !touchedLockedBlockIds.includes(row.id)) touchedLockedBlockIds.push(row.id);
  }

  // The stretch is written over its rows in order: one row for a length that stays inside
  // its window, two once it crosses the break.
  const pin = usesManualOnlyTime(resize.day.periods, segments) && isMovable(target, resize.today);

  segments.forEach((segment, index) => {
    const row = stretch[index];
    if (row === undefined) {
      // The stretch grew a segment: a new row of the same job, on the same day, carrying
      // the same marks — a half-marked stretch would come apart on the next pass.
      draft.push({
        ...target,
        id: resize.newBlockId(),
        startMinutes: segment.startMinutes,
        durationMinutes: segment.durationMinutes,
        manualDuration: true,
        handPlaced: target.handPlaced || pin,
        createdAt: resize.now,
        updatedAt: resize.now,
      });
      return;
    }
    row.startMinutes = segment.startMinutes;
    pinDuration(row, segment.durationMinutes);
    if (pin) row.handPlaced = true;
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

/**
 * Writes `minutes` onto a row THE ENGINE WILL NEVER RE-LAY OUT, in segments, or reports that
 * the day cannot hold them.
 *
 * The counterparty of a shrink is normally the job's last row in the movable pool, and then
 * the reflow settles it. When the job has none — every row locked, hand-placed, on a weekend
 * or in the frozen past — the hours land on a row that keeps whatever geometry is written
 * here, for ever. A raw duration is therefore not enough: it produced a row holding minutes
 * on both sides of the lunch break, and one running past the end of the day, in six
 * configurations. Both shapes are invariants 2 and 3.
 *
 * So the same splitter every hand gesture uses cuts the new length at the break, and a
 * result the day cannot hold is refused rather than stored — the row is immovable, so there
 * is nowhere else for the hours to go and nothing later will tidy them.
 */
function layOutFixedRow(
  draft: Block[],
  row: Block,
  minutes: number,
  resize: BlockResize,
): boolean {
  const windows = (resize.dayOf ?? (() => resize.day))(row.date).manualWindows;
  const segments = segmentDroppedRow(windows, {
    startMinutes: row.startMinutes,
    durationMinutes: minutes,
  });
  const last = segments[segments.length - 1];
  if (last.startMinutes + last.durationMinutes > dayEndMinutes(windows)) return false;

  setDuration(row, segments[0].durationMinutes);
  for (const segment of segments.slice(1)) {
    draft.push({
      ...row,
      id: resize.newBlockId(),
      startMinutes: segment.startMinutes,
      durationMinutes: segment.durationMinutes,
      // The row's own marks travel with it: half a fixed stretch left in the pool would be
      // moved out from under the other half on the next pass.
      manualDuration: false,
      createdAt: resize.now,
      updatedAt: resize.now,
    });
  }
  return true;
}

/**
 * The rows a bottom-edge drag rewrites: the row it was dragged on, plus the rows of its OWN
 * job that continue it on the same day AND CANNOT SURVIVE THE RESIZE ON THEIR OWN. There
 * are exactly two of those, and the distinction is the whole subtlety of the gesture:
 *
 * - A ROW THE QUEUE WOULD READ BACK AS PART OF THIS STRETCH — one that is already hand-set.
 *   After the resize the target is hand-set too, and `buildQueue` joins consecutive
 *   hand-set rows of one job on one day into a single item; so sizing the target alone
 *   would hand the freed hours to the row directly below it, the next pass would read the
 *   pair back as the same stretch, and the resize would answer 200 having changed nothing.
 *   That is the class of defect `manualDuration` exists to kill, so this must not
 *   reintroduce it. Shrinking a 6 h stretch cut at lunch back into the morning is this case.
 * - A ROW THE NEW SEGMENTS LAND ON (`reachMinutes`). Growing the morning half of a unit
 *   past the break puts a segment exactly where the afternoon half sits; absorbing it
 *   reuses that row instead of stacking a second one on top of it.
 *
 * AN AUTOMATIC ROW THE STRETCH DOES NOT REACH IS DELIBERATELY LEFT ALONE, and it is what
 * makes CLAUDE.md's own worked example work: shrinking the Wednesday MORNING row of an
 * automatic 10 h unit to 2 h must leave the job's remaining hours to the ENGINE, which
 * moves them to the next auto-fill day and lets the jobs behind take the freed space.
 * Absorbing them instead would read the gesture as "this job now has 2 h", and a job with
 * nothing behind it would answer `shrink-last-block` to a perfectly ordinary drag.
 *
 * `adjacentInWindows` is the same predicate the grid groups a unit with, so a unit on
 * screen and a stretch here can never disagree about where one ends. Only rows AFTER the
 * target are taken: the gesture is anchored at the edge the owner grabbed, so dragging the
 * afternoon half's edge sizes the afternoon half and leaves the morning alone.
 */
function stretchFrom(
  own: readonly Block[],
  target: Block,
  manualWindows: readonly WorkPeriod[],
  reachMinutes: number,
): Block[] {
  const stretch = [target];
  let endMinutes = target.startMinutes + target.durationMinutes;

  for (const row of own.slice(own.indexOf(target) + 1)) {
    if (row.date !== target.date) break;
    if (!adjacentInWindows(manualWindows, endMinutes, row.startMinutes)) break;
    if (!row.manualDuration && row.startMinutes >= reachMinutes) break;
    stretch.push(row);
    endMinutes = row.startMinutes + row.durationMinutes;
  }

  return stretch;
}

/**
 * "Back to automatic": gives the engine back BOTH marks a hand gesture can leave on a
 * row — the length the bottom-edge drag set (`manualDuration`) and the day a drop
 * pinned it to (`handPlaced`). The next recomposition re-derives the job's segmentation
 * from its total and, if the row was pinned, brings it back into the pool.
 *
 * One action for both because they fail the same way: neither is visible in the
 * calendar's geometry — the row simply stops obeying the engine — so a calendar that
 * has quietly accumulated them is one the engine no longer manages. Releasing has to be
 * as easy as setting, and a second button for the second mark would mean an owner who
 * pressed the wrong one still had a row that would not move.
 *
 * It gives back the LENGTH and the DAY. It does not give back the queue POSITION: that
 * is whatever the calendar now says, exactly as after any drag.
 */
export function releaseBlock(blocks: readonly Block[], blockId: string): EditResult {
  const draft = blocks.map(cloneBlock);
  const target = draft.find((block) => block.id === blockId);
  if (target === undefined) return failedEdit('unknown-block', { blockId });
  target.manualDuration = false;
  target.handPlaced = false;
  return settledEdit(draft, [], 0, []);
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
  reason: 'locked' | 'hand-placed' | 'past' | 'weekend';
}

/**
 * The implementer default for "creating a gap on top of existing work": unlocked
 * weekday work is simply pushed forward by the recomposition, so the only real
 * conflicts are the blocks the engine may not move. The caller refuses the save
 * and names them instead of writing an overlap — gaps and blocks are one
 * occupancy set, and `compose` cannot repair an overlap it is forbidden to touch.
 *
 * Pass the gap being saved (its own id excluded from `blocks`, since a gap is not
 * a block); an empty array means the save is safe.
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
      // The reason is what the sentence names, so it is the block's OWN state first —
      // a hand-placed row on a weekday is neither past nor weekend, and telling the
      // owner it is would send them looking for something that is not there.
      reason: block.locked
        ? 'locked'
        : isWeekend(block.date)
          ? 'weekend'
          : compareDates(block.date, today) < 0
            ? 'past'
            : 'hand-placed',
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Manual placement — the overlap a drop creates
// ---------------------------------------------------------------------------
//
// A drop that lands ON somebody else's row is a statement about ORDER: "this goes
// here, and what was here carries on afterwards". Two very different mechanisms are
// needed to honour it, because the reflow reaches some rows and not others.
//
// `compose` cannot repair every overlap, and that is deliberate. Rows OUTSIDE the
// movable pool (locked, past, weekend) come back exactly as they went in, so two of
// them can sit on top of each other for ever: noticing would mean rewriting a
// placement the engine did not make, which is the one thing rule 6 forbids.
//
// A hand drop is what creates such an overlap. Drop 2 h on a Saturday that already
// holds a row of the same job and BOTH rows are outside the pool the instant they
// are written — verified: the two rows overlapped by an hour, the hours invariant
// held, and the grid drew them as two side-by-side lanes with no warning.
//
// Two rules, decided with the owner:
//
//  - SAME JOB    -> one row, `start = min(starts)` and `duration = SUM(durations)`.
//                   Sat 09:00-11:00 plus a 2 h drop at 10:00 is 09:00-13:00, 4 h.
//                   NOT the interval union (09:00-12:00) — that would quietly eat
//                   an hour of the owner's work.
//  - OTHER JOB   -> cut the row the drop lands in and push its tail after the drop.
//                   A 09:00-11:00 with B dropped at 10:00-11:00 becomes
//                   A 09:00-10:00, B 10:00-11:00, A 11:00-12:00. A keeps its 2 h.
//                   "If the user does not want it, they move it again."
//
// THIS IS NOT RULE 12's AUTO-MERGE, and the two must stay apart. `mergeTouchingRows`
// joins rows of one job that TOUCH inside one period on one day, and it never runs
// on the weekend or the past, because tidying those would undo a human decision.
// What follows resolves an OVERLAP a human just created, on any day including the
// weekend, and only around the row that was dropped. Collapsing the two mechanisms
// would reintroduce exactly the weekend tidying the engine avoids.
//
// A LOCKED row is never cut, grown or absorbed: "a locked block is never grown or
// shrunk silently", so a drop that lands on one is refused with the row named — the
// same answer `findGapConflicts` gives a gap over a lock. A merge is refused even
// when the LOCK IS THE DROP'S OWN, because it would move the lock's start; a cut is
// not, because the lock keeps the exact slot the owner dropped it into and only the
// other job moves.
//
// A MOVABLE DROP ONTO A MOVABLE ROW IS CUT TOO, and it needs far less machinery
// (decided with the owner, 2026-08-12). The reflow settles both rows, so nothing has
// to be placed here — but it settles them IN QUEUE ORDER, and queue order is
// `date, start_time`. Without the cut, dropping B at 10:00 into A's 08:00-14:00 row
// leaves the queue reading `A, B`, so A is laid out whole and B lands after the
// entire block: the drop is silently ignored. Cutting A at the drop's start makes
// the queue read `A, B, A`, and the forward fill then produces `A, B, A` on the clock
// by itself. So on this side the resolution writes RANKS, not placements:
//
//  - only a row that STARTS BEFORE the drop is cut. One starting at or after it
//    already ranks behind the drop, so the reflow needs no help;
//  - the tail is one row ranked just after the drop's end. It is a queue rank, not a
//    position — `compose` re-places it, exactly as it does the provisional row every
//    drop and every new job is written as;
//  - fixed rows are ignored on this side, because the reflow flows around them.
//
// Same resolver, same two rules, one branch on whether the reflow can reach the rows.

export type ManualPlacementErrorCode =
  | 'unknown-block'
  | 'overlaps-locked-block'
  | 'overlaps-gap'
  | 'merge-exceeds-day'
  | 'displaced-hours-unplaceable';

/** i18n keys for the refusals. Translations live in public/locales. */
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
   * The id the dropped hours ended up on. It is the id that was passed in, EXCEPT
   * after a merge, where the earlier row survives and the dropped row's id is in
   * `mergedBlockIds`. Resolving the same drop again is a no-op — that is the
   * property that says no overlap was left behind.
   */
  placedBlockId: string;
  /**
   * Rows of the SAME job the dropped row absorbed. They are gone from `blocks`, so
   * the caller must DELETE them; the id of the surviving row is the earlier one, so
   * a merge is an UPDATE plus a DELETE rather than two writes and an INSERT.
   */
  mergedBlockIds: string[];
  /**
   * Jobs whose row was cut in two so the dropped row could keep the slot. Their
   * totals are untouched — the tail carries exactly the hours the head lost — but
   * the owner is told, because a displaced job is a decision they may want to undo.
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
 * Resolves the overlap a hand drop created, leaving a calendar `compose` can take.
 *
 * Which half runs depends on whether the reflow can reach the rows:
 *
 * - the dropped row is OUTSIDE the movable pool (weekend, frozen past, locked): the
 *   overlap is permanent unless it is resolved here, so rows of the same job are
 *   merged and rows of another job are cut and their tails PLACED;
 * - the dropped row is inside it: the reflow settles everything, so all that is
 *   needed is for the queue to read `A, B, A` — the overlapped rows of other jobs
 *   are cut and their tails given a rank behind the drop, and nothing is placed.
 *
 * BOTH halves then store the drop in SEGMENTS (`segmentDroppedRow`). A hand drop is the
 * one placement that does not go through `toClockSegments`, and it was therefore the
 * one way to get a stored row holding minutes on both sides of the lunch break — a 6 h
 * drop at 10:00 was saved as a single 10:00 + 360 min row running through 14:00-15:30.
 * `duration` is NET WORKING TIME, so that row was a lie about the day, and the grid, the
 * overlap arithmetic and auto-merge all read a row as one solid rectangle.
 *
 * Every branch conserves hours, so `SUM(blocks.duration) == projects.total_hours`
 * holds for every touched project by construction rather than by inspection.
 */
export function resolveManualPlacement(
  input: ComposeInput,
  placement: ManualPlacement,
): ManualPlacementResult {
  const draft = input.blocks.map(cloneBlock);
  let placed = draft.find((block) => block.id === placement.blockId);
  if (placed === undefined) {
    return manualFailure('unknown-block', { blockId: placement.blockId });
  }

  const reflowed = isMovable(placed, input.today);
  // A drop is a HAND action, so it is cut over the day's MANUAL WINDOWS: the margins are
  // time the owner may use, and a drop that starts in one runs on into the period below it
  // without any boundary between them. The lunch break is still the only cut, because that
  // is the only hole a manual window leaves — see src/lib/manualWindow.ts.
  const periods = input.getDayConfig(placed.date).manualWindows;
  /** Ids the merge freed. Reused by the segmentation below before any id is minted. */
  const absorbedIds: string[] = [];
  const displacedProjectIds: string[] = [];

  // 1. Same job: fold every overlapping row into one. Re-checked after each fold
  //    because the survivor is longer than either row was, so it can reach a row
  //    neither of them touched.
  //
  //    Only where the reflow will not separate them. Two movable rows of one job
  //    are already going to be laid out contiguously and auto-merged by rule 12, so
  //    folding them here would be tidying rather than repairing.
  while (!reflowed) {
    const other = sameJobOverlaps(draft, placed, segmentDroppedRow(periods, placed), input.today)[0];
    if (other === undefined) break;
    if (other.locked || placed.locked) {
      return manualFailure('overlaps-locked-block', other.locked ? other : placed);
    }

    // SUM, NOT UNION. `min(start) + (a + b)` keeps every hour; the union of the two
    // intervals would silently drop the hour they share. The sum is then laid out by
    // the segmentation below, so a merge that ends up crossing the lunch break comes
    // back as two rows of one job rather than one row that lies about the day.
    const startMinutes = Math.min(other.startMinutes, placed.startMinutes);
    const durationMinutes = other.durationMinutes + placed.durationMinutes;
    if (clockEndOf(periods, startMinutes, durationMinutes) > dayEndMinutes(periods)) {
      // There is nowhere to put the rest: the merged row is one job's hours on ONE day, and
      // the day has an end. Drawn at midnight instead, this let the same drop repeated three
      // times compound into `Sat 13:00-23:00, 10 h` — straight through the lunch band and
      // 2.5 h past the end of the day, with hours conserved so nothing warned the owner.
      return manualFailure('merge-exceeds-day', placed);
    }

    // The earlier row survives, so the write is an UPDATE rather than a DELETE and
    // an INSERT — the same convention as rule 12's `mergeTouchingRows`.
    const [survivor, absorbed] = sortedByQueueRank([other, placed]);
    survivor.startMinutes = startMinutes;
    setDuration(survivor, durationMinutes);
    // The hours a human just dropped keep saying so, whichever row survives.
    survivor.handPlaced = survivor.handPlaced || absorbed.handPlaced;
    draft.splice(draft.indexOf(absorbed), 1);
    absorbedIds.push(absorbed.id);
    placed = survivor;
  }

  // 2. The drop is stored in segments, cut at the break between two working periods.
  //    Done before the cuts below so the rows it lands across are measured against the
  //    time it REALLY occupies: 6 h dropped at 10:00 runs to 17:30, not to 16:00.
  const dropRows = segmentDroppedRow(periods, placed);
  placed.durationMinutes = dropRows[0].durationMinutes;
  for (const extra of dropRows.slice(1)) {
    draft.push({
      ...placed,
      // An id the merge freed rather than a new one, so a merge that segments is two
      // UPDATEs instead of a DELETE and an INSERT.
      id: absorbedIds.shift() ?? placement.newBlockId(),
      startMinutes: extra.startMinutes,
      durationMinutes: extra.durationMinutes,
      createdAt: placement.now,
      updatedAt: placement.now,
    });
  }

  // 3. A GAP the drop lands on, where the reflow will not separate them: refused, naming it.
  //    Gaps and blocks are ONE occupancy set (CLAUDE.md: gaps "are time: they consume the
  //    day's plannable hours exactly like locked work does"), and the mirror gesture — a gap
  //    over a hand-placed row — is already a 409, so the precedent fixes the answer. Only on
  //    the fixed side: on Mon-Thu the reflow keeps auto work off a gap by itself, which is
  //    why this only ever bit where the drop PINS — the buffer, the weekend, a margin, the
  //    lunch band, which is exactly where the owner parks work by hand.
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

  // 4. Another job: cut every row the drop lands in, then re-lay their tails after
  //    it, in the order they were cut. Two passes rather than one, so the space the
  //    cuts free up is available to all of them: cutting and pushing one row at a
  //    time would make the first tail hop over a row the second cut was about to
  //    remove, and the jobs would come out interleaved on the clock.
  const victims = otherJobOverlaps(draft, placed, dropRows, input.today, reflowed);
  const locked = victims.find((victim) => victim.locked);
  if (locked !== undefined) return manualFailure('overlaps-locked-block', locked);

  const tails: Array<{ victim: Block; minutes: number; spareIds: string[] }> = [];
  for (const victim of victims) {
    const headMinutes = Math.max(0, placed.startMinutes - victim.startMinutes);
    const minutes = victim.durationMinutes - headMinutes;
    const spareIds: string[] = [];
    if (headMinutes > 0) {
      setDuration(victim, headMinutes);
    } else {
      // The drop covers the row from its very start: nothing is left in front, so
      // the row's id is free for the first row of its tail. (A movable victim never
      // gets here — one that does not start before the drop already ranks after it.)
      draft.splice(draft.indexOf(victim), 1);
      spareIds.push(victim.id);
    }
    tails.push({ victim, minutes, spareIds });
  }

  const lastRow = dropRows[dropRows.length - 1];
  const afterClock = lastRow.startMinutes + lastRow.durationMinutes;
  for (const tail of tails) {
    // A rank behind the drop is all a reflowed tail needs; a fixed one has to be
    // given real free time, because nothing will move it afterwards.
    const pushed = reflowed
      ? [{ date: tail.victim.date, startMinutes: Math.min(afterClock, MAX_RANK_MINUTES), durationMinutes: tail.minutes }]
      : pushDisplacedMinutes(input, draft, { date: tail.victim.date, afterClock, minutes: tail.minutes });
    if (pushed === null) return manualFailure('displaced-hours-unplaceable', tail.victim);

    for (const segment of pushed) {
      draft.push({
        id: tail.spareIds.pop() ?? placement.newBlockId(),
        projectId: tail.victim.projectId,
        date: segment.date,
        startMinutes: segment.startMinutes,
        durationMinutes: segment.durationMinutes,
        // Never locked: a locked victim was refused above, so there is no lock here
        // to inherit, and a tail the engine just placed must stay in the pool.
        locked: false,
        // These hours were cut out of another row, not drawn by hand.
        manualDuration: false,
        // The hours a human pinned to a day stay pinned to it. What had to LEAVE the
        // day goes back to the engine, since nobody chose the day it landed on.
        handPlaced: tail.victim.handPlaced && segment.date === tail.victim.date,
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
 * True when `row` shares clock minutes with any part of the drop's footprint.
 *
 * The footprint is `segmentDroppedRow`'s answer, which lives in src/lib/dropSegments.ts
 * rather than here BECAUSE THE DRAG GHOST NEEDS THE SAME ANSWER: it draws the drop and
 * names what it will do to the row underneath before the mouse is released, and a
 * preview that promises a cut this resolver will not perform is worse than no preview.
 * One implementation, two callers.
 */
function overlapsDrop(row: Block, dropRows: readonly DropSegment[]): boolean {
  return overlapsSegments(dropRows, row.startMinutes, row.durationMinutes);
}

/**
 * Rows of the DROP'S OWN job, in queue order, that overlap it and that `compose`
 * will not repair. Movable rows are ignored on purpose: the reflow lays them out
 * contiguously and rule 12 joins them, so folding one here would be tidying.
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
 * Rows of ANOTHER job the drop lands in and that the drop must therefore cut.
 *
 * `reflowed` picks the side: a fixed drop collides with the other fixed rows, which
 * nothing will ever separate, while a reflowed drop collides with the other movable
 * rows, which the reflow will separate but only in queue order. A reflowed drop
 * ignores fixed rows entirely — flexible work flows around them — and only cuts a row
 * that STARTS BEFORE it, since one starting at or after the drop already ranks behind
 * it and needs no cut.
 *
 * Measured against the drop's SEGMENTS, so a stretch that crosses the lunch break is
 * counted for the time it really occupies on the clock and not for the band it skips.
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
 * One day as MANUAL placement sees it. `buildDayPlan` answers "what may the engine
 * fill here" and says zero for a weekend; this answers "where could these hours
 * physically go", which is the question once a drop has displaced somebody else's
 * row on a day the engine never fills.
 */
interface ManualDayPlan extends ClockRuler {
  workingMinutes: number;
  freeRuns: IndexRange[];
}

function buildManualDayPlan(input: ComposeInput, date: string, blocks: readonly Block[]): ManualDayPlan {
  const config = input.getDayConfig(date);
  const { spans, workingMinutes } = buildPeriodSpans(config.periods);
  if (config.isClosed) return { date, spans, workingMinutes, freeRuns: [] };

  // Every row on the day counts, movable or not: displaced hours must not land on
  // top of what the owner can currently see, and a row that the reflow later moves
  // only ever gave the tail a later place in the queue.
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
 * Places the tail of a cut row: from the drop's end, forward only, in the free
 * working time of the day, then chaining into following days exactly as overflow
 * does. `null` when the hours do not fit before the planning horizon.
 *
 * `toClockSegments` cuts the tail at every period boundary, so neither the head nor
 * the tail ever straddles a non-working interval — pushing 3 h past 13:00 gives
 * 13:00-14:00 and 15:30-17:30, two rows of one job, exactly as auto-fill would.
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
 * The next day displaced hours may use.
 *
 * A weekend tail STAYS ON THE WEEKEND. The engine never moves weekend work, so
 * carrying Saturday's remainder onto Monday would be the engine deciding the shop
 * does not work Saturdays after all — the owner put those hours there.
 *
 * Everything else walks the weekdays, skipping the weekend and the Friday buffer:
 * a row displaced by somebody else's drop is not growth, and the colchón belongs
 * to growth alone (rule 5).
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

/**
 * What the amber strip above the grid states, as numbers only — the wording and
 * the date formatting belong to the UI and its translation files.
 *
 * "Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre".
 */
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

/**
 * CLAUDE.md puts this arithmetic here so one endpoint can serve the strip:
 * "last occupied date across all weeks, hours queued, and whether Friday is
 * still clear". Hours already worked are not queued, so only today onwards counts.
 */
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
 * Takes `minutes` off `ordered` from the far end backwards, unlocked rows first
 * and locked ones only when the job has nothing else left. Mutates the rows it is
 * given, which are `draft` members; a row reaching zero is reported for deletion.
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
      setDuration(block, block.durationMinutes - take);
      remaining -= take;
      if (lockedPass) touchedLockedBlockIds.push(block.id);
      if (block.durationMinutes === 0) deletedBlockIds.push(block.id);
    }
  }

  return { ok: remaining === 0, deletedBlockIds, touchedLockedBlockIds };
}

/**
 * Writes a row's new length and DROPS any hand-set mark on it.
 *
 * The mark stands for one specific number the owner drew. Once anything else has
 * rewritten that number — the LIFO transfer from the job form, being the
 * counterparty of another row's resize, a drop that cut the row in two — the mark
 * would claim an intent that is no longer on the row, and the owner would be left
 * with a block the engine had stopped managing for no visible reason. So exactly one
 * gesture sets it (`resizeBlock`, on its own target) and everything else clears it.
 */
function setDuration(block: Block, durationMinutes: number): void {
  block.durationMinutes = durationMinutes;
  block.manualDuration = false;
}

/** The one place the hand-set mark is set: the row the owner just sized. */
function pinDuration(block: Block, durationMinutes: number): void {
  block.durationMinutes = durationMinutes;
  block.manualDuration = true;
}

/**
 * The job's last row THE ENGINE STILL LAYS OUT — the counterparty every transfer that
 * ADDS hours uses.
 *
 * IT IS THE MOVABLE POOL, `isMovable`, and nothing narrower. Hours added to a row the
 * reflow cannot touch are written straight onto the clock, where they can run over the
 * day's other work, through the lunch break, or past the end of the day with nothing to
 * settle them afterwards. "A locked block is never grown or shrunk silently" therefore
 * covers every row outside the pool: locked, hand-placed, on a weekend, AND in the
 * frozen past. The added hours get a row of their own instead (`createdRowAfter`), which
 * `compose` then places properly.
 *
 * This used to test the two stored MARKS (`locked`, `handPlaced`) only, which read like
 * the whole rule because a hand drop onto Sat/Sun always sets `handPlaced` — so the
 * weekend was covered in practice and only the past was reachable. It was the worst
 * defect in the app and needed no unusual gesture at all: a past Mon-Thu row is never
 * marked (its day role is `auto`), and a row on TODAY becomes a past row overnight. A
 * 2 h job on yesterday raised to 6 h was stored as `12:00 + 360 min`, one row straight
 * through the lunch break claiming 6 h where the clock holds 4.5 h; raised to 13 h it
 * became `12:00-25:00` and took the whole calendar page down from `useFormat().time`.
 *
 * Taking hours AWAY is not symmetrical and is left alone: shrinking a fixed row frees
 * space rather than claiming it, and LIFO has to be able to reach the job's hours
 * wherever they are — see `takeMinutes`.
 */
function lastAutomatic(ordered: readonly Block[], today: string): Block | undefined {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (isMovable(ordered[index], today)) return ordered[index];
  }
  return undefined;
}

/**
 * A row for hours that have nowhere to go, ranked immediately after `anchor` (or
 * after the whole queue when the job has no rows yet). Its date is pulled forward
 * into the movable pool, because a row parked on a weekend or in the past would
 * be an obstacle the engine could never place.
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
    locked: false,
    // Hours the engine invented: neither a length the owner drew nor a day they chose.
    manualDuration: false,
    handPlaced: false,
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

function failedEdit(code: EditErrorCode, about: { blockId?: string; projectId?: string }): EditFailure {
  return { ok: false, error: { code, messageKey: EDIT_MESSAGE_KEYS[code], ...about } };
}
