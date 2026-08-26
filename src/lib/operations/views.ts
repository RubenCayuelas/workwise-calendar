/**
 * `readWeek` is deliberately ONE call: blocks, projects, gaps and the seven days'
 * configuration have to be one snapshot, or the grid draws a block against a day whose
 * capacity a recomposition has already rewritten.
 */

import { getDb, type Db } from '../db';
import {
  addDays,
  compareDates,
  daysBetween,
  isoWeekNumber,
  isoWeekYear,
  isWeekend,
  todayLocal,
  weekDates,
  weekdayOf,
} from '../dates';
import {
  horizonEndDate,
  isMovable,
  summarizeSchedule,
  type DayRole,
  type ScheduleSummary,
} from '../composition';
import { freeStretchesFrom, type SpillInterval } from '../dropSpill';
import { badRequest, ERROR_MESSAGE_KEYS } from '../errors';
import { readHistoryState, type HistoryState } from '../history';
import { plannableMinutesOf, readSnapshot } from '../scheduler';
import { MIN_ROW_MINUTES } from '../validation';
import { listDayOverridesBetween } from '../repositories/dayOverrides';
import { listProjectLabels } from '../repositories/projects';
import type { Block, DayShape, Gap, Settings, WorkPeriod } from '../../types';

export interface WeekBlock extends Block {
  project: { id: string; name: string; color: string };
}

export interface WeekDay {
  date: string;
  /** ISO weekday, 1 = Monday .. 7 = Sunday. */
  weekday: number;
  /** `auto` Mon-Thu, `buffer` Friday (the buffer), `manual` Sat/Sun. */
  role: DayRole;
  /** A holiday or closed week from `day_overrides`. */
  isClosed: boolean;
  isWeekend: boolean;
  isToday: boolean;
  /** Frozen: the engine never writes here. Still editable by hand. */
  isPast: boolean;
  /** Working periods on the clock, morning first. Draw the lunch break between them. */
  periods: WorkPeriod[];
  /** The day as a HAND gesture sees it: the periods plus the visual margins, fused. */
  manualWindows: WorkPeriod[];
  /** This day's auto-fill stop line. Never a limit on manual placement. */
  capacityMinutes: number;
  /**
   * `min(capacity, period minutes − the minutes gaps and LOCKED blocks hold)`, as a union
   * of intervals; zero for the past, a closed day and the weekend. Ordinary unlocked work
   * is NOT subtracted — for "how full does this day look", use `bookedMinutes`.
   */
  plannableMinutes: number;
  /** Every minute of work on the day, locked or not — the occupancy a header reports. */
  bookedMinutes: number;
  note?: string;
}

export interface WeekView {
  /** The shop's LOCAL today. */
  today: string;
  week: {
    /** Monday. */
    startDate: string;
    /** Sunday. */
    endDate: string;
    /** All seven days, Monday first. */
    dates: string[];
    isoWeek: number;
    isoWeekYear: number;
  };
  settings: Settings;
  shape: DayShape;
  days: WeekDay[];
  blocks: WeekBlock[];
  gaps: Gap[];
  /** Week-independent: identical to `GET /api/summary`. */
  summary: ScheduleSummary;
  /**
   * Week-independent too. It rides here because the screen already refetches the week after
   * every mutation, so the undo and redo controls cannot fall out of step with the calendar
   * they act on, and no second request or second loading state is needed.
   */
  history: HistoryState;
}

/**
 * `blocks` and `gaps` cover the seven days of the week containing `reference`; `summary`
 * is computed over the whole calendar.
 */
export function readWeek(
  reference: string = todayLocal(),
  options: { today?: string } = {},
  db: Db = getDb(),
): WeekView {
  const today = options.today ?? todayLocal();
  const snapshot = readSnapshot(db, today);
  const dates = weekDates(reference);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const notes = new Map(
    listDayOverridesBetween(startDate, endDate, db).map((override) => [override.date, override.note]),
  );

  const bookedByDate = new Map<string, number>();
  for (const block of snapshot.blocks) {
    bookedByDate.set(block.date, (bookedByDate.get(block.date) ?? 0) + block.durationMinutes);
  }

  const days: WeekDay[] = dates.map((date) => {
    const config = snapshot.getDayConfig(date);
    const note = notes.get(date);
    return {
      date,
      weekday: weekdayOf(date),
      role: config.role,
      isClosed: config.isClosed,
      isWeekend: isWeekend(date),
      isToday: date === today,
      isPast: compareDates(date, today) < 0,
      periods: [...config.periods],
      manualWindows: [...config.manualWindows],
      capacityMinutes: config.capacityMinutes,
      plannableMinutes: plannableMinutesOf(snapshot, date),
      bookedMinutes: bookedByDate.get(date) ?? 0,
      ...(note === undefined ? {} : { note }),
    };
  });

  const labels = new Map(listProjectLabels(db).map((label) => [label.id, label]));
  const blocks: WeekBlock[] = snapshot.blocks
    .filter((block) => withinWeek(block.date, startDate, endDate))
    .map((block) => ({
      ...block,
      // The foreign key makes the fallback unreachable: it is here so a corrupt
      // database renders instead of throwing.
      project: labels.get(block.projectId) ?? { id: block.projectId, name: '', color: '' },
    }));

  return {
    today,
    week: {
      startDate,
      endDate,
      dates,
      isoWeek: isoWeekNumber(reference),
      isoWeekYear: isoWeekYear(reference),
    },
    settings: snapshot.settings,
    shape: snapshot.shape,
    days,
    blocks,
    gaps: snapshot.gaps.filter((gap) => withinWeek(gap.date, startDate, endDate)),
    summary: summarizeSchedule(snapshot.blocks, today),
    history: readHistoryState(db),
  };
}

