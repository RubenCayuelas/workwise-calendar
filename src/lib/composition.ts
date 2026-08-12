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

/** One day as the engine reads it: `getDayConfig(date)` is its only source. */
export interface DayConfig {
  /** Working periods, chronological and non-overlapping (morning, afternoon). */
  periods: readonly WorkPeriod[];
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
   * The dates this item's rows already sit on. Only consulted for the Friday
   * buffer, where it is what keeps an unrelated save from pushing absorbed
   * overflow off Friday and into next week.
   */
  originalDates: string[];
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
      originalDates: [block.date],
    };
    openDate = block.date;
    items.push(open);
  }

  return items;
}

// ---------------------------------------------------------------------------
// Predicates and arithmetic
// ---------------------------------------------------------------------------

/**
 * The movable pool. A block is moved by the engine iff it is unlocked, dated
 * today or later, and not on a Saturday or Sunday. Friday is movable.
 */
export function isMovable(block: Block, today: string): boolean {
  if (block.locked) return false;
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
    });
  }

  const deletedBlockIds: string[] = [];
  const reflowed: PlacedBlock[] = [];

  /** `date|projectId` pairs a hand-set stretch has closed for the rest of the day. */
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
   */
  const targetFor = (item: QueueItem): ItemTarget | null => {
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
      // No single day within the horizon could hold it whole, so this job is
      // longer than a day: it fills complete days from where the cursor stands
      // and the remainder continues on the next fillable day.
      let remaining = item.durationMinutes;
      for (let date = cursorDate; remaining > 0 && compareDates(date, horizon) <= 0; date = addDays(date, 1)) {
        const day = date === cursorDate ? cursor : openDay(planFor(date));
        if (!acceptsItem(day.plan, item, closedDays)) continue;
        const taken = takeUpTo(day, remaining);
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
 */
function mergeTouchingRows(rows: PlacedBlock[], deletedBlockIds: string[]): PlacedBlock[] {
  const merged: PlacedBlock[] = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      !last.manualDuration &&
      !row.manualDuration &&
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
//     const edit = resizeBlock(blocks, { blockId, durationMinutes });
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
  | 'reduction-exceeds-job';

/** i18n keys for the edit failures. Translations live in public/locales. */
export const EDIT_MESSAGE_KEYS: Record<EditErrorCode, string> = {
  'unknown-block': 'errors.unknownBlock',
  'invalid-duration': 'errors.invalidDuration',
  'shrink-last-block': 'errors.shrinkLastBlock',
  'transfer-exceeds-job': 'errors.transferExceedsJob',
  'reduction-exceeds-job': 'errors.reductionExceedsJob',
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
    const target = lastUnlocked(own);
    if (target !== undefined) {
      setDuration(target, target.durationMinutes + delta);
      return settledEdit(draft, [], delta, []);
    }
    // Every row of the job is locked (or it has none at all): give the hours a
    // new row of their own rather than growing a lock. `compose` places it.
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
  /** The new net working minutes for that row. */
  durationMinutes: number;
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
 */
export function resizeBlock(blocks: readonly Block[], resize: BlockResize): EditResult {
  const draft = blocks.map(cloneBlock);
  const target = draft.find((block) => block.id === resize.blockId);
  if (target === undefined) return failedEdit('unknown-block', { blockId: resize.blockId });

  const next = Math.round(resize.durationMinutes);
  if (!Number.isFinite(next) || next <= 0) {
    return failedEdit('invalid-duration', { blockId: resize.blockId, projectId: target.projectId });
  }

  const delta = next - target.durationMinutes;
  const own = sortedByQueueRank(draft.filter((block) => block.projectId === target.projectId));
  const counterparties = own.filter((block) => block.id !== target.id);
  const isLast = counterparties.length === 0 || own[own.length - 1].id === target.id;

  // Refusals first, so a rejected resize marks nothing: the blocks would end up
  // summing to less than the job's total, and the job form is where hours are
  // removed.
  if (delta < 0 && isLast) {
    return failedEdit('shrink-last-block', { blockId: target.id, projectId: target.projectId });
  }

  if (delta === 0) {
    pinDuration(target, next);
    return settledEdit(draft, [], 0, []);
  }

  if (isLast) {
    // Enlarging the last (or only) block: nothing farther to draw from, so the
    // estimate grows.
    pinDuration(target, next);
    return settledEdit(draft, [], delta, []);
  }

  if (delta < 0) {
    // Shrinking a block that is not the last hands its hours to the last one.
    const receiver = lastUnlocked(counterparties) ?? counterparties[counterparties.length - 1];
    pinDuration(target, next);
    setDuration(receiver, receiver.durationMinutes + -delta);
    return settledEdit(draft, [], 0, receiver.locked ? [receiver.id] : []);
  }

  const taken = takeMinutes(counterparties, delta);
  if (!taken.ok) {
    return failedEdit('transfer-exceeds-job', { blockId: target.id, projectId: target.projectId });
  }
  pinDuration(target, next);
  return settledEdit(
    draft.filter((block) => block.durationMinutes > 0),
    taken.deletedBlockIds,
    0,
    taken.touchedLockedBlockIds,
  );
}

/**
 * Gives the engine back the row's length: "back to automatic". The next
 * recomposition re-derives the job's segmentation from its total, so the row rejoins
 * whatever run it sits in.
 *
 * It exists because a hand-set length is invisible to the engine's own rules — the
 * row simply stops reflowing — and a calendar whose rows have quietly accumulated
 * hand-set lengths is one the engine no longer manages. Releasing has to be as easy
 * as setting.
 */
export function releaseBlockDuration(blocks: readonly Block[], blockId: string): EditResult {
  const draft = blocks.map(cloneBlock);
  const target = draft.find((block) => block.id === blockId);
  if (target === undefined) return failedEdit('unknown-block', { blockId });
  target.manualDuration = false;
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
  reason: 'locked' | 'past' | 'weekend';
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
      reason: block.locked ? 'locked' : isWeekend(block.date) ? 'weekend' : 'past',
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
  | 'merge-exceeds-day'
  | 'displaced-hours-unplaceable';

/** i18n keys for the refusals. Translations live in public/locales. */
export const MANUAL_PLACEMENT_MESSAGE_KEYS: Record<ManualPlacementErrorCode, string> = {
  'unknown-block': 'errors.unknownBlock',
  'overlaps-locked-block': 'errors.dropOverLockedBlock',
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
  const mergedBlockIds: string[] = [];
  const displacedProjectIds: string[] = [];

  // 1. Same job: fold every overlapping row into one. Re-checked after each fold
  //    because the survivor is longer than either row was, so it can reach a row
  //    neither of them touched.
  //
  //    Only where the reflow will not separate them. Two movable rows of one job
  //    are already going to be laid out contiguously and auto-merged by rule 12, so
  //    folding them here would be tidying rather than repairing.
  while (!reflowed) {
    const other = sameJobOverlaps(draft, placed, input.today)[0];
    if (other === undefined) break;
    if (other.locked || placed.locked) {
      return manualFailure('overlaps-locked-block', other.locked ? other : placed);
    }

    // SUM, NOT UNION. `min(start) + (a + b)` keeps every hour; the union of the two
    // intervals would silently drop the hour they share. The result is ONE row even
    // when it ends up spanning the lunch break, which is the same latitude every hand
    // drop already has on a day the engine does not fill — the alternative would be
    // to re-cut it into segments and answer a merge with two rows again.
    const startMinutes = Math.min(other.startMinutes, placed.startMinutes);
    const durationMinutes = other.durationMinutes + placed.durationMinutes;
    if (startMinutes + durationMinutes > MINUTES_PER_DAY) {
      // A row is a solid rectangle inside ONE day; there is nowhere to put the rest.
      return manualFailure('merge-exceeds-day', placed);
    }

    // The earlier row survives, so the write is an UPDATE rather than a DELETE and
    // an INSERT — the same convention as rule 12's `mergeTouchingRows`.
    const [survivor, absorbed] = sortedByQueueRank([other, placed]);
    survivor.startMinutes = startMinutes;
    setDuration(survivor, durationMinutes);
    draft.splice(draft.indexOf(absorbed), 1);
    mergedBlockIds.push(absorbed.id);
    placed = survivor;
  }

  // 2. Another job: cut every row the drop lands in, then re-lay their tails after
  //    it, in the order they were cut. Two passes rather than one, so the space the
  //    cuts free up is available to all of them: cutting and pushing one row at a
  //    time would make the first tail hop over a row the second cut was about to
  //    remove, and the jobs would come out interleaved on the clock.
  const victims = otherJobOverlaps(draft, placed, input.today, reflowed);
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

  const afterClock = placed.startMinutes + placed.durationMinutes;
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
        createdAt: placement.now,
        updatedAt: placement.now,
      });
    }
    if (!displacedProjectIds.includes(tail.victim.projectId)) {
      displacedProjectIds.push(tail.victim.projectId);
    }
  }

  return { ok: true, blocks: draft, placedBlockId: placed.id, mergedBlockIds, displacedProjectIds };
}

// ---------------------------------------------------------------------------
// Internals — manual placement
// ---------------------------------------------------------------------------

/**
 * Rows of the DROP'S OWN job, in queue order, that overlap it and that `compose`
 * will not repair. Movable rows are ignored on purpose: the reflow lays them out
 * contiguously and rule 12 joins them, so folding one here would be tidying.
 */
function sameJobOverlaps(draft: readonly Block[], placed: Block, today: string): Block[] {
  return sortedByQueueRank(draft).filter(
    (row) =>
      row.id !== placed.id &&
      row.projectId === placed.projectId &&
      row.date === placed.date &&
      !isMovable(row, today) &&
      overlapMinutes(row, placed) > 0,
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
 */
function otherJobOverlaps(
  draft: readonly Block[],
  placed: Block,
  today: string,
  reflowed: boolean,
): Block[] {
  return sortedByQueueRank(draft).filter(
    (row) =>
      row.id !== placed.id &&
      row.projectId !== placed.projectId &&
      row.date === placed.date &&
      isMovable(row, today) === reflowed &&
      overlapMinutes(row, placed) > 0 &&
      (!reflowed || row.startMinutes < placed.startMinutes),
  );
}

/** Minutes two rows share on the clock. Zero when they merely touch. */
function overlapMinutes(a: Block, b: Block): number {
  if (a.date !== b.date) return 0;
  return (
    Math.min(a.startMinutes + a.durationMinutes, b.startMinutes + b.durationMinutes) -
    Math.max(a.startMinutes, b.startMinutes)
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

function lastUnlocked(ordered: readonly Block[]): Block | undefined {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (!ordered[index].locked) return ordered[index];
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
    // Hours the engine invented, not a length the owner drew.
    manualDuration: false,
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
