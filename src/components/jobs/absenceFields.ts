/**
 * Which control of the absences form a refusal lands on. Out of the panel so it can be read without a
 * DOM: the range calendar is ONE control over BOTH payload keys of a span, and `localError` is drawn
 * nowhere but a `Field`'s `error`.
 */

/** The controls the form has, whichever of its three shapes is on screen. */
export type AbsenceField = 'date' | 'endDate' | 'startTime' | 'duration' | 'reason';

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
