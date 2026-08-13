/**
 * The read-only views the screens are built from.
 *
 * `readWeek` is deliberately one call. The week grid needs blocks, the project each
 * block belongs to, gaps, and the seven days' configuration — and those four have to
 * agree with each other. Fetched separately they would be four snapshots of a
 * database that a recomposition rewrites wholesale, so the grid could draw a block
 * against a day whose capacity had already changed. One call, one snapshot.
 *
 * Nothing here computes a Spanish sentence or a formatted date. `days[]` carries the
 * STATE the wireframe's headers render ("Lun 10 · congelado", "Vie 14 · colchón") as
 * flags, and the UI words them from public/locales. Likewise the summary strip gets
 * numbers, per CLAUDE.md's rule that `composition.ts` owns that arithmetic.
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

/** A block with just enough of its job to be drawn: name, colour, and the padlock. */
export interface WeekBlock extends Block {
  project: { id: string; name: string; color: string };
}

/** One column of the grid, with the state its header shows. */
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
  /**
   * The same day as a HAND action sees it: the periods plus the visual margins, fused
   * where they touch. What a drop, a resize and the scissors may use — the grey margin
   * bands included, which auto-fill never enters. See src/lib/manualWindow.ts.
   */
  manualWindows: WorkPeriod[];
  /** This day's auto-fill stop line. Never a limit on manual placement. */
  capacityMinutes: number;
  /**
   * The engine's accounting number: `min(capacity, period minutes − the minutes
   * gaps and LOCKED blocks hold)`, as a union of intervals. Zero for the past, a
   * closed day and the weekend.
   *
   * Note what it does NOT subtract: ordinary unlocked work. Those hours are movable,
   * so from the engine's point of view the day can still take that much. For "how
   * full does this day look", use `bookedMinutes`.
   */
  plannableMinutes: number;
  /**
   * Every minute of work actually sitting on the day, locked or not. This is the
   * occupancy a day header reports; `capacityMinutes − bookedMinutes` is the room
   * the owner sees left.
   */
  bookedMinutes: number;
  /** The override's note, when there is one. */
  note?: string;
}

export interface WeekView {
  /** The shop's local today, so the grid does not have to guess a timezone. */
  today: string;
  week: {
    /** Monday. */
    startDate: string;
    /** Sunday. */
    endDate: string;
    /** All seven days, Monday first — the grid always renders every column. */
    dates: string[];
    isoWeek: number;
    isoWeekYear: number;
  };
  settings: Settings;
  /** Periods, capacity and the margin-to-margin timeline the time axis draws. */
  shape: DayShape;
  days: WeekDay[];
  blocks: WeekBlock[];
  gaps: Gap[];
  /**
   * The header strip. Week-independent (it looks across ALL weeks) and identical to
   * `GET /api/summary`; included so a page load is one request rather than two.
   */
  summary: ScheduleSummary;
}

/**
 * Everything the week view needs for the week containing `reference`.
 *
 * `blocks` and `gaps` are limited to those seven days, while `summary` is computed
 * from the whole calendar — that difference is the point of the strip, which states
 * how far the shop is booked beyond the week on screen.
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
      // A foreign key guarantees the job exists, so the fallback is unreachable —
      // it is here so a corrupt database renders instead of throwing.
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
