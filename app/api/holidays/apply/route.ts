/**
 * POST { answers: [{ date, keep }] } -> HolidayCheckResult
 *
 * The panel's answers to the holidays that have work on them. `keep` padlocks that day's work and
 * closes the day around it; `false` closes it and lets the reflow carry the work forward.
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, route } from '@/src/lib/api';
import { isValidDate } from '@/src/lib/dates';
import { badRequest, ERROR_MESSAGE_KEYS } from '@/src/lib/errors';
import { applyHolidayAnswers } from '@/src/lib/operations/holidays';

export const dynamic = 'force-dynamic';

/** A year of holidays is fourteen days; the cap is a guard against a mistyped payload, not a limit. */
const MAX_ANSWERS = 64;

export async function POST(request: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJsonBody(request);
    const raw = body.answers;
    if (!Array.isArray(raw) || raw.length > MAX_ANSWERS) {
      throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidPayload, { field: 'answers' });
    }

    const answers = raw.map((entry) => {
      const value = entry as { date?: unknown; keep?: unknown };
      if (typeof value.date !== 'string' || !isValidDate(value.date)) {
        throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidDate, { field: 'answers' });
      }
      if (typeof value.keep !== 'boolean') {
        throw badRequest('invalid-field', ERROR_MESSAGE_KEYS.invalidFlag, { field: 'answers' });
      }
      return { date: value.date, keep: value.keep };
    });

    return applyHolidayAnswers(answers);
  });
}
