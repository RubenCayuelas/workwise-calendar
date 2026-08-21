/**
 * The band that stays drawn while the form is open. It is a SHAPE, not a promise: agnostic to what
 * is underneath, drawn over it, and the painted day's own rows come from the same `paintedSegments`
 * the save uses, so those two can never disagree.
 */

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t, minutesToHHmm } from '../../lib/dates';
import { manualWindowsOf } from '../../lib/manualWindow';
import { paintedSegments } from '../../lib/paintedJob';
import { planDraftRows, type DraftDay } from './draftBand';

const PERIODS = [
  { startMinutes: t('08:00'), endMinutes: t('14:00') },
  { startMinutes: t('15:30'), endMinutes: t('19:30') },
];
const WINDOWS = manualWindowsOf(PERIODS, 60, 60);

function day(date: string, extra: Partial<DraftDay> = {}): DraftDay {
  return {
    date,
    periods: PERIODS,
    manualWindows: WINDOWS,
    isWeekend: false,
    isClosed: false,
    isPast: false,
    role: 'auto',
    ...extra,
  };
}

/** Mon 24 to Sun 30 August 2026, the shape the week view hands over. */
const WEEK: DraftDay[] = [
  day('2026-08-24'),
  day('2026-08-25'),
  day('2026-08-26'),
  day('2026-08-27'),
  day('2026-08-28', { role: 'buffer' }),
  day('2026-08-29', { isWeekend: true, role: 'manual' }),
  day('2026-08-30', { isWeekend: true, role: 'manual' }),
];

function shown(rows: ReturnType<typeof planDraftRows>['rows']): string[] {
  return rows.map(
    (row) =>
      `${row.date} ${minutesToHHmm(row.startMinutes)}-${minutesToHHmm(row.startMinutes + row.durationMinutes)}`,
  );
}

describe('the draft band while the form is open', () => {
  it('is one rectangle when the hours fit where they were painted', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-25',
      startMinutes: t('10:00'),
      durationMinutes: 2 * 60,
    });

    expect(shown(plan.rows)).toEqual(['2026-08-25 10:00-12:00']);
    expect(plan.beyondMinutes).toBe(0);
  });

  it('draws the painted day EXACTLY as the save will store it', () => {
    // The one half that is a promise. Two implementations of this is the drift everything else in
    // this app is arranged to prevent.
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-25',
      startMinutes: t('13:00'),
      durationMinutes: 3 * 60,
    });
    const saved = paintedSegments(WINDOWS, t('13:00'), 3 * 60).segments;

    expect(plan.rows.filter((row) => row.date === '2026-08-25')).toEqual(
      saved.map((row) => ({ date: '2026-08-25', ...row, continuation: false })),
    );
  });

  it('carries on across the following days when the hours do not fit', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-26',
      startMinutes: t('17:00'),
      durationMinutes: 8 * 60,
    });

    // 17:00 to 20:30 is 3.5 h on the painted day; the remaining 4.5 h fit in Thursday's morning.
    expect(shown(plan.rows)).toEqual(['2026-08-26 17:00-20:30', '2026-08-27 08:00-12:30']);
    expect(plan.beyondMinutes).toBe(0);
  });

  it('SKIPS the weekend, closed days and the Friday buffer', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-27',
      startMinutes: t('19:00'),
      durationMinutes: 12 * 60,
    });
    const dates = [...new Set(plan.rows.map((row) => row.date))];

    // Thursday's tail, then straight past Friday's buffer and the weekend.
    expect(dates).toEqual(['2026-08-27']);
    expect(plan.beyondMinutes).toBe(12 * 60 - 90);
  });

  it('measures a continuation day over the PERIODS, never into its margin', () => {
    // Auto-fill does not enter a margin, so drawing a later day from 07:00 would start it an hour
    // early and promise a shape the engine would never produce.
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-24',
      startMinutes: t('19:00'),
      durationMinutes: 5 * 60,
    });

    expect(shown(plan.rows)[1]).toBe('2026-08-25 08:00-11:30');
  });

  it('names the hours it cannot draw at all', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-27',
      startMinutes: t('08:00'),
      durationMinutes: 40 * 60,
    });

    expect(plan.beyondMinutes).toBeGreaterThan(0);
    expect(
      plan.rows.reduce((total, row) => total + row.durationMinutes, 0) + plan.beyondMinutes,
    ).toBe(40 * 60);
  });

  it('marks which rectangles are a continuation, so the drawing can say so', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-08-26',
      startMinutes: t('19:00'),
      durationMinutes: 4 * 60,
    });

    expect(plan.rows.map((row) => row.continuation)).toEqual([false, true]);
  });

  it('a GAP is ONE day and is never carried to another', () => {
    // An absence's day is as literal as its minute: the owner named the day the machine broke.
    const plan = planDraftRows(WEEK, {
      kind: 'gap',
      date: '2026-08-26',
      startMinutes: t('19:00'),
      durationMinutes: 6 * 60,
    });

    expect([...new Set(plan.rows.map((row) => row.date))]).toEqual(['2026-08-26']);
    expect(plan.beyondMinutes).toBe(6 * 60 - 90);
  });

  it('draws nothing for a day that is not on screen', () => {
    const plan = planDraftRows(WEEK, {
      kind: 'job',
      date: '2026-09-15',
      startMinutes: t('10:00'),
      durationMinutes: 2 * 60,
    });

    expect(plan.rows).toEqual([]);
  });
});
