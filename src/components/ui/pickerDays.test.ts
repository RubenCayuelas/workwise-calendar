/**
 * The two marks only the server knows, and the span it is asked for.
 *
 * The span is what can break the picker outright rather than dim it: the route answers nothing at
 * all past `MAX_DAY_MARK_DAYS`, so a stored value months outside the window must not widen the ask.
 */

import { describe, expect, it } from 'vitest';
import { MAX_DAY_MARK_DAYS } from '../../lib/operations/views';
import { MAX_HORIZON_WEEKS } from '../../lib/settings';
import { addDays, daysBetween } from '../../lib/dates';
import { NEXT_MON, SAT, WED } from '../../testing/fixtures';
import { planningWindow } from './dateOptions';
import { markOf, markRange, type DayMarks } from './pickerDays';

const MARKS: DayMarks = {
  [WED]: { isClosed: false, hasRoom: true, freeMinutes: 240 },
  [SAT]: { isClosed: true, note: 'Fair', hasRoom: false, freeMinutes: 0 },
};

describe('markOf', () => {
  it('answers with the day the route sent', () => {
    expect(markOf(WED, MARKS)).toEqual({ isClosed: false, hasRoom: true, freeMinutes: 240 });
    expect(markOf(SAT, MARKS)?.note).toBe('Fair');
  });

  it('answers nothing for a day outside the span that was asked for', () => {
    expect(markOf(NEXT_MON, MARKS)).toBeUndefined();
  });

  it('answers nothing before the marks have arrived', () => {
    expect(markOf(WED, undefined)).toBeUndefined();
  });
});

describe('markRange', () => {
  it('asks for the window when the stored value sits well inside it', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, WED)).toEqual({ from: '2026-07-13', to: '2026-10-04' });
  });

  it('asks for the window when there is no stored value at all', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window)).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it('widens to the whole month at the end the stored value shares', () => {
    const window = planningWindow(WED, 8);
    // The window opens mid-July and closes on 4 October, so both edge months have days it
    // does not offer — and a value stored on one of them opens the popover there.
    expect(markRange(window, '2026-07-06')).toEqual({ from: '2026-07-01', to: '2026-10-04' });
    expect(markRange(window, '2026-10-20')).toEqual({ from: '2026-07-13', to: '2026-10-31' });
  });

  it('leaves a value months away out of the ask rather than one the route refuses', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, '2028-03-05')).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it("does not take July 2027 for the window's own July", () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, addDays(window.minDate, 365))).toEqual({
      from: window.minDate,
      to: window.maxDate,
    });
  });

  it('ignores a value that is not a date at all', () => {
    const window = planningWindow(WED, 8);
    expect(markRange(window, '')).toEqual({ from: window.minDate, to: window.maxDate });
  });

  it('never asks for a span the route refuses, wherever the window falls', () => {
    // A year of "today", the widest window `planningWindow` can produce — four weeks back and the
    // sixteen-week cap — and a stored value at each end of it, the only two that widen the ask.
    for (let offset = 0; offset < 371; offset += 1) {
      const window = planningWindow(addDays(WED, offset), MAX_HORIZON_WEEKS);
      const stored: (string | undefined)[] = [
        undefined,
        window.minDate,
        window.maxDate,
        addDays(window.minDate, -1),
        addDays(window.maxDate, 1),
      ];
      for (const current of stored) {
        const range = markRange(window, current);
        expect(daysBetween(range.from, range.to) + 1).toBeLessThanOrEqual(MAX_DAY_MARK_DAYS);
      }
    }
  });
});
