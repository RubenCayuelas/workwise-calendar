/**
 * Creating a job WITH A START DATE: where its hours are born. The date is a FLOOR — "not
 * before this day" — and it is not stored; the automatic padlock is what survives where a
 * date has to.
 *
 * `planCreation` is one implementation with two callers: the create endpoint writes what it
 * returns and the preview endpoint renders it, so the form cannot promise a placement the
 * save will not perform. Pure — no database, no clock, no user-facing text.
 */

import type { Block, WorkPeriod } from '../types';
import { addDays, compareDates, isWeekend } from './dates';
import {
  changeProjectMinutes,
  compose,
  findGapConflicts,
  horizonEndDate,
  summarizeSchedule,
  type ComposeInput,
  type PlacedBlock,
} from './composition';
import { paintedSegments } from './paintedJob';

/** How many free days the preview offers as alternatives. A dropdown is one click away. */
const MAX_FREE_DATES = 8;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the chosen day IS, in the terms the owner has to be told about. `past` and `weekend`
 * win over `closed` and `buffer`: a closed Saturday is still the weekend, and that is the
 * sentence that helps.
 */
export type StartDateDay = 'auto' | 'buffer' | 'weekend' | 'past' | 'closed';

/**
 * `painted` is a band drawn on the grid: the hours start on an exact MINUTE of the chosen day rather
 * than wherever the engine would put them on it, and the rows that land there are padlocked because
 * nothing else would hold them to that minute.
 */
export type CreationMode = 'queue' | 'forced' | 'born' | 'painted';

export interface StartDateDecision {
  startDate: string;
  day: StartDateDay;
  /** The chosen day is later than the last occupied day. The explanation is built on this. */
  beyondQueue: boolean;
  /** The engine would place an appended job EARLIER: nothing on the calendar holds it. */
  floorBinding: boolean;
  /** Every row created for the job is locked. Mechanical, not a preference. */
  autoLock: boolean;
  /**
   * The rows born ON THE CHOSEN DAY are locked, because it is a day the engine would never
   * have used — the buffer, the weekend. Not the tail on later days: the engine chose those.
   */
  dayLock: boolean;
  /** The Friday buffer and the weekend are honoured only after the owner confirms. */
  needsDayConfirmation: boolean;
  mode: CreationMode;
}

export interface StartDateQuestion {
  startDate: string;
  today: string;
  /** `summarizeSchedule().lastOccupiedDate`: the last day work sits on from today on. */
  lastOccupiedDate: string | null;
  /** The chosen day's role, from `getDayConfig`. */
  role: 'auto' | 'buffer' | 'manual';
  isClosed: boolean;
  /**
   * The day an ORDINARY appended job would start on — `compose`'s own answer, the only honest
   * test of whether the floor binds. `null` when it does not fit at all.
   */
  queueStartDate: string | null;
  /** The owner disagreed with the deferral and asked for that day anyway. */
  force?: boolean;
  /** A band was painted on the grid: the chosen day carries a chosen MINUTE too. */
  painted?: boolean;
}

/**
 * The whole policy, as one pure decision over six facts. Kept separate from the placement so
 * the boundary the owner will actually hit — the chosen day IS the last occupied day,
 * therefore no lock — is a unit test rather than an inference from a calendar.
 */
