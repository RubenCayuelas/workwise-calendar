/**
 * `readWeek` is deliberately ONE call: blocks, projects, gaps and the seven days'
 * configuration have to be one snapshot, or the grid draws a block against a day whose
 * capacity a recomposition has already rewritten.
 */

import { getDb, type Db } from '../db';
import {
  compareDates,
  isoWeekNumber,
  isoWeekYear,
  isWeekend,
  todayLocal,
  weekDates,
  weekdayOf,
} from '../dates';
import { summarizeSchedule, type DayRole, type ScheduleSummary } from '../composition';
import { plannableMinutesOf, readSnapshot } from '../scheduler';
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
  /** `auto` Mon-Thu, `buffer` Friday (the colchón), `manual` Sat/Sun. */
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
  };
}

function withinWeek(date: string, startDate: string, endDate: string): boolean {
  return compareDates(date, startDate) >= 0 && compareDates(date, endDate) <= 0;
}
