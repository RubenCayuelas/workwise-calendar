/**
 * The absence preview as sentences to print: every decision about what a bulk save is going to cost
 * is made here, so the panel only spells it and the choice of wording is testable without a browser.
 * Nothing here re-implements a scheduling decision — the server ran the real write and rolled it back.
 */

import { compareDates } from '../../lib/dates';
import type { AbsencePreview, AbsencePreviewRow, DisplacedWork } from '../../lib/api-client';
import type { BannerTone } from '../ui';

/** Which gesture opened the absences form. It decides the SHAPE, never the contents. */
export type AbsenceOrigin = 'header' | 'closed-column' | 'paint' | 'gap' | 'close-day';

/**
 * `range` is the whole screen — the two mode cards, `Desde`/`Hasta`, the server preview — and it is
 * for the two gestures that name no day of their own. Everything else already named ONE day, so a
 * range there asks a question the gesture has answered: a painted band opened the range screen
 * pre-filled on a single day until 2026-08-21.
 */
export function absenceFormMode(origin: AbsenceOrigin): 'range' | 'single' {
  return origin === 'header' || origin === 'closed-column' ? 'range' : 'single';
}

/** One line under the row list. A KIND, so the panel's switch is the only place a string is chosen. */
export type AbsenceNote =
  | 'closesDays'
  | 'alreadyClosed'
  | 'alreadyClosedGap'
  | 'repeatsDaily'
  | 'cutAtBreak'
  | 'skippedWeekend'
  | 'movesNothing'
  | 'reachesFurther';

export interface AbsenceSummary {
  tone: BannerTone;
  /** How many days the range writes to. */
  dayCount: number;
  /** The rows ONE day holds — every day of a gap range gets the same ones. */
  rowsPerDay: AbsencePreviewRow[];
  skipped: string[];
  alreadyClosed: string[];
  displaced: DisplacedWork[];
  /** Total minutes the save pushes forward, over every job. */
  displacedMinutes: number;
  /** The furthest day the calendar reaches afterwards, when the save moved it. */
  reachesUntil: string | null;
  notes: AbsenceNote[];
}

export function summarizeAbsence(preview: AbsencePreview): AbsenceSummary {
  const firstDate = preview.dates[0];
  const rowsPerDay = preview.rows.filter((row) => row.date === firstDate);
  const displacedMinutes = preview.displaced.reduce((total, job) => total + job.minutes, 0);
  const reachesUntil =
    preview.lastOccupiedAfter !== null &&
    (preview.lastOccupiedBefore === null ||
      compareDates(preview.lastOccupiedAfter, preview.lastOccupiedBefore) > 0)
      ? preview.lastOccupiedAfter
      : null;

  const notes: AbsenceNote[] = [];
  if (preview.kind === 'closed-days') notes.push('closesDays');
  // The SENTENCE differs by mode, so the note does. `alreadyClosed` promises that saving only
  // rewrites the reason and that «Reabrir» undoes it — both true of closing days and neither true of
  // a gap, which is written on the closed day like on any other.
  if (preview.alreadyClosedDates.length > 0) {
    notes.push(preview.kind === 'closed-days' ? 'alreadyClosed' : 'alreadyClosedGap');
  }
  if (preview.kind === 'gap' && preview.dates.length > 1) notes.push('repeatsDaily');
  if (rowsPerDay.length > 1) notes.push('cutAtBreak');
  if (preview.skippedDates.length > 0) notes.push('skippedWeekend');
  if (displacedMinutes === 0) notes.push('movesNothing');
  if (reachesUntil !== null) notes.push('reachesFurther');

  return {
    // The hours moving is the whole reason a bulk save is previewed, so it earns the warning
    // colour; a range that displaces nothing is a plain confirmation.
    tone: displacedMinutes > 0 ? 'warning' : 'info',
    dayCount: preview.dates.length,
    rowsPerDay,
    skipped: preview.skippedDates,
    alreadyClosed: preview.alreadyClosedDates,
    displaced: preview.displaced,
    displacedMinutes,
    reachesUntil,
    notes,
  };
}
