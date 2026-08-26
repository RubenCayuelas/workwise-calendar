/**
 * What span the absences form sends, and which of its controls a refusal lands on. Out of the panel so
 * both can be read without a DOM: the range calendar is ONE control over BOTH payload keys of a span,
 * and `localError` is drawn nowhere but a `Field`'s `error`.
 */

/** The controls the form has, whichever of its three shapes is on screen. */
export type AbsenceField = 'date' | 'endDate' | 'startTime' | 'duration' | 'reason';

/**
 * The days a request covers, for every shape of the form. **ONE ABSENCE IS ONE DAY**: only the range
 * mode draws a far end, so every other shape answers with the near one twice and `endDate` cannot
 * reach the wire from a screen that never showed it.
 *
 * Asked here rather than at each request: a screen that passed `endDate` straight through wrote a gap
 * on every weekday between a stale far end and a day that had since moved BACK, and displaced work
 * with it. Both writers of the single day — the calendar and the off-week banner's way back — are
 * harmless because of this, not because each remembers.
 */
export function absenceSpan(
  bulk: boolean,
  date: string,
  endDate: string,
): { from: string; to: string } {
  return { from: date, to: bulk ? endDate : date };
}

/** The payload keys the API validates, mapped onto this form's controls. */
export const API_FIELD: Record<string, AbsenceField | undefined> = {
  date: 'date',
  from: 'date',
  to: 'endDate',
  startTime: 'startTime',
  startMinutes: 'startTime',
  durationHours: 'duration',
  durationMinutes: 'duration',
  reason: 'reason',
};

/**
 * The ends the range calendar answers for, in the order it shows them. `errors.rangeBackwards` and the
 * server's 400 `invalid-range` both name the far end, and no other control on the screen draws them.
 */
export const RANGE_FIELDS: readonly AbsenceField[] = ['date', 'endDate'];

/** The message the range calendar shows: whichever of its two ends was refused. */
export function rangeError(
  messageFor: (field: AbsenceField) => string | undefined,
): string | undefined {
  for (const field of RANGE_FIELDS) {
    const message = messageFor(field);
    if (message !== undefined) return message;
  }
  return undefined;
}
