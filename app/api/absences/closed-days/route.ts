/**
 * DELETE ?from=YYYY-MM-DD&to=YYYY-MM-DD -> { dates, summary }
 *
 * Reopens every closed day in the range — `to` absent means one day — and recomposes, so the queue
 * fills them again. Closing is `POST /api/absences` with `kind: "closed-days"`.
 */

import type { NextRequest } from 'next/server';
import { readDateParam, requireDateParam, route } from '@/src/lib/api';
import { reopenDays } from '@/src/lib/operations/absences';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest): Promise<Response> {
  return route(() => {
    const url = new URL(request.url);
    return reopenDays({
      from: requireDateParam(url, 'from'),
      to: readDateParam(url, 'to'),
    });
  });
}
