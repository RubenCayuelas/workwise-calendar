/**
 * `/api/week?date=YYYY-MM-DD` — everything the week view needs, in one call.
 *
 * GET -> {
 *   today,
 *   week:     { startDate, endDate, dates[7], isoWeek, isoWeekYear },
 *   settings, shape,
 *   days:     WeekDay[7],
 *   blocks:   (Block & { project: { id, name, color } })[],
 *   gaps:     Gap[],
 *   summary:  ScheduleSummary
 * }
 *
 * `date` may be any day of the week wanted; it is snapped to that week's Monday.
 * Omitted, it means the current week. `dates` always holds all seven days, because
 * the grid renders Sat/Sun narrow rather than hiding them.
 *
 * One call rather than four on purpose: a recomposition rewrites many rows at once,
 * so separate fetches could draw blocks against a day whose capacity had already
 * changed. Every field here comes from one snapshot.
 *
 * What `days[]` gives the header of each column, as flags to be worded from
 * public/locales — never as text: `role` ("auto" Mon-Thu, "buffer" Friday's colchón,
 * "manual" the weekend), `isToday`, `isPast` (frozen: the engine will not write
 * there, though the owner still may), `isClosed`, and `plannableMinutes`, the hours
 * auto-fill could still put there.
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
