/**
 * What span the absences form sends, and which control a refusal lands on, now that the range is ONE
 * calendar. The span because a far end left behind by a day that moved is how one absence became
 * three; the control because both refusals a span can earn name the far end, and `localError` is
 * drawn nowhere but a `Field`'s `error`: an end that maps onto no field leaves `Guardar` refusing in
 * silence.
 */

import { describe, expect, it } from 'vitest';
import {
  API_FIELD,
  RANGE_FIELDS,
  absenceSpan,
  rangeError,
  type AbsenceField,
} from './absenceFields';
import { summarizeAbsence } from './absence';
import { rangeCells } from '../ui/dayRange';
import { absenceRange } from '../../lib/absences';
import type { AbsencePreview } from '../../lib/api-client';
import { FRI, MON, SAT, SUN, THU, TUE, WED } from '../../testing/fixtures';

function preview(overrides: Partial<AbsencePreview> = {}): AbsencePreview {
  return {
    today: MON,
    kind: 'closed-days',
    dates: [MON],
    skippedDates: [],
    rows: [],
    alreadyClosedDates: [],
    daysWithWork: [],
    displaced: [],
    lastOccupiedBefore: null,
    lastOccupiedAfter: null,
    ...overrides,
  };
}

const onlyOn =
  (field: AbsenceField, message: string) =>
  (asked: AbsenceField): string | undefined =>
    asked === field ? message : undefined;

describe('the span the absences form sends', () => {
  it('names both ends of a range the calendar chose', () => {
    expect(absenceSpan(true, MON, FRI)).toEqual({ from: MON, to: FRI });
  });

  it('names the same day twice in the shapes that draw one day', () => {
    expect(absenceSpan(false, WED, WED)).toEqual({ from: WED, to: WED });
  });

  it('keeps one absence on one day when its day moved BACK behind a stale far end', () => {
    // Both writers of the single day reach this state: the calendar moved the day forward, which
    // recorded a week to come back to, and then «Volver a…» moved it back on its own. Sent as
    // `to: endDate` it wrote WED, THU and FRI for a band drawn on WED alone.
    expect(absenceSpan(false, WED, FRI)).toEqual({ from: WED, to: WED });
  });

  it('never reaches past the day it is given, whichever way the ends sit', () => {
    expect(absenceSpan(false, FRI, MON)).toEqual({ from: FRI, to: FRI });
  });
});

describe('the field a refusal of the absences form lands on', () => {
  it('sends both payload keys of a span to the one control that draws it', () => {
    expect(API_FIELD.from).toBe('date');
    expect(API_FIELD.to).toBe('endDate');
    expect(RANGE_FIELDS).toEqual(['date', 'endDate']);
    expect(RANGE_FIELDS).toContain(API_FIELD.from);
    expect(RANGE_FIELDS).toContain(API_FIELD.to);
  });

  it('shows a range refused backwards, which names the far end', () => {
    expect(rangeError(onlyOn('endDate', 'range backwards'))).toBe('range backwards');
  });

  it('shows a range refused for its length, which the server also names on the far end', () => {
    expect(rangeError(onlyOn('endDate', 'invalid range'))).toBe('invalid range');
  });

  it('shows a refusal of the near end too', () => {
    expect(rangeError(onlyOn('date', 'not a date'))).toBe('not a date');
  });

  it('names the near end first when both were refused', () => {
    expect(rangeError((field) => (field === 'date' ? 'near' : 'far'))).toBe('near');
  });

  it('stays quiet about the controls it does not answer for', () => {
    expect(rangeError(onlyOn('startTime', 'not a time'))).toBeUndefined();
    expect(rangeError(() => undefined)).toBeUndefined();
  });
});

describe('what the line under the range field counts', () => {
  it('counts the days the span WRITES, not the cells the calendar paints', () => {
    const span = rangeCells(MON, SUN);
    const server = absenceRange(MON, SUN);

    expect(span.included).toEqual([MON, TUE, WED, THU, FRI]);
    expect(span.skipped).toEqual([SAT, SUN]);
    // The cells drawn excluded are exactly the days the count leaves out: seven painted, five written.
    expect(span.included).toEqual(server.dates);
    expect(span.skipped).toEqual(server.skipped);

    const summary = summarizeAbsence(
      preview({ dates: span.included, skippedDates: span.skipped }),
    );
    expect(summary.dayCount).toBe(5);
    expect(summary.dayCount).toBe(span.included.length);
  });

  it('excludes no cell when the whole span is the weekend the owner named', () => {
    const span = rangeCells(SAT, SUN);

    expect(span.included).toEqual([SAT, SUN]);
    expect(span.skipped).toEqual([]);
    expect(summarizeAbsence(preview({ dates: span.included })).dayCount).toBe(2);
  });
});
