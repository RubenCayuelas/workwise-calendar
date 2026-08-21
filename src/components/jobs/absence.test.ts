import { describe, expect, it } from 'vitest';
import { absenceFormMode, summarizeAbsence } from './absence';
import type { AbsencePreview } from '../../lib/api-client';

const MON = '2026-08-10';
const TUE = '2026-08-11';
const WED = '2026-08-12';

function preview(overrides: Partial<AbsencePreview> = {}): AbsencePreview {
  return {
    today: MON,
    kind: 'closed-days',
    dates: [MON],
    skippedDates: [],
    rows: [],
    alreadyClosedDates: [],
    displaced: [],
    lastOccupiedBefore: null,
    lastOccupiedAfter: null,
    ...overrides,
  };
}

describe('what a bulk absence is going to cost', () => {
  it('says a range that moves nothing moves nothing, and stays quiet about it', () => {
    const summary = summarizeAbsence(preview({ dates: [MON, TUE] }));

    expect(summary.tone).toBe('info');
    expect(summary.dayCount).toBe(2);
    expect(summary.displacedMinutes).toBe(0);
    expect(summary.notes).toContain('movesNothing');
  });

  it('warns, names the hours and says how much further the calendar now reaches', () => {
    const summary = summarizeAbsence(
      preview({
        dates: [TUE],
        displaced: [{ projectId: 'p1', name: 'Shed', minutes: 600, landsOn: WED }],
        lastOccupiedBefore: TUE,
        lastOccupiedAfter: WED,
      }),
    );

    expect(summary.tone).toBe('warning');
    expect(summary.displacedMinutes).toBe(600);
    expect(summary.reachesUntil).toBe(WED);
    expect(summary.notes).toContain('reachesFurther');
    expect(summary.notes).not.toContain('movesNothing');
  });

  it('reads the rows of ONE day, because every day of the range repeats them', () => {
    const summary = summarizeAbsence(
      preview({
        kind: 'gap',
        dates: [MON, TUE],
        rows: [
          { date: MON, startMinutes: 780, durationMinutes: 60 },
          { date: MON, startMinutes: 930, durationMinutes: 120 },
          { date: TUE, startMinutes: 780, durationMinutes: 60 },
          { date: TUE, startMinutes: 930, durationMinutes: 120 },
        ],
      }),
    );

    expect(summary.rowsPerDay).toEqual([
      { date: MON, startMinutes: 780, durationMinutes: 60 },
      { date: MON, startMinutes: 930, durationMinutes: 120 },
    ]);
    expect(summary.notes).toContain('repeatsDaily');
    expect(summary.notes).toContain('cutAtBreak');
  });

  it('names the weekend it skipped and the days already closed', () => {
    const summary = summarizeAbsence(
      preview({
        dates: [MON, TUE],
        skippedDates: ['2026-08-15', '2026-08-16'],
        alreadyClosedDates: [TUE],
      }),
    );

    expect(summary.notes).toContain('skippedWeekend');
    expect(summary.notes).toContain('alreadyClosed');
    expect(summary.alreadyClosed).toEqual([TUE]);
  });

  it('does not claim the calendar reaches further when it does not', () => {
    const summary = summarizeAbsence(
      preview({
        displaced: [{ projectId: 'p1', name: 'Shed', minutes: 120, landsOn: TUE }],
        lastOccupiedBefore: WED,
        lastOccupiedAfter: WED,
      }),
    );

    expect(summary.reachesUntil).toBeNull();
    expect(summary.notes).not.toContain('reachesFurther');
  });
});

describe('which shape of the absences form a gesture opens', () => {
  it('opens the RANGE screen only where a range makes sense', () => {
    // `Absences` from the menu, and pressing a closed column, are the two ways a whole week of
    // absence is asked for.
    expect(absenceFormMode('menu')).toBe('range');
    expect(absenceFormMode('closed-column')).toBe('range');
  });

  it('opens ONE absence for a painted band', () => {
    // A paint is one column by definition, so the Desde/Hasta screen asked a question the gesture
    // had already answered — and offered a range pre-filled on a single day.
    expect(absenceFormMode('paint')).toBe('single');
  });

  it('opens ONE absence for the two gestures that already name their day', () => {
    expect(absenceFormMode('gap')).toBe('single');
    expect(absenceFormMode('close-day')).toBe('single');
  });
});
