import { describe, expect, it } from 'vitest';
import { MAX_ABSENCE_DAYS, absenceRange } from './absences';

// The week of 10-16 Aug 2026: Mon 10 … Fri 14, Sat 15, Sun 16.

describe('the days a range of absence covers', () => {
  it('is one day for a range of one', () => {
    expect(absenceRange('2026-08-12', '2026-08-12')).toEqual({
      dates: ['2026-08-12'],
      skipped: [],
    });
  });

  it('covers the owner`s own case: 1 to 4 September is four days', () => {
    expect(absenceRange('2026-09-01', '2026-09-04').dates).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });

  it('skips Saturday and Sunday, and says which days it skipped', () => {
    const range = absenceRange('2026-08-13', '2026-08-17');
    expect(range.dates).toEqual(['2026-08-13', '2026-08-14', '2026-08-17']);
    expect(range.skipped).toEqual(['2026-08-15', '2026-08-16']);
  });

  it('keeps the weekend when the whole range is inside one', () => {
    expect(absenceRange('2026-08-15', '2026-08-16')).toEqual({
      dates: ['2026-08-15', '2026-08-16'],
      skipped: [],
    });
    expect(absenceRange('2026-08-16', '2026-08-16').dates).toEqual(['2026-08-16']);
  });

  it('is empty when the range runs backwards', () => {
    expect(absenceRange('2026-08-14', '2026-08-10')).toEqual({ dates: [], skipped: [] });
  });

  it('never walks further than the cap, whatever it is asked for', () => {
    expect(absenceRange('2026-01-01', '2030-01-01').dates.length).toBeLessThanOrEqual(
      MAX_ABSENCE_DAYS,
    );
  });
});
