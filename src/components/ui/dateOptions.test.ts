/**
 * How far a date control reaches. The window is bounded on purpose: it is the set of days the app
 * can actually honour, so the forward reach is capped and the past reach is a month.
 */

import { describe, expect, it } from 'vitest';
import { MAX_HORIZON_WEEKS } from '../../lib/settings';
import { addDays, startOfWeek, weekdayOf } from '../../lib/dates';
import * as dateOptions from './dateOptions';
import {
  PICKER_FUTURE_WEEKS,
  PICKER_MAX_FUTURE_WEEKS,
  PICKER_PAST_WEEKS,
  planningWindow,
} from './dateOptions';
import { WED } from '../../testing/fixtures';

// A Wednesday, so the window's own edges are a Monday and a Sunday either side of it.
const TODAY = WED;

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

  it('bounds the month picker forward reach to its maximum', () => {
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

describe('what a date control still needs', () => {
  it('offers a window and nothing else: the option list died with the dropdown', () => {
    expect(Object.keys(dateOptions).sort()).toEqual([
      'PICKER_FUTURE_WEEKS',
      'PICKER_MAX_FUTURE_WEEKS',
      'PICKER_PAST_WEEKS',
      'planningWindow',
    ]);
  });
});
