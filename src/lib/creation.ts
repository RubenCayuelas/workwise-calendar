/**
 * Creating a job WITH A START DATE: where its hours are born, and what that costs.
 *
 * The date the owner picks on the create form means one thing — **not before this day**.
 * It is a floor, not a deadline (CLAUDE.md excludes deadlines deliberately), and it is
 * NOT STORED: it decides where the rows are born and nothing else. There is no
 * `not_before` column and no new check inside `compose`. Where a date genuinely has to
 * survive, the automatic lock below is what survives.
 *
 * THE THREE MODES, and they all fall out of one question — "would the engine put this job
 * on or after that day by itself?":
 *
 * | the chosen day                              | mode     | what is written                 |
 * |---------------------------------------------|----------|---------------------------------|
 * | the queue already reaches it: appending the job lands on or after that day | `queue`  | today's behaviour exactly: one provisional row after the last block. The floor is not binding, so the job joins the end of the queue — and when that is LATER than the day chosen, the form says so before saving. |
 * | the same, but the owner disagreed            | `forced` | one provisional row ranked at 00:00 of that day, so the job takes that place in the queue and the work behind it moves — the same outcome as creating the job and dragging it there. |
 * | the engine would place it EARLIER (the day is beyond the work planned), or would not place it there at all (a Friday, a weekend, the past) | `born` | the job's real rows, on that day and the days after it, LOCKED wherever a lock is the only thing that would hold them — every row when the floor binds, and the rows on the chosen day itself when that day is one the engine would never use (a Friday, a weekend). |
 *
 * WHY THE LOCK IS MECHANICAL AND NOT A PREFERENCE. Queue order IS calendar position
 * (`ORDER BY date, start_time`) and the engine fills forward from today to avoid leaving
 * holes, so a rank on a later day is not a reservation: a job with nothing in front of it
 * is placed at the cursor, which is today. The padlock is the only thing that holds a job
 * on a day the reflow could otherwise fill earlier, and it must cover EVERY row — a
 * half-locked job comes apart on the next pass. Where the work already in front of the
 * job is what holds it, no lock is added.
 *
 * The lock is therefore decided by MEASURING rather than by guessing: `planCreation` first
 * asks the engine where an ordinary appended job would land (`queueStartDate`), and the
 * floor is binding exactly when that answer is earlier than the day chosen. On the dense
 * calendar the owner described this is the same rule they stated — "later than the last
 * occupied day" — and it stays right on a sparse one, where a single locked row far out
 * makes "the last occupied day" say nothing about where the engine would fill.
 *
 * HOW THE ROWS ARE BORN WITHOUT A SECOND PLACEMENT ENGINE. `engineRows` asks `compose`
 * itself, on a SYNTHETIC snapshot: `today` moved to the chosen day, every existing row
 * force-locked so it is an obstacle rather than something to reflow, and a chosen FRIDAY's
 * role forced to `auto` so the buffer accepts the hours the owner explicitly asked for.
 * The answer is then the engine's own — segmented at the lunch break, capped by the day's
 * plannable minutes, flowing around gaps and locks, never backfilling, skipping the buffer
 * for the continuation, bounded by the horizon.
 *
 * THE ONE DAY THE ENGINE CANNOT BE ASKED ABOUT is the weekend: `isMovable` excludes
 * Saturday and Sunday BY DATE, whatever a day's configuration says, so no synthetic input
 * makes `compose` place a row there. `manualDaySegments` lays out the hours that sit on a
 * chosen weekend day — free working time, forward only, a run that holds the job whole
 * preferred, never straddling the lunch break — which is the same question
 * `buildManualDayPlan` answers inside the engine for a displaced tail. Whatever does not
 * fit that day goes back to `compose` from the following Monday.
 *
 * `planCreation` is one implementation with two callers: the create endpoint writes what
 * it returns and the preview endpoint renders it, so the form cannot promise a placement
 * the save will not perform.
 *
 * Pure: no database, no clock, no user-facing text — `today` is an input and failures
 * carry i18n keys.
 */

import type { Block, WorkPeriod } from '../types';
import { addDays, compareDates, isWeekend } from './dates';
import {
  changeProjectMinutes,
  compose,
  horizonEndDate,
  summarizeSchedule,
  type ComposeInput,
  type PlacedBlock,
} from './composition';

/** How many free days the preview offers as alternatives. A dropdown is one click away. */
const MAX_FREE_DATES = 8;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the chosen day IS, in the terms the owner has to be told about.
 *
 * `past` and `weekend` win over `closed` and `buffer` because they are the stronger fact
 * about the day: a closed Saturday is still the weekend, and the sentence about the
 * weekend is the one that helps.
 */
export type StartDateDay = 'auto' | 'buffer' | 'weekend' | 'past' | 'closed';

/** How the job's rows are decided. See the table at the top of this file. */
export type CreationMode = 'queue' | 'forced' | 'born';

