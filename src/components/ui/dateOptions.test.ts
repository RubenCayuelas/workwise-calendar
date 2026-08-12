/**
 * The date control's option list.
 *
 * Two properties matter more than the rest, and both are about not losing a day the
 * owner already chose: the stored value is always offered, however far outside the
 * window it falls, and the window is bounded so a two-year horizon cannot turn one
 * dropdown into seven hundred options.
 */

import { describe, expect, it } from 'vitest';
import { MAX_HORIZON_WEEKS } from '../../lib/settings';
import { addDays, isoWeekNumber, startOfWeek, weekdayOf } from '../../lib/dates';
import {
  PICKER_FUTURE_WEEKS,
  PICKER_MAX_FUTURE_WEEKS,
  PICKER_PAST_WEEKS,
  dayOptionDates,
  groupDaysByWeek,
  planningWindow,
} from './dateOptions';

// 2026-08-12 is a Wednesday, in ISO week 33.
const TODAY = '2026-08-12';

describe('planningWindow', () => {
  it('spans whole weeks, from the past reach to the end of the horizon', () => {
    const window = planningWindow(TODAY, 8);
    // Monday of the week four weeks before this one, Sunday eight weeks after it.
    expect(window.minDate).toBe('2026-07-13');
    expect(window.maxDate).toBe('2026-10-04');
    expect(weekdayOf(window.minDate)).toBe(1);
    expect(weekdayOf(window.maxDate)).toBe(7);
  });

  it('reaches four weeks back and the horizon forward', () => {
    const window = planningWindow(TODAY, 8);
    const monday = startOfWeek(TODAY);
    expect(window.minDate).toBe(addDays(monday, -7 * PICKER_PAST_WEEKS));
    expect(window.maxDate).toBe(addDays(monday, 7 * 8 - 1));
  });

  it('caps a very long horizon so the list stays scannable', () => {
    const window = planningWindow(TODAY, MAX_HORIZON_WEEKS);
    expect(window.maxDate).toBe(addDays(startOfWeek(TODAY), 7 * PICKER_MAX_FUTURE_WEEKS - 1));
  });

  it('falls back to the default horizon when it is not a number', () => {
    expect(planningWindow(TODAY, Number.NaN)).toEqual(planningWindow(TODAY, PICKER_FUTURE_WEEKS));
  });

  it('never inverts, even with a horizon of zero', () => {
    const window = planningWindow(TODAY, 0);
    expect(window.minDate < window.maxDate).toBe(true);
  });
});

describe('dayOptionDates', () => {
  it('offers every day of the window, both ends included', () => {
    const days = dayOptionDates(TODAY, { minDate: '2026-08-10', maxDate: '2026-08-16' });
    expect(days).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('keeps a stored day that falls before the window, in order', () => {
    const days = dayOptionDates('2026-01-09', { minDate: '2026-08-10', maxDate: '2026-08-16' });
    expect(days[0]).toBe('2026-01-09');
    expect(days).toHaveLength(8);
  });

  it('keeps a stored day that falls after the window', () => {
    const days = dayOptionDates('2027-03-01', { minDate: '2026-08-10', maxDate: '2026-08-16' });
    expect(days[days.length - 1]).toBe('2027-03-01');
  });

  it('ignores a value that is not a date at all', () => {
    const days = dayOptionDates('', { minDate: '2026-08-10', maxDate: '2026-08-11' });
    expect(days).toEqual(['2026-08-10', '2026-08-11']);
  });

  it('yields nothing rather than looping forever on an inverted window', () => {
    expect(dayOptionDates(undefined, { minDate: '2026-08-16', maxDate: '2026-08-10' })).toEqual([]);
  });

  it('stays bounded however wide the window is', () => {
    const days = dayOptionDates(undefined, { minDate: '2020-01-01', maxDate: '2030-01-01' });
    expect(days.length).toBeLessThanOrEqual(400);
  });

  it('offers a workable list for the default window', () => {
    const days = dayOptionDates(TODAY, planningWindow(TODAY, PICKER_FUTURE_WEEKS));
    expect(days).toHaveLength(7 * (PICKER_PAST_WEEKS + PICKER_FUTURE_WEEKS));
  });
});

describe('groupDaysByWeek', () => {
  it('splits the days into calendar weeks, in order', () => {
    const weeks = groupDaysByWeek(dayOptionDates(undefined, { minDate: '2026-08-14', maxDate: '2026-08-18' }));
    expect(weeks).toHaveLength(2);
    expect(weeks[0].dates).toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
    expect(weeks[1].dates).toEqual(['2026-08-17', '2026-08-18']);
  });

  it('labels a partial group with the whole week the header would show', () => {
    const weeks = groupDaysByWeek(['2026-08-14']);
    expect(weeks[0].startDate).toBe('2026-08-10');
    expect(weeks[0].endDate).toBe('2026-08-16');
    expect(weeks[0].isoWeek).toBe(isoWeekNumber('2026-08-14'));
  });

  it('keeps every day it was given', () => {
    const days = dayOptionDates(TODAY, planningWindow(TODAY, 8));
    expect(groupDaysByWeek(days).flatMap((week) => week.dates)).toEqual(days);
  });

  it('has nothing to group when there are no days', () => {
    expect(groupDaysByWeek([])).toEqual([]);
  });
});
