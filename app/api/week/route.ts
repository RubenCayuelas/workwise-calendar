/**
 * GET `?date=YYYY-MM-DD` -> {
 *   today,
 *   week:     { startDate, endDate, dates[7], isoWeek, isoWeekYear },
 *   settings, shape,
 *   days:     WeekDay[7],
 *   blocks:   (Block & { project: { id, name, color } })[],
 *   gaps:     Gap[],
 *   summary:  ScheduleSummary
 * }
 *
 * `date` may be any day of the week wanted — it is snapped to that week's Monday; omitted it
 * means the current week. Every field comes from ONE snapshot, which is why this is a single
 * call: a recomposition rewrites many rows at once, so separate fetches could draw blocks
 * against a day whose capacity had already changed.
 */

import type { NextRequest } from 'next/server';
import { readDateParam, route } from '@/src/lib/api';
import { readWeek } from '@/src/lib/operations/views';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return route(() => {
    const url = new URL(request.url);
    return readWeek(readDateParam(url, 'date'));
  });
}
