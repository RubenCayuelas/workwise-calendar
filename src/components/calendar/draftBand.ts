/**
 * The band the grid keeps drawing while a painted form is open, following the form's own fields.
 *
 * IT IS A SHAPE, NOT A PROMISE, and deliberately so: it reads no block and no gap, so it is drawn
 * OVER whatever is underneath and never tries to say who gets pushed — that is the form's warning to
 * make, and only a whole pass knows the answer. What it IS exact about is the painted day, whose rows
 * come from the same `paintedSegments` the save writes.
 */

import { paintedSegments } from '../../lib/paintedJob';
import { compareDates } from '../../lib/dates';
import type { WorkPeriod } from '../../types';

/** The facts about a day this needs. `WeekDay` satisfies it. */
export interface DraftDay {
  date: string;
  /** Auto-fill's view: what a continuation day is measured over. */
  periods: readonly WorkPeriod[];
  /** A hand gesture's view, margins included: what the PAINTED day is measured over. */
  manualWindows: readonly WorkPeriod[];
  isWeekend: boolean;
  isClosed: boolean;
  isPast: boolean;
  role: 'auto' | 'buffer' | 'manual';
}

export interface GridDraft {
  /** A gap is never carried to another day; a job's hours overflow like any other job's. */
  kind: 'gap' | 'job';
  date: string;
  startMinutes: number;
  /** NET working minutes — the form's number, which may be far more than the band was drawn at. */
  durationMinutes: number;
}

export interface DraftRow {
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** True on a day the hours merely carried on to, which is drawn as the shape it is. */
  continuation: boolean;
}

export interface DraftPlan {
  rows: DraftRow[];
  /** Hours no visible day could hold. The label says so rather than the drawing pretending. */
  beyondMinutes: number;
}

/** The days a job's hours carry on to: the ones the engine would actually lay out. */
function takesContinuation(day: DraftDay): boolean {
  return !day.isWeekend && !day.isClosed && !day.isPast && day.role !== 'buffer';
}

export function planDraftRows(days: readonly DraftDay[], draft: GridDraft): DraftPlan {
  const start = days.findIndex((day) => day.date === draft.date);
  if (start < 0) return { rows: [], beyondMinutes: 0 };

  const painted = paintedSegments(
    days[start].manualWindows,
    draft.startMinutes,
    draft.durationMinutes,
  );

  const rows: DraftRow[] = painted.segments.map((segment) => ({
    date: draft.date,
    ...segment,
    continuation: false,
  }));

  // An absence's DAY is as literal as its minute, so what the day cannot hold is simply not drawn.
  if (draft.kind === 'gap') return { rows, beyondMinutes: painted.overflow };

  let remaining = painted.overflow;
  for (const day of days.slice(start + 1)) {
    if (remaining <= 0) break;
    if (!takesContinuation(day)) continue;
    if (compareDates(day.date, draft.date) <= 0) continue;

    const first = day.periods[0];
    if (first === undefined) continue;

    // Over the PERIODS and from their first minute: auto-fill never enters a margin, so measuring a
    // later day over its manual window would start it an hour early.
    const next = paintedSegments(day.periods, first.startMinutes, remaining);
    for (const segment of next.segments) {
      rows.push({ date: day.date, ...segment, continuation: true });
    }
    remaining = next.overflow;
  }

  return { rows, beyondMinutes: remaining };
}