export function decideStartDate(question: StartDateQuestion): StartDateDecision {
  const { startDate, today, lastOccupiedDate, queueStartDate } = question;
  const isPast = compareDates(startDate, today) < 0;

  const day: StartDateDay = isPast
    ? 'past'
    : isWeekend(startDate)
      ? 'weekend'
      : question.isClosed
        ? 'closed'
        : question.role === 'buffer'
          ? 'buffer'
          : 'auto';

  // With a clear calendar there is no occupied day at all and the engine would start at
  // today.
  const beyondQueue =
    lastOccupiedDate === null
      ? compareDates(startDate, today) > 0
      : compareDates(startDate, lastOccupiedDate) > 0;

  // The floor binds when the engine's own answer for an appended job is EARLIER than the day
  // asked.
  const floorBinding = queueStartDate === null || compareDates(queueStartDate, startDate) < 0;

  // The days the engine will not put a new job on by itself.
  const engineWouldNotPlace =
    day === 'buffer' || day === 'weekend' || day === 'past' || day === 'closed';

  // A day the engine would never choose, so the owner's choice is the only thing holding the rows
  // there — which is what the padlock is for, and what the confirmation asks about. A CLOSED day
  // joined these on 2026-08-20: until then it was absent, so the hours went to the first open day.
  const chosenByHand = day === 'buffer' || day === 'weekend' || day === 'closed';

  const mode: CreationMode =
    question.painted === true
      ? 'painted'
      : engineWouldNotPlace || floorBinding
        ? 'born'
        : question.force === true
          ? 'forced'
          : 'queue';

  return {
    startDate,
    day,
    beyondQueue,
    floorBinding,
    // What it means is unchanged and it is asked of the TAIL: the rows the engine chose the day for
    // are locked only where the queue would never have reached that day anyway. A painted HEAD is
    // padlocked whatever this says — the minute the owner drew is what holds it.
    autoLock: (mode === 'born' || mode === 'painted') && (floorBinding || day === 'past'),
    dayLock: chosenByHand,
    needsDayConfirmation: chosenByHand,
    mode,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface CreationRequest {
  /** The job being created. It has no rows yet, which every branch below relies on. */
  projectId: string;
  /** Its whole estimate, in minutes. */
  minutes: number;
  /** The id of the first row written. */
  blockId: string;
  /** Ids for the rows after the first. Called once per row. */
  newBlockId: () => string;
  /** `created_at` / `updated_at` for the rows — the caller's clock. */
  now: string;
  /** The floor the owner chose. Required: a creation without one is the old path. */
  startDate: string;
  force?: boolean;
  /**
   * A BAND was painted on the grid: minutes from midnight, and the hours start exactly there. It
   * turns the chosen day from a floor ("not before this") into a point ("here"), so it is never sent
   * together with `force`, which only means something while a placement is deferred.
   */
  startMinutes?: number;
}

/** Work already sitting inside the span the job would occupy on the chosen day. */
export interface CreationCollision {
  projectId: string;
  date: string;
  /** Its minutes on that day, summed. */
  minutes: number;
  /** A padlock, which forcing does NOT move: the job splits around it and carries on. */
  locked: boolean;
  /** The engine cannot move it at all: locked, on a weekend or in the past. */
  fixed: boolean;
}

export interface CreationPlan {
  ok: true;
  decision: StartDateDecision;
  /**
   * The WHOLE calendar as it would stand before the reflow — the caller hands this straight
   * to `recompose({ blocks })`. It already contains the new job's rows.
   */
  blocks: Block[];
  /** The new job's rows after the reflow, in calendar order: the preview. */
  placed: PlacedBlock[];
  /** The day the hours really start on, `null` when the job has no rows at all. */
  startsOn: string | null;
  endsOn: string | null;
  /** The job starts later than the chosen day: the floor was not binding. */
  deferred: boolean;
  /** Forcing is on offer — it only means something while the placement is deferred. */
  canForce: boolean;
  /** The days the collisions were measured over: the span the job would occupy THAT day. */
  span: { startDate: string; endDate: string } | null;
  collisions: CreationCollision[];
  /** Auto days with no work at all, from the chosen day onwards. Alternatives to offer. */
  freeDates: string[];
}

export interface CreationError {
  code: string;
  /** i18n key, never a translated sentence. */
  messageKey: string;
  projectId?: string;
  unplacedMinutes?: number;
  horizonEndDate?: string;
}

export interface CreationFailure {
  ok: false;
  error: CreationError;
}

export type CreationResult = CreationPlan | CreationFailure;

/**
 * Everything the create endpoint and the preview endpoint both need, computed once. The order
 * is the whole design: ask the engine where an appended job would go, decide what the date
 * therefore means, build the rows, then ask the engine again where THOSE rows land.
 */
export function planCreation(input: ComposeInput, request: CreationRequest): CreationResult {
  const minutes = Math.round(request.minutes);
  const config = input.getDayConfig(request.startDate);

  // 1. Where would this job go if the date said nothing? Its failure is not the plan's
  //    failure — a job born in the past may fit where an appended one does not — so it only
  //    means the floor binds.
  const appended = appendedDraft(input, request, minutes);
  if (!appended.ok) return appended;
  const queueLayout = layoutOf(input, appended.blocks, request.projectId);
  const queueStartDate = queueLayout.ok && queueLayout.rows.length > 0 ? queueLayout.rows[0].date : null;

  const decision = decideStartDate({
    startDate: request.startDate,
    today: input.today,
    lastOccupiedDate: summarizeSchedule(input.blocks, input.today).lastOccupiedDate,
    role: config.role,
    isClosed: config.isClosed,
    queueStartDate,
    force: request.force,
    painted: request.startMinutes !== undefined,
  });

  // 2. The rows to write.
  const draft =
    decision.mode === 'painted'
      ? paintedDraft(input, request, decision, minutes)
      : decision.mode === 'queue'
        ? appended
        : decision.mode === 'forced'
          ? { ok: true as const, blocks: [...input.blocks.map(cloneBlock), rankedRow(request, decision.startDate, minutes)] }
          : bornDraft(input, request, decision, minutes);
  if (!draft.ok) return draft;

  // 3. Where they land. Reusing the queue layout when it IS the answer keeps the two
  //    from ever disagreeing.
  const layout = decision.mode === 'queue' ? queueLayout : layoutOf(input, draft.blocks, request.projectId);
  if (!layout.ok) return layout;

  const placed = layout.rows;
  const startsOn = placed.length === 0 ? null : placed[0].date;
  const endsOn = placed.length === 0 ? null : placed[placed.length - 1].date;
  const deferred = startsOn !== null && compareDates(startsOn, decision.startDate) > 0;

  // The collisions are measured over the span the job would occupy STARTING ON the chosen
  // day, even when the plan defers it — that is the question the owner is asking, so after a
  // deferral the answer comes from a hypothetical forced layout rather than from where the
  // job really lands.
  const spanRows =
    decision.mode === 'queue' ? forcedRowsFor(input, request, decision, minutes) : placed;
  const span =
    spanRows.length === 0
      ? null
      : { startDate: spanRows[0].date, endDate: spanRows[spanRows.length - 1].date };

  return {
    ok: true,
    decision,
    blocks: draft.blocks,
    placed,
    startsOn,
    endsOn,
    deferred,
    // Forcing answers a DEFERRAL, and a painted band is never deferred: it is already on the minute
    // it asked for, or it was refused.
    canForce: decision.mode === 'queue' && deferred,
    span,
    collisions: span === null ? [] : collisionsIn(input, span, request.projectId),
    freeDates: freeDatesFrom(input, decision.startDate),
  };
}

// ---------------------------------------------------------------------------
// Internals — the rows to write
// ---------------------------------------------------------------------------

interface DraftBlocks {
  ok: true;
  blocks: Block[];
}

/**
 * Creation without a start date: the whole estimate handed to the LIFO transform for a
 * project with no rows, which appends one provisional row after the last block on the
 * calendar — the same code path the job form's hour stepper uses.
 */
function appendedDraft(
  input: ComposeInput,
  request: CreationRequest,
  minutes: number,
): DraftBlocks | CreationFailure {
  const edit = changeProjectMinutes(input.blocks, {
    projectId: request.projectId,
    deltaMinutes: minutes,
    today: input.today,
    newBlockId: request.blockId,
    now: request.now,
  });
  if (!edit.ok) {
    // Unreachable: adding hours to a job with no rows appends a row and has no refusal.
    // Reported rather than thrown, because this module never throws.
    return { ok: false, error: { code: edit.error.code, messageKey: edit.error.messageKey } };
  }
  return { ok: true, blocks: edit.blocks };
}

/**
 * The job's real rows, born on the chosen day. Two halves, because the weekend is outside
 * `compose` by date: whatever sits on a chosen Saturday or Sunday is laid out by
 * `manualDaySegments`, and everything else — including the continuation of a weekend job —
 * comes from `engineRows`.
 */
function bornDraft(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
): DraftBlocks | CreationFailure {
  const head =
    decision.day === 'weekend' || decision.day === 'closed'
      ? manualDaySegments(input, decision.startDate, minutes)
      : [];
  const headMinutes = head.reduce((total, segment) => total + segment.durationMinutes, 0);
  const rest = minutes - headMinutes;

  const rows: Block[] = head.map((segment) => bornRow(request, decision, segment));

  if (rest > 0) {
    const tail = engineRows(input, request, decision, rest, rows);
    if (!tail.ok) return tail;
    rows.push(...tail.rows);
  }

  return { ok: true, blocks: [...input.blocks.map(cloneBlock), ...rows] };
}

/**
 * A BAND: the hours start on the minute it was painted on, cut at every break, padlocked, and
 * whatever the day cannot hold carries on from the NEXT day the engine lays out.
 *
 * The head is refused rather than moved. A gap and a row outside the movable pool are the two things
 * nothing will shift out of the way, so the band cannot have the minute it asked for and giving it
 * another one silently would be a placement nobody chose — the same answer a gap gets, by the same
 * `findGapConflicts`. Ordinary work is NOT a refusal: the reflow pushes that forward.
 */
function paintedDraft(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
): DraftBlocks | CreationFailure {
  const config = input.getDayConfig(decision.startDate);
  const plan = paintedSegments(config.manualWindows, request.startMinutes ?? 0, minutes);

  if (plan.segments.length === 0) {
    return {
      ok: false,
      error: { code: 'painted-no-room', messageKey: 'errors.paintedNoRoom' },
    };
  }

  const head: Block[] = plan.segments.map((segment) => ({
    id: request.newBlockId(),
    projectId: request.projectId,
    date: decision.startDate,
    startMinutes: segment.startMinutes,
    durationMinutes: segment.durationMinutes,
    // ALWAYS, whatever `autoLock` says: on a Monday-Thursday hole nothing else would hold the row
    // to the minute the band was drawn on, and the next reflow would move it.
    locked: true,
    createdAt: request.now,
    updatedAt: request.now,
  }));

  // Asked of every ROW, never of `start + duration`: a band across the lunch break spans a stretch where
  // nothing can be, and the test would miss whatever its real second half lands on.
  for (const row of head) {
    for (const hole of input.gaps) {
      if (hole.date !== row.date) continue;
      if (
        Math.min(row.startMinutes + row.durationMinutes, hole.startMinutes + hole.durationMinutes) >
        Math.max(row.startMinutes, hole.startMinutes)
      ) {
        return { ok: false, error: { code: 'painted-over-gap', messageKey: 'errors.paintedOverGap' } };
      }
    }

    const fixed = findGapConflicts(input.blocks, row, input.today)[0];
    if (fixed !== undefined) {
      return {
        ok: false,
        error: {
          code: 'painted-over-fixed-block',
          messageKey:
            fixed.reason === 'locked'
              ? 'errors.paintedOverLockedBlock'
              : fixed.reason === 'weekend'
                ? 'errors.paintedOverWeekendBlock'
                : 'errors.paintedOverPastBlock',
          projectId: fixed.projectId,
        },
      };
    }
  }

  const rows = [...head];
  if (plan.overflow > 0) {
    const tail = engineRows(
      input,
      request,
      decision,
      plan.overflow,
      rows,
      nextWeekday(decision.startDate),
    );
    if (!tail.ok) return tail;
    rows.push(...tail.rows);
  }

  return { ok: true, blocks: [...input.blocks.map(cloneBlock), ...rows] };
}

/**
 * `compose`, asked where the hours go if the calendar started on the chosen day: `today`
 * moved to that day and every existing row force-locked, so they are obstacles rather than
 * work to reflow. `extra` holds the rows already decided for a chosen weekend day, passed in
 * as obstacles too.
 */
function engineRows(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
  extra: readonly Block[],
  /**
   * Where the continuation is RANKED. A painted band must pass the day AFTER its own: `rankedRow`
   * writes `startMinutes: 0`, a rank before everything on that day, so anchoring a painted tail on
   * the painted day laid its overflow in front of the band — padlocked, hours the owner never aimed
   * at, and the ghost had drawn them on the next column.
   */
  anchor?: string,
): { ok: true; rows: Block[] } | CreationFailure {
  // A weekend day holds nothing the engine places, so the continuation is ranked on the first
  // weekday.
  const anchorDate =
    anchor ?? (isWeekend(decision.startDate) ? nextWeekday(decision.startDate) : decision.startDate);

  // A chosen Friday is opened up whatever ELSE is true of it: without this the buffer rule
  // would refuse it and the hours would land on the following Monday, which nobody asked for.
  const opensBuffer = input.getDayConfig(decision.startDate).role === 'buffer';

  const synthetic: ComposeInput = {
    ...input,
    // Only a PAINTED tail moves this: the frozen past is what keeps it off the painted day
    // entirely, so the band's own morning can never be filled behind it. A born job leaves it on
    // the chosen day, where a chosen Saturday's tail is already ranked on the Monday after.
    today: anchor ?? decision.startDate,
    blocks: [
      ...input.blocks.map((block) => ({ ...block, locked: true })),
      ...extra.map((block) => ({ ...block, locked: true })),
      rankedRow(request, anchorDate, minutes),
    ],
    getDayConfig: (date) => {
      const config = input.getDayConfig(date);
      // The buffer accepts what the owner asked it to. The weekend is never opened up.
      return date === decision.startDate && opensBuffer ? { ...config, role: 'auto' } : config;
    },
    // The CONTINUATION follows the normal rules: a new job's tail skips the Friday buffer.
    newProjectIds: [request.projectId],
    grownProjectIds: undefined,
  };

  const result = compose(synthetic);
  if (!result.ok) return { ok: false, error: composeFailure(result.error) };

  // `extra` belongs to this same job, so it comes back out of `compose` untouched (it went in
  // locked) and has to be dropped here or the job would be written twice.
  const already = new Set(extra.map((block) => block.id));
  const rows = result.blocks
    .filter((placed) => placed.projectId === request.projectId && !already.has(placed.id ?? ''))
    .map((placed) =>
      bornRow(request, decision, {
        date: placed.date,
        startMinutes: placed.startMinutes,
        durationMinutes: placed.durationMinutes,
      }),
    );

  return { ok: true, rows };
}

/** One row of a born job, padlocked as the decision calls for. */
function bornRow(
  request: CreationRequest,
  decision: StartDateDecision,
  segment: Segment,
): Block {
  return {
    id: request.newBlockId(),
    projectId: request.projectId,
    date: segment.date,
    startMinutes: segment.startMinutes,
    durationMinutes: segment.durationMinutes,
    // `autoLock` is every row or none — a half-locked job would come apart on the next reflow
    // — while `dayLock` stands for the DAY a human chose, so it skips the tail the engine
    // decided.
    locked: decision.autoLock || (decision.dayLock && segment.date === decision.startDate),
    createdAt: request.now,
    updatedAt: request.now,
  };
}

/**
 * One provisional row carrying the whole estimate, ranked at the START of a day.
 * `startMinutes: 0` is a queue RANK, not a time: it sorts the job before everything already
 * on that day. The row is never stored — `compose` re-segments it into the rows that are.
 */
function rankedRow(request: CreationRequest, date: string, minutes: number): Block {
  return {
    id: request.blockId,
    projectId: request.projectId,
    date,
    startMinutes: 0,
    durationMinutes: minutes,
    locked: false,
    createdAt: request.now,
    updatedAt: request.now,
  };
}

// ---------------------------------------------------------------------------
// Internals — a day the engine will not place on
// ---------------------------------------------------------------------------

interface Segment {
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Where hours physically fit on a day `compose` will not place on — the weekend. The same
 * question `buildManualDayPlan` answers inside the engine for a displaced tail: free working
 * time forward, a run that holds the hours whole preferred, every row inside ONE working
 * period, and capacity not applied, because it never blocks manual placement.
 *
 * Preferring one run is NOT the rule *Fill and Overflow, Always* deleted: nothing is thrown at
 * another day leaving this one's tail empty — whatever the chosen day cannot hold goes straight
 * back to `compose`. It is only contiguity on a day the owner named by hand: with a free hour at
 * 08:00 and four from 10:00, a 3 h job is better as one row than as `1 h + 2 h`.
 */
function manualDaySegments(input: ComposeInput, date: string, minutes: number): Segment[] {
  // The CALLER decides which days come here — the ones the engine will not lay out — so a closed
  // day is laid out like a weekend rather than refused. Refusing it here is what sent the hours to
  // the first open day instead of the day the owner chose.
  const config = input.getDayConfig(date);

  const occupied: Interval[] = [];
  for (const gap of input.gaps) {
    if (gap.date === date) occupied.push({ start: gap.startMinutes, end: gap.startMinutes + gap.durationMinutes });
  }
  for (const block of input.blocks) {
    if (block.date === date) {
      occupied.push({ start: block.startMinutes, end: block.startMinutes + block.durationMinutes });
    }
  }

  const busy = mergeIntervals(occupied);
  const free: Interval[] = [];
  for (const period of sortedPeriods(config.periods)) {
    free.push(...freeInside({ start: period.startMinutes, end: period.endMinutes }, busy));
  }

  const whole = free.find((run) => run.end - run.start >= minutes);
  if (whole !== undefined) {
    return [{ date, startMinutes: whole.start, durationMinutes: minutes }];
  }

  const segments: Segment[] = [];
  let remaining = minutes;
  for (const run of free) {
    if (remaining <= 0) break;
    const take = Math.min(run.end - run.start, remaining);
    segments.push({ date, startMinutes: run.start, durationMinutes: take });
    remaining -= take;
  }
  return segments;
}

function sortedPeriods(periods: readonly WorkPeriod[]): WorkPeriod[] {
  return [...periods]
    .filter((period) => period.endMinutes > period.startMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

/** The union of intervals: overlapping and touching ranges become one. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

/** What is left of `span` once the (already merged) busy ranges are taken out. */
function freeInside(span: Interval, busy: readonly Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = span.start;
  for (const interval of busy) {
    if (interval.end <= cursor) continue;
    if (interval.start >= span.end) break;
    if (interval.start > cursor) free.push({ start: cursor, end: Math.min(interval.start, span.end) });
    cursor = Math.max(cursor, interval.end);
    if (cursor >= span.end) break;
  }
  if (cursor < span.end) free.push({ start: cursor, end: span.end });
  return free.filter((interval) => interval.end > interval.start);
}

/** The first day from `date` that is not a Saturday or a Sunday. */
function nextWeekday(date: string): string {
  let next = addDays(date, 1);
  while (isWeekend(next)) next = addDays(next, 1);
  return next;
}

// ---------------------------------------------------------------------------
// Internals — where those rows land
// ---------------------------------------------------------------------------

function layoutOf(
  input: ComposeInput,
  blocks: readonly Block[],
  projectId: string,
): { ok: true; rows: PlacedBlock[] } | CreationFailure {
  const result = compose({
    ...input,
    blocks,
    newProjectIds: [projectId],
    grownProjectIds: undefined,
  });
  if (!result.ok) return { ok: false, error: composeFailure(result.error) };
  return { ok: true, rows: result.blocks.filter((placed) => placed.projectId === projectId) };
}

/**
 * Where the job WOULD sit if the chosen day were forced — used only to measure the span a
 * deferred placement is being compared against. A failure is not reported: the plan itself
 * succeeded, and the honest answer is then "no span to report".
 */
function forcedRowsFor(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
): PlacedBlock[] {
  const layout = layoutOf(
    input,
    [...input.blocks.map(cloneBlock), rankedRow(request, decision.startDate, minutes)],
    request.projectId,
  );
  return layout.ok ? layout.rows : [];
}

/**
 * Every job with hours inside the span, one entry per job per day, in calendar order. The
 * whole span, not only the first day: something sitting on the 18th is in the way just as
 * much.
 */
function collisionsIn(
  input: ComposeInput,
  span: { startDate: string; endDate: string },
  projectId: string,
): CreationCollision[] {
  const byKey = new Map<string, CreationCollision>();

  for (const block of input.blocks) {
    if (block.projectId === projectId) continue;
    if (compareDates(block.date, span.startDate) < 0) continue;
    if (compareDates(block.date, span.endDate) > 0) continue;

    const key = `${block.date}|${block.projectId}`;
    const entry = byKey.get(key);
    const fixed =
      block.locked || isWeekend(block.date) || compareDates(block.date, input.today) < 0;

    if (entry === undefined) {
      byKey.set(key, {
        projectId: block.projectId,
        date: block.date,
        minutes: block.durationMinutes,
        locked: block.locked,
        fixed,
      });
      continue;
    }
    entry.minutes += block.durationMinutes;
    entry.locked = entry.locked || block.locked;
    entry.fixed = entry.fixed || fixed;
  }

  return [...byKey.values()].sort(
    (a, b) => compareDates(a.date, b.date) || compareText(a.projectId, b.projectId),
  );
}

/**
 * The auto days from the chosen day onwards that carry no work at all — the answer to "then
 * when?". Bounded by the horizon and by `MAX_FREE_DATES`: a list to glance at, not a calendar
 * to browse.
 */
function freeDatesFrom(input: ComposeInput, startDate: string): string[] {
  const from = compareDates(startDate, input.today) < 0 ? input.today : startDate;
  const horizon = horizonEndDate(input.today, input.planningHorizonWeeks);
  const occupied = new Set(input.blocks.map((block) => block.date));
  const dates: string[] = [];

  for (let date = from; compareDates(date, horizon) <= 0; date = addDays(date, 1)) {
    if (dates.length >= MAX_FREE_DATES) break;
    if (occupied.has(date)) continue;
    const config = input.getDayConfig(date);
    if (config.isClosed || config.role !== 'auto') continue;
    dates.push(date);
  }

  return dates;
}

// ---------------------------------------------------------------------------
// Internals — plumbing
// ---------------------------------------------------------------------------

function composeFailure(error: {
  code: string;
  messageKey: string;
  projectId: string;
  unplacedMinutes: number;
  horizonEndDate: string;
}): CreationError {
  return {
    code: error.code,
    messageKey: error.messageKey,
    projectId: error.projectId,
    unplacedMinutes: error.unplacedMinutes,
    horizonEndDate: error.horizonEndDate,
  };
}

function cloneBlock(block: Block): Block {
  return { ...block };
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
