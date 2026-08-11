/**
 * `/api/summary` — the amber strip above the grid.
 *
 * GET -> { today, summary: { lastOccupiedDate, queuedMinutes, bufferDate, bufferClear } }
 *
 * "Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre" is
 * the stated objective of the whole app, so it gets its own endpoint and
 * `composition.ts` owns the arithmetic — this route does no counting of its own.
 *
 * - `lastOccupiedDate` looks across ALL weeks, not the week on screen. `null` means a
 *   clear calendar from today onwards.
 * - `queuedMinutes` counts today onwards: hours already worked are not queued.
 * - `bufferDate` is the next Friday still ahead (on a Saturday, next week's), and
 *   `bufferClear` says whether the colchón is still available.
 *
 * Minutes, not hours: the UI formats them. The same object is embedded in
 * `GET /api/week`, so a page load does not need both.
 */

import { route } from '@/src/lib/api';
import { todayLocal } from '@/src/lib/dates';
import { readSummary } from '@/src/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route(() => {
    const today = todayLocal();
    return { today, summary: readSummary(undefined, today) };
  });
}