export interface StartDateDecision {
  startDate: string;
  day: StartDateDay;
  /**
   * The chosen day is later than the last occupied day — the owner's own words for
   * "empty territory". Reported because it is what the explanation is built on; the
   * lock is decided by `floorBinding`, which measures the same thing directly.
   */
  beyondQueue: boolean;
  /**
   * The engine would place an appended job EARLIER than the chosen day, so nothing on
   * the calendar holds this job there.
   */
  floorBinding: boolean;
  /** Every row created for the job is locked. Mechanical, not a preference. */
  autoLock: boolean;
  /**
   * The rows born ON THE CHOSEN DAY are locked, because it is a day the engine would
   * never have used — the Friday buffer, the weekend — and the padlock is the only thing
   * that keeps them there. Not the tail on later days: the engine chose those.
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
   * The day an ORDINARY appended job would start on — `compose`'s own answer, which is
   * the only honest test of whether the floor binds. `null` when it does not fit at all.
   */
  queueStartDate: string | null;
  /** The owner disagreed with the deferral and asked for that day anyway. */
  force?: boolean;
}

/**
 * The whole policy, as one pure decision over six facts.
 *
 * Kept separate from the placement so the boundary the owner will actually hit — the
 * chosen day is the last occupied day, therefore no lock — is a unit test rather than an
 * inference from a calendar.
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

  // "Later than the last currently occupied day." With a clear calendar there is no
  // occupied day at all and the engine would start at today.
  const beyondQueue =
    lastOccupiedDate === null
      ? compareDates(startDate, today) > 0
      : compareDates(startDate, lastOccupiedDate) > 0;

  // The floor binds when the engine's own answer to an appended job is EARLIER than the
  // day asked for. Nothing then holds the job on that day but a padlock.
  const floorBinding = queueStartDate === null || compareDates(queueStartDate, startDate) < 0;

  // The days the engine will not put a new job on by itself: the buffer belongs to the
  // growth of placed work, the weekend is outside the engine, and the past is frozen.
  const engineWouldNotPlace = day === 'buffer' || day === 'weekend' || day === 'past';
  const mode: CreationMode =
    engineWouldNotPlace || floorBinding ? 'born' : question.force === true ? 'forced' : 'queue';

  return {
    startDate,
    day,
    beyondQueue,
    floorBinding,
    autoLock: mode === 'born' && (floorBinding || day === 'past'),
    dayLock: day === 'buffer' || day === 'weekend',
    needsDayConfirmation: day === 'buffer' || day === 'weekend',
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
}

/** Work already sitting inside the span the job would occupy on the chosen day. */
export interface CreationCollision {
  projectId: string;
  date: string;
  /** Its minutes on that day, summed. */
  minutes: number;
  /**
   * A padlock, which forcing does NOT move: the locked row stands and the new job
   * splits around it and continues after it. Existing engine behaviour — a locked
   * block is not a wall.
   */
  locked: boolean;
  /** The engine cannot move it at all: locked, on a weekend or in the past. */
  fixed: boolean;
}

export interface CreationPlan {
  ok: true;
  decision: StartDateDecision;
  /**
   * The WHOLE calendar as it would stand before the reflow — the caller hands this
   * straight to `recompose({ blocks })`. It already contains the new job's rows.
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
 * Everything the create endpoint and the preview endpoint both need, computed once.
 *
 * The order is the whole design: ask the engine where an appended job would go, decide
 * what the date therefore means, build the rows, then ask the engine again where THOSE
 * rows land. `placed` is consequently the engine's answer to the exact rows that will be
 * written, not an estimate of them.
 */
export function planCreation(input: ComposeInput, request: CreationRequest): CreationResult {
  const minutes = Math.round(request.minutes);
  const config = input.getDayConfig(request.startDate);

  // 1. The ordinary creation, as a question: where would this job go if the date said
  //    nothing? Its failure is not the plan's failure — a job born in the past may fit
  //    where an appended one does not — so it only means "the floor binds".
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
  });

  // 2. The rows to write.
  const draft =
    decision.mode === 'queue'
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

  // The span the collisions are measured over is always the one the job would occupy
  // STARTING ON the chosen day, even when the plan defers it — that is the question the
  // owner is asking ("what is in the way on those days?"), and after a deferral the
  // answer has to come from a hypothetical forced layout rather than from where the job
  // actually lands.
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
 * Creation exactly as it has always been: the job's whole estimate handed to the LIFO
 * transform for a project with no rows, which appends one provisional row after the last
 * block on the calendar. The same code path the job form's hour stepper uses, so
 * "created" and "grown by its full estimate" can never place hours differently.
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
 * The job's real rows, born on the chosen day.
 *
 * Two halves, because the weekend is outside `compose` by date and nothing makes it
 * otherwise: whatever sits on a chosen Saturday or Sunday is laid out by
 * `manualDaySegments`, and everything else — including the continuation of a weekend job
 * — is the engine's own answer from `engineRows`.
 */
