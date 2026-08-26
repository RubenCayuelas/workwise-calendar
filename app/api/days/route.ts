/**
 * GET `?from=YYYY-MM-DD&to=YYYY-MM-DD` -> { today, days: DayMarkView[] }
 *
 * The two marks a day picker cannot deduce: whether the shop is closed that day, with whatever note
 * the owner stored on it, and whether the engine still has room to lay work into it. Both bounds are
 * required — a half-open span has no sensible default — and a span past `MAX_DAY_MARK_DAYS` is a 400.
 */

import type { NextRequest } from 'next/server';
import { requireDateParam, route } from '@/src/lib/api';
import { readDays } from '@/src/lib/operations/views';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return route(() => {
    const url = new URL(request.url);
    return readDays(requireDateParam(url, 'from'), requireDateParam(url, 'to'));
  });
}
