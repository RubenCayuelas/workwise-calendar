/**
 * Where the day picker opens, and how far its two arrows reach.
 *
 * The window is an affordance and the stored day is the datum: a day saved outside the window
 * opens on its own month, and from there one press reaches the window instead of walking the
 * months in between, which offer nothing to choose.
 */

import { describe, expect, it } from 'vitest';
import { planningWindow, type DayWindow } from './dateOptions';
import { monthReach, openingMonth, stepMonth } from './monthReach';
import { WED } from '../../testing/fixtures';

// 2026-07-13 to 2026-10-04, so the reachable months are July to October 2026.
const WINDOW: DayWindow = planningWindow(WED, 8);

const JULY = '2026-07-01';
const AUGUST = '2026-08-01';
const SEPTEMBER = '2026-09-01';
const OCTOBER = '2026-10-01';

describe('openingMonth', () => {
  it('opens on the month of the day already chosen', () => {
    expect(openingMonth(WED, { today: WED, window: WINDOW })).toBe(AUGUST);
    expect(openingMonth('2026-09-30', { today: WED, window: WINDOW })).toBe(SEPTEMBER);
  });

  it('opens on the month of a stored day the window does not reach', () => {
    expect(openingMonth('2026-01-09', { today: WED, window: WINDOW })).toBe('2026-01-01');
    expect(openingMonth('2027-03-01', { today: WED, window: WINDOW })).toBe('2027-03-01');
  });

  it('falls back to the month of today when there is no day yet', () => {
    expect(openingMonth('', { today: WED, window: WINDOW })).toBe(AUGUST);
    expect(openingMonth('not a date', { today: WED, window: WINDOW })).toBe(AUGUST);
  });

  it('never falls back onto a month the window does not reach', () => {
    expect(openingMonth('', { today: '2026-01-05', window: WINDOW })).toBe(JULY);
    expect(openingMonth('', { today: '2027-05-05', window: WINDOW })).toBe(OCTOBER);
  });
});

describe('monthReach', () => {
  it('moves both ways inside the window', () => {
    expect(monthReach(AUGUST, WINDOW)).toEqual({ canPrevious: true, canNext: true });
    expect(monthReach(SEPTEMBER, WINDOW)).toEqual({ canPrevious: true, canNext: true });
  });

  it('turns an arrow off exactly at the month holding the window end', () => {
    expect(monthReach(JULY, WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach(OCTOBER, WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('reads the month from any day of it', () => {
    expect(monthReach('2026-07-31', WINDOW)).toEqual(monthReach(JULY, WINDOW));
    expect(monthReach(WINDOW.minDate, WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach(WINDOW.maxDate, WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('turns both arrows off when the whole window sits in one month', () => {
    expect(monthReach(AUGUST, { minDate: '2026-08-12', maxDate: '2026-08-14' })).toEqual({
      canPrevious: false,
      canNext: false,
    });
  });

  it('points back into the window from a month outside it', () => {
    expect(monthReach('2026-01-01', WINDOW)).toEqual({ canPrevious: false, canNext: true });
    expect(monthReach('2027-03-01', WINDOW)).toEqual({ canPrevious: true, canNext: false });
  });

  it('moves nowhere when the window is not a range', () => {
    expect(monthReach(AUGUST, { minDate: '', maxDate: '' })).toEqual({
      canPrevious: false,
      canNext: false,
    });
  });
});

describe('stepMonth', () => {
  it('moves one month, either way', () => {
    expect(stepMonth(AUGUST, 1, WINDOW)).toBe(SEPTEMBER);
    expect(stepMonth(AUGUST, -1, WINDOW)).toBe(JULY);
  });

  it('returns the same month when the arrow is off', () => {
    expect(stepMonth(JULY, -1, WINDOW)).toBe(JULY);
    expect(stepMonth(OCTOBER, 1, WINDOW)).toBe(OCTOBER);
    expect(stepMonth('2026-07-20', -1, WINDOW)).toBe(JULY);
  });

  it('never leaves the window, however many times it is pressed', () => {
    let month = openingMonth('', { today: WED, window: WINDOW });
    for (let press = 0; press < 12; press += 1) month = stepMonth(month, 1, WINDOW);
    expect(month).toBe(OCTOBER);
    for (let press = 0; press < 12; press += 1) month = stepMonth(month, -1, WINDOW);
    expect(month).toBe(JULY);
  });

  it('reaches the window in one press from the month a stored day opened on', () => {
    expect(stepMonth('2026-01-01', 1, WINDOW)).toBe(JULY);
    expect(stepMonth('2027-03-01', -1, WINDOW)).toBe(OCTOBER);
    // And that month's other arrow, which reports off, still moves nothing.
    expect(stepMonth('2026-01-01', -1, WINDOW)).toBe('2026-01-01');
  });

  it('crosses a year end', () => {
    const yearEnd: DayWindow = { minDate: '2026-11-15', maxDate: '2027-02-10' };
    expect(stepMonth('2026-12-01', 1, yearEnd)).toBe('2027-01-01');
    expect(stepMonth('2027-01-01', -1, yearEnd)).toBe('2026-12-01');
    expect(stepMonth('2027-02-01', 1, yearEnd)).toBe('2027-02-01');
  });
});