/**
 * The widest span one request may ask for. Its own number: the widest window a day picker can
 * navigate is 140 days, plus a stored value's own month.
 */
export const MAX_DAY_MARK_DAYS = 200;

/** One day as a picker draws it, carrying only what the client cannot work out for itself. */
export interface DayMarkView {
  date: string;
  isClosed: boolean;
  note?: string;
  /** Net working minutes the engine would still lay work into. */
  freeMinutes: number;
  /** Whether the engine still places hours here: the horizon, the free minutes and the longest free run all have to allow it. */
  hasRoom: boolean;
}

export interface DaysView {
  /** The shop's LOCAL today. */
  today: string;
  days: DayMarkView[];
}

/**
 * The two marks a day picker cannot deduce — closed, and still has room — for every day of an
 * inclusive span. The weekend and the past are absent on purpose: the client owns them.
 *
 * The room question is NOT `WeekDay.plannableMinutes`, which does not subtract ordinary work and so
 * reports a full Tuesday as empty, and not `bookedMinutes`, which reports a day the next write will
 * clear as full.
 */
export function readDays(
  from: string,
  to: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): DaysView {
  if (daysBetween(from, to) + 1 > MAX_DAY_MARK_DAYS) {
    throw badRequest('invalid-range', ERROR_MESSAGE_KEYS.invalidRange, {
      field: 'to',
      details: { from, to, maxDays: MAX_DAY_MARK_DAYS },
    });
  }

  const today = options.today ?? todayLocal();
  const snapshot = readSnapshot(db, today);
  const notes = new Map(
    listDayOverridesBetween(from, to, db).map((override) => [override.date, override.note]),
  );
  const horizonEnd = horizonEndDate(today, snapshot.settings.planningHorizonWeeks);

  const occupiedByDate = new Map<string, SpillInterval[]>();
  for (const row of [...snapshot.gaps, ...snapshot.blocks]) {
    const rows = occupiedByDate.get(row.date);
    if (rows === undefined) occupiedByDate.set(row.date, [row]);
    else rows.push(row);
  }

  const movableByDate = new Map<string, number>();
  for (const block of snapshot.blocks) {
    if (!isMovable(block, today)) continue;
    movableByDate.set(block.date, (movableByDate.get(block.date) ?? 0) + block.durationMinutes);
  }

  const days: DayMarkView[] = [];
  for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
    const config = snapshot.getDayConfig(date);
    const note = notes.get(date);
    // The engine's own arithmetic: a day opens at its plannable minutes and auto-fill spends them,
    // and the day's movable rows are exactly what the last pass spent that budget on.
    const freeMinutes = Math.max(
      0,
      plannableMinutesOf(snapshot, date) - (movableByDate.get(date) ?? 0),
    );
    // The horizon is asked separately because the day plan does not know it: past it, a day
    // declares all its minutes plannable and would promise room where a save answers 409.
    const withinHorizon = compareDates(date, horizonEnd) <= 0;
    const longestRun = longestFreeRun(config.periods, occupiedByDate.get(date) ?? []);
    days.push({
      date,
      isClosed: config.isClosed,
      freeMinutes,
      hasRoom: withinHorizon && Math.min(freeMinutes, longestRun) >= MIN_ROW_MINUTES,
      ...(note === undefined ? {} : { note }),
    });
  }

  return { today, days };
}

function withinWeek(date: string, startDate: string, endDate: string): boolean {
  return compareDates(date, startDate) >= 0 && compareDates(date, endDate) <= 0;
}

/**
 * The longest run one row could occupy, so a day whose forty free minutes are four holes of ten
 * reports no room. Measured over the PERIODS, never the manual windows: auto-fill never enters a
 * margin.
 */
function longestFreeRun(
  periods: readonly WorkPeriod[],
  occupied: readonly SpillInterval[],
): number {
  let longest = 0;
  for (const stretch of freeStretchesFrom(periods, occupied, 0)) {
    longest = Math.max(longest, stretch.endMinutes - stretch.startMinutes);
  }
  return longest;
}