function bornDraft(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
): DraftBlocks | CreationFailure {
  const head = isWeekend(decision.startDate)
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
 * `compose`, asked where the hours go if the calendar started on the chosen day.
 *
 * `extra` holds the rows already decided for a chosen weekend day: they are passed in as
 * obstacles so the continuation flows around them instead of over them.
 */
function engineRows(
  input: ComposeInput,
  request: CreationRequest,
  decision: StartDateDecision,
  minutes: number,
  extra: readonly Block[],
): { ok: true; rows: Block[] } | CreationFailure {
  // A weekend day can hold nothing the engine places, so its continuation is ranked on
  // the first weekday from there — a row dated Saturday would not be in the pool at all.
  const anchorDate = isWeekend(decision.startDate) ? nextWeekday(decision.startDate) : decision.startDate;

  // A chosen Friday is opened up whatever ELSE is true of it. `day` reports the strongest
  // fact about the date for the owner, so a Friday in the past reads as `past` — and
  // without this the buffer rule would still refuse it and the hours would land on the
  // following Monday, which is not the day anybody asked for.
  const opensBuffer = input.getDayConfig(decision.startDate).role === 'buffer';

  const synthetic: ComposeInput = {
    ...input,
    today: decision.startDate,
    blocks: [
      ...input.blocks.map((block) => ({ ...block, locked: true })),
      ...extra.map((block) => ({ ...block, locked: true })),
      rankedRow(request, anchorDate, minutes),
    ],
    getDayConfig: (date) => {
      const config = input.getDayConfig(date);
      // The buffer accepts what the owner explicitly asked it to. The weekend is not
      // opened up: nothing the engine places can land there whatever its role says.
      return date === decision.startDate && opensBuffer ? { ...config, role: 'auto' } : config;
    },
    // The CONTINUATION follows the normal rules from the chosen day: a new job's tail
    // skips the Friday colchón for the following Monday.
    newProjectIds: [request.projectId],
    grownProjectIds: undefined,
  };

  const result = compose(synthetic);
  if (!result.ok) return { ok: false, error: composeFailure(result.error) };

  // `extra` belongs to this same job, so it comes back out of `compose` untouched (it
  // went in locked) and has to be dropped here or the job would be written twice.
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

/** One row of a born job, with the two marks the decision calls for. */
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
    // Two reasons for one padlock. `autoLock` is every row or none — a half-locked job
    // would come apart on the next reflow — while `dayLock` stands for the DAY a human
    // chose, so it goes on the rows that landed on that day and not on the tail, whose
    // day the engine decided.
    locked: decision.autoLock || (decision.dayLock && segment.date === decision.startDate),
    createdAt: request.now,
    updatedAt: request.now,
  };
}

/**
 * One provisional row carrying the whole estimate, ranked at the START of a day.
 *
 * `startMinutes: 0` is a queue RANK, not a time: it sorts the job before everything
 * already on that day, which is what "take that place in the queue" means. The row is
 * never stored — `compose` re-segments it into the rows that are.
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
 * Where hours physically fit on a day `compose` will not place on — the weekend.
 *
 * The same question `buildManualDayPlan` answers inside the engine for a displaced tail.
 * Every row sits inside ONE working period, so nothing straddles the lunch break, and
 * capacity is not applied: it is a stop-line for auto-fill and "never blocks manual
 * placement", and a day the owner chose by hand is manual placement.
 *
 * A RUN THAT HOLDS THE HOURS WHOLE IS STILL PREFERRED HERE, and that is NOT the rule
 * *Fill and Overflow, Always* deleted (2026-08-17). That rule was about a job that did not
 * fit being thrown at ANOTHER DAY, leaving this one's tail empty; nothing of the kind
 * happens here — whatever a chosen day cannot hold goes straight back to `compose`, and no
 * hour is left free either way. What is left is a preference for CONTIGUITY on a day the
 * owner named by hand: given a free hour at 08:00 and four from 10:00, a 3 h job asked for
 * that Saturday is better as one row than as `1 h + 2 h`.
 */
function manualDaySegments(input: ComposeInput, date: string, minutes: number): Segment[] {
  const config = input.getDayConfig(date);
  if (config.isClosed) return [];

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
 * Where the job WOULD sit if the chosen day were forced — used only to measure the span
 * a deferred placement is being compared against. A failure is not reported: the plan
 * itself succeeded, and the honest answer is then "no span to report".
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
 * Every job with hours inside the span, one entry per job per day, in calendar order.
 *
 * The whole span, not only the first day: a 40 h job starting on the 17th spans several
 * days, so something sitting on the 18th is in the way just as much.
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
 * The auto days from the chosen day onwards that carry no work at all — the answer to
 * "then when?". Bounded by the planning horizon and by `MAX_FREE_DATES`, because this is
 * a list to glance at rather than a calendar to browse.
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
