/**
 * A painted band as the rows it becomes on the day it was painted on.
 *
 * THE ONE IMPLEMENTATION, imported by the write path (`planCreation`) and by the band the grid keeps
 * drawing while the form is open. Two of them would be exactly the drift every other shared shape in
 * this app exists to prevent.
 */

import { dayEndMinutes, firstWorkingMinute, netMinutesBetween } from './manualWindow';
import { segmentDroppedRow } from './dropSegments';
import { takeableFrom } from './dropSpill';
import type { WorkPeriod } from '../types';

export interface PaintedPlan {
  /** The rows to store, cut at every break. Empty when the release leaves no room. */
  segments: { startMinutes: number; durationMinutes: number }[];
  /** Net working minutes this day takes. */
  taken: number;
  /** What is left for the days after. Zero when the band fits. */
  overflow: number;
}

/**
 * `startMinutes` is read through `firstWorkingMinute`, so a release inside the lunch break means the
 * afternoon and the returned start may differ from the one asked for — every caller reads it back.
 *
 * Measured over the MANUAL WINDOWS: the margins are workable time the owner chose, and a padlocked
 * row may sit in one. The overflow is measured, never clamped, because hours past the end of the day
 * are hours the next day takes — the same reading *Fill and Overflow, Always* gives the engine.
 */
export function paintedSegments(
  manualWindows: readonly WorkPeriod[],
  startMinutes: number,
  minutes: number,
): PaintedPlan {
  const from = firstWorkingMinute(manualWindows, startMinutes);
  const room = Math.max(0, netMinutesBetween(manualWindows, from, dayEndMinutes(manualWindows)));

  // `lastResort`, because the alternative is refusing a band the owner drew: this is the day they
  // named, so the floor may shorten what stays here but may never make it nothing.
  const taken = takeableFrom(room, minutes, true);
  if (taken <= 0) return { segments: [], taken: 0, overflow: minutes };

  return {
    segments: segmentDroppedRow(manualWindows, { startMinutes: from, durationMinutes: taken }),
    taken,
    overflow: minutes - taken,
  };
}
