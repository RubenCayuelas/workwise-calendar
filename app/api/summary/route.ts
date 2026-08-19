/**
 * GET -> { today, summary: { lastOccupiedDate, queuedMinutes, bufferDate, bufferClear } }
 *
 * - `lastOccupiedDate` looks across ALL weeks, not the week on screen; null means clear from
 *   today onwards.
 * - `queuedMinutes` counts today onwards: hours already worked are not queued.
 * - `bufferDate` is the next Friday still ahead (on a Saturday, next week's).
 *
 * Minutes, not hours — the UI formats them. Embedded in `GET /api/week` too, so a page load
 * does not need both.
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
